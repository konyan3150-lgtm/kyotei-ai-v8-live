// Production update loop: GitHub's cron often starts this workflow hours late or skips it,
// so one started run repeats the update cycle every 3 minutes for up to 5.5 hours during racing hours.
// Bounded: no self-dispatch of this workflow, a fixed run limit, and it stops after repeated failures.
import {spawn} from 'node:child_process';
import path from 'node:path';

export const LOOP=Object.freeze({
  intervalMs:3*60000,        // time between cycle starts
  cycleTimeoutMs:12*60000,   // one cycle is stopped after this (the former job limit)
  maxRunMs:330*60000,        // no new cycle that could end after 5.5 h (job limit is 350 min)
  startHourJst:7,endHourJst:22,
  maxConsecutiveFailures:5,
  maxImmediateRetries:2      // a rejected push is retried right away (pre-close saves are carried over)
});

export function inRacingHours(ms,{startHourJst=LOOP.startHourJst,endHourJst=LOOP.endHourJst}={}){
  const d=new Date(ms+9*3600000),h=d.getUTCHours()+d.getUTCMinutes()/60;
  return h>=startHourJst&&h<endHourJst;
}

export async function runLoop({now=()=>Date.now(),sleep,runCycle,dispatchPages,journalPending=async()=>false,log=console.log,limits=LOOP}){
  const start=now();let cycles=0,succeeded=0,failures=0,streak=0,pushed=0,reason=null,immediate=0;
  while(true){
    const t=now();
    if(cycles>0){
      // The first cycle always runs (manual or push-triggered runs keep the old behaviour).
      if(!inRacingHours(t,limits)){reason='outside_racing_hours';break;}
      if(t-start+limits.cycleTimeoutMs>limits.maxRunMs){reason='run_time_limit';break;}
    }
    cycles++;
    let result;
    try{result=await runCycle({timeoutMs:limits.cycleTimeoutMs,cycle:cycles});}
    catch(e){result={ok:false,error:String(e?.message||e)};}
    if(result?.ok){
      succeeded++;streak=0;
      if(result.pushed){pushed++;try{await dispatchPages();}catch(e){log(`::warning::Pages dispatch failed: ${e?.message||e}`);}}
    }else{
      failures++;streak++;log(`::warning::update cycle ${cycles} failed: ${result?.error||'unknown error'}`);
      if(streak>=limits.maxConsecutiveFailures){reason='too_many_consecutive_failures';break;}
    }
    // Control code or dependencies changed on main: stop so the pending run restarts with them.
    if(result?.stop){reason=result.stop;break;}
    if(!result?.ok&&result?.retryNow&&immediate<limits.maxImmediateRetries){immediate++;continue;}
    immediate=0;
    const wait=t+limits.intervalMs-now();
    if(wait>0)await sleep(wait);
  }
  // Never end quietly with journaled pre-close purchases that origin does not hold yet: one more cycle right away
  // (the job limit leaves room for it), and if they are still pending the run fails; the journal is saved for the next run.
  // journalPending() returns true/false; a failed check (unreadable/invalid journal, command error) throws and is
  // never read as "empty".
  const check=async()=>{try{return await journalPending();}catch(e){log(`::error::pre-close journal check failed: ${e?.message||e}`);return 'error';}};
  let journalLeft=false,state=await check();
  if(state!==false){
    cycles++;
    let result;try{result=await runCycle({timeoutMs:limits.cycleTimeoutMs,cycle:cycles,flush:true});}catch(e){result={ok:false,error:String(e?.message||e)};}
    if(result?.ok){succeeded++;if(result.pushed){pushed++;try{await dispatchPages();}catch(e){log(`::warning::Pages dispatch failed: ${e?.message||e}`);}}}else failures++;
    state=await check();journalLeft=state!==false;
    if(journalLeft)log(state==='error'?'::error::pre-close journal could not be checked; the run fails and the journal is kept':'::error::pre-close purchases are still pending in the journal; it is kept for the next run');
  }
  const summary={cycles,succeeded,failures,pushed,reason,journal_pending:journalLeft,elapsed_ms:now()-start};
  log(JSON.stringify({update_loop:summary}));
  return {...summary,ok:succeeded>0&&reason!=='too_many_consecutive_failures'&&!journalLeft};
}

const groupAlive=pgid=>{try{process.kill(-pgid,0);return true;}catch(e){return e.code==='EPERM';}};
async function stopGroup(pgid,graceMs){
  try{process.kill(-pgid,'SIGTERM');}catch{}
  for(const deadline=Date.now()+graceMs;groupAlive(pgid)&&Date.now()<deadline;)await new Promise(r=>setTimeout(r,50));
  if(groupAlive(pgid)){try{process.kill(-pgid,'SIGKILL');}catch{}}
  while(groupAlive(pgid))await new Promise(r=>setTimeout(r,50));
}
// Runs a command in its own process group. Returns only after every process of that group has exited,
// so a timed-out cycle (or a leftover background child) can never write while the next cycle runs.
export function runCommand(cmd,args,{timeoutMs,env,graceMs=10000}={}){
  return new Promise(resolve=>{
    const child=spawn(cmd,args,{stdio:'inherit',detached:true,env:{...process.env,...env}});
    let timedOut=false,exited=null;const pgid=child.pid;
    const finish=async res=>{if(timer)clearTimeout(timer);if(pgid)await stopGroup(pgid,graceMs);resolve(res);};
    const timer=timeoutMs?setTimeout(()=>{timedOut=true;if(!exited)stopGroup(pgid,graceMs);},timeoutMs):null;
    child.on('exit',code=>{exited=true;finish({code,timedOut});});
    child.on('error',e=>{exited=true;finish({code:-1,error:String(e),timedOut});});
  });
}

if(import.meta.url===`file://${process.argv[1]}`){
  const root=path.resolve(import.meta.dirname,'..'),mark=path.join(process.env.RUNNER_TEMP||'/tmp','cycle-pushed');
  const journal=process.env.CYCLE_CARRY_FILE||path.join(process.env.RUNNER_TEMP||'/tmp','v8-journal','preclose-journal.json');
  const fs=await import('node:fs'),crypto=await import('node:crypto');
  // The running loop and the installed dependencies are fixed at start; cycles reset to origin/main, so if these
  // change there, stop and let the next (pending) run start with them.
  const CONTROL=['scripts/update_loop.mjs','.github/workflows/update-live-odds.yml','scripts/odds-composer.json'];
  const controlHash=f=>{try{return crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex');}catch{return null;}};
  const controlAtStart=Object.fromEntries(CONTROL.map(f=>[f,controlHash(f)]));
  // Save the journal to its git branch whenever it changed, so a runner that dies hard does not lose it.
  // (The workflow also saves it at the end, as a required step.)
  let savedJournalHash=null;
  const fileHash=f=>{try{return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}catch{return null;}};
  const checkpointJournal=async()=>{
    const h=fileHash(journal);if(h===null||h===savedJournalHash)return;
    const r=await runCommand('node',[path.join(root,'scripts/journal_store.mjs'),'save',journal],{timeoutMs:120000});
    if(r.code===0&&!r.timedOut)savedJournalHash=h;else console.log(`::error::journal checkpoint failed (exit ${r.code}); retried after the next cycle and at the end`);
  };
  savedJournalHash=fileHash(journal);   // just restored from the branch
  const out=await runLoop({
    sleep:ms=>new Promise(r=>setTimeout(r,ms)),
    runCycle:async({timeoutMs,cycle})=>{
      console.log(`::group::update cycle ${cycle} (${new Date().toISOString()})`);
      try{fs.rmSync(mark,{force:true});}catch{}
      const r=await runCommand('bash',[path.join(root,'scripts/update_cycle.sh')],{timeoutMs,env:{CYCLE_PUSHED_MARK:mark,CYCLE_CARRY_FILE:journal}});
      console.log('::endgroup::');
      await checkpointJournal();
      const changed=CONTROL.find(f=>controlHash(f)!==controlAtStart[f]);
      return {ok:r.code===0&&!r.timedOut,pushed:r.code===0&&fs.existsSync(mark),retryNow:r.code===75&&!r.timedOut,
        stop:changed?`control_code_changed:${changed}`:null,error:r.timedOut?'cycle timed out':r.code===75?'push rejected':r.error||`exit ${r.code}`};
    },
    journalPending:async()=>{
      const r=await runCommand('node',[path.join(root,'scripts/carry_preclose_saves.mjs'),'pending','dev',journal],{timeoutMs:60000});
      if(r.code===0&&!r.timedOut)return true;if(r.code===1&&!r.timedOut)return false;
      throw Error(r.timedOut?'journal check timed out':`journal check exit ${r.code}`);
    },
    dispatchPages:async()=>{const r=await runCommand('gh',['workflow','run','pages.yml','--ref','main'],{timeoutMs:60000});if(r.code!==0)throw Error(`gh exit ${r.code}`);}
  });
  if(!out.ok)process.exit(1);
}
