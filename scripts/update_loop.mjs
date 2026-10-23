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
  // Races closing after 22:00 JST (e.g. Shimonoseki 11R/12R at 22:20/22:45): keep updating until the last close of
  // the day plus a grace period for the official result, and past that only while today's closed races are still
  // unsettled. Never after hardEndHourJst, so a result that is never published cannot keep the run going.
  lateGraceMs:30*60000,hardEndHourJst:23.75,
  // Night deadline: between 22:00 and 24:00 JST all work of the loop (cycle incl. stopping its process group, journal
  // checkpoint, Pages dispatch, journal check, journal flush) ends by hardEndHourJst. Cycle timeouts are cut to the time
  // left; work that does not fit is not started, and pending pre-close purchases stay in the journal (saved by the
  // workflow's always-run save step) and the run fails.
  stopGraceMs:10000,checkpointTimeoutMs:120000,dispatchTimeoutMs:60000,journalCheckTimeoutMs:60000,
  afterCycleMs:10000+(120000+10000)+(60000+10000)+30000,  // cycle group stop + checkpoint + Pages dispatch (each with its stop grace) + margin
  journalCheckMs:60000+10000,
  minCycleMs:2*60000,
  maxConsecutiveFailures:5,
  maxImmediateRetries:2      // a rejected push is retried right away (pre-close saves are carried over)
});

const jstHour=ms=>{const d=new Date(ms+9*3600000);return d.getUTCHours()+d.getUTCMinutes()/60+d.getUTCSeconds()/3600;};
const jstMidnight=ms=>ms-((ms+9*3600000)%86400000);
// The night deadline (ms) for work starting at ms, or null outside 22:00-24:00 JST.
export function nightDeadline(ms,limits=LOOP){
  const {endHourJst=LOOP.endHourJst,hardEndHourJst=LOOP.hardEndHourJst}=limits;
  return jstHour(ms)>=endHourJst?jstMidnight(ms)+hardEndHourJst*3600000:null;
}
export const jstDate=ms=>new Date(ms+9*3600000).toISOString().slice(0,10).replace(/-/g,'');
export function inRacingHours(ms,{startHourJst=LOOP.startHourJst,endHourJst=LOOP.endHourJst}={}){
  const h=jstHour(ms);
  return h>=startHourJst&&h<endHourJst;
}
// day = {date:'YYYYMMDD' (JST), lastCloseMs, unsettled} from the data the last cycle left (null if unknown).
// Returns null while updates should go on, otherwise the stop reason.
export function racingStop(ms,day,limits=LOOP){
  const {startHourJst=LOOP.startHourJst,endHourJst=LOOP.endHourJst,lateGraceMs=LOOP.lateGraceMs,hardEndHourJst=LOOP.hardEndHourJst}=limits;
  if(inRacingHours(ms,{startHourJst,endHourJst}))return null;
  const h=jstHour(ms);
  if(h<endHourJst)return 'outside_racing_hours';                       // before the morning start
  const late=day&&day.date===jstDate(ms)&&Number.isFinite(day.lastCloseMs)&&jstHour(day.lastCloseMs)>=endHourJst&&jstDate(day.lastCloseMs)===day.date;
  if(!late)return 'outside_racing_hours';                              // no race closes after 22:00 (or unknown): as before
  if(h>=hardEndHourJst)return 'night_hard_limit';
  if(ms<day.lastCloseMs+lateGraceMs)return null;                       // late races still to close / result grace
  if(Number(day.unsettled)>0)return null;                              // results published late: keep trying until the hard end
  return 'late_races_finished';
}

export async function runLoop({now=()=>Date.now(),sleep,runCycle,dispatchPages,journalPending=async()=>false,log=console.log,limits=LOOP}){
  const L={...LOOP,...limits};
  // Time a cycle may take now (Infinity outside the night window): leaves room for its follow-up work and one journal check.
  const cycleBudget=t=>{const d=nightDeadline(t,L);return d===null?Infinity:d-t-L.afterCycleMs-L.journalCheckMs;};
  const start=now();let cycles=0,succeeded=0,failures=0,streak=0,pushed=0,reason=null,immediate=0,day=null,late=0;
  while(true){
    const t=now();
    if(cycles>0){
      // The first cycle always runs (manual or push-triggered runs keep the old behaviour).
      const stop=racingStop(t,day,L);
      if(stop){reason=stop;break;}
      if(!inRacingHours(t,L))late++;
      if(t-start+L.cycleTimeoutMs>L.maxRunMs){reason='run_time_limit';break;}
    }
    const budget=cycleBudget(t);
    if(budget<L.minCycleMs){reason='night_hard_limit';break;}
    cycles++;
    let result;
    try{result=await runCycle({timeoutMs:Math.min(L.cycleTimeoutMs,budget),cycle:cycles});}
    catch(e){result={ok:false,error:String(e?.message||e)};}
    if(result&&'day' in result)day=result.day;   // refreshed after every cycle (failed reads give null: no late extension)
    if(result?.ok){
      succeeded++;streak=0;
      if(result.pushed){pushed++;try{await dispatchPages();}catch(e){log(`::warning::Pages dispatch failed: ${e?.message||e}`);}}
    }else{
      failures++;streak++;log(`::warning::update cycle ${cycles} failed: ${result?.error||'unknown error'}`);
      if(streak>=L.maxConsecutiveFailures){reason='too_many_consecutive_failures';break;}
    }
    // Control code or dependencies changed on main: stop so the pending run restarts with them.
    if(result?.stop){reason=result.stop;break;}
    if(!result?.ok&&result?.retryNow&&immediate<L.maxImmediateRetries){immediate++;continue;}
    immediate=0;
    const wait=t+L.intervalMs-now();
    if(wait>0)await sleep(wait);
  }
  // Never end quietly with journaled pre-close purchases that origin does not hold yet: one more cycle right away
  // (the job limit leaves room for it), and if they are still pending the run fails; the journal is saved for the next run.
  // journalPending() returns true/false; a failed check (unreadable/invalid journal, command error) throws and is
  // never read as "empty".
  const check=async()=>{try{return await journalPending();}catch(e){log(`::error::pre-close journal check failed: ${e?.message||e}`);return 'error';}};
  let journalLeft=false,state=null;
  const deadline=nightDeadline(now(),L);
  if(cycles===0&&deadline!==null&&now()+L.journalCheckMs>deadline){
    // Started after the night deadline: nothing ran, the journal is left exactly as restored (and saved back).
    log('::notice::started after the night deadline: no cycle, journal left unchanged for the next run');
  }else{
    state=await check();
    if(state!==false){
      const budget=cycleBudget(now());
      if(budget<L.minCycleMs){
        journalLeft=true;
        log('::error::night deadline: no time for the journal flush cycle; pre-close purchases stay in the journal (saved for the next run) and the run fails');
      }else{
        cycles++;
        let result;try{result=await runCycle({timeoutMs:Math.min(L.cycleTimeoutMs,budget),cycle:cycles,flush:true});}catch(e){result={ok:false,error:String(e?.message||e)};}
        if(result?.ok){succeeded++;if(result.pushed){pushed++;try{await dispatchPages();}catch(e){log(`::warning::Pages dispatch failed: ${e?.message||e}`);}}}else failures++;
        state=await check();journalLeft=state!==false;
        if(journalLeft)log(state==='error'?'::error::pre-close journal could not be checked; the run fails and the journal is kept':'::error::pre-close purchases are still pending in the journal; it is kept for the next run');
      }
    }
  }
  const summary={cycles,succeeded,failures,pushed,reason,late_cycles:late,last_close:day&&Number.isFinite(day.lastCloseMs)?new Date(day.lastCloseMs).toISOString():null,unsettled:day?.unsettled??null,journal_pending:journalLeft,elapsed_ms:now()-start};
  log(JSON.stringify({update_loop:summary}));
  const idleAfterDeadline=cycles===0&&reason==='night_hard_limit';
  return {...summary,ok:(succeeded>0||idleAfterDeadline)&&reason!=='too_many_consecutive_failures'&&!journalLeft};
}

// Today's last close (all races in dev/odds.json) and today's saved records that closed but are not settled yet.
export function dayState(root,nowMs,fs){
  const read=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
  const today=jstDate(nowMs),odds=read('dev/odds.json');
  if(String(odds?.date)!==today)return {date:today,lastCloseMs:null,unsettled:0};
  let lastCloseMs=null;
  for(const venue of Object.values(odds.races||{}))for(const r of Object.values(venue||{})){
    const c=Date.parse(r?.closed_at||'');if(Number.isFinite(c)&&jstDate(c)===today&&(lastCloseMs===null||c>lastCloseMs))lastCloseMs=c;}
  const sp=read('dev/server-predictions.json');let unsettled=0;
  for(const [key,r] of Object.entries(sp?.records||{})){
    if(!r||!key.includes(`_${today}_`)||r.settled||r.cancelled||r.excluded)continue;
    const c=Date.parse(r.closed_at||'');if(Number.isFinite(c)&&c<=nowMs)unsettled++;}
  return {date:today,lastCloseMs,unsettled};
}

export function writeLoopSummary(file,out,fs){
  const keep={reason:out.reason,ok:!!out.ok,journal_pending:!!out.journal_pending,cycles:out.cycles,succeeded:out.succeeded,failures:out.failures,elapsed_ms:out.elapsed_ms,written_at:new Date().toISOString()};
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(keep)+'\n');fs.renameSync(file+'.tmp',file);
  return keep;
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
    const r=await runCommand('node',[path.join(root,'scripts/journal_store.mjs'),'save',journal],{timeoutMs:LOOP.checkpointTimeoutMs,graceMs:LOOP.stopGraceMs});
    if(r.code===0&&!r.timedOut)savedJournalHash=h;else console.log(`::error::journal checkpoint failed (exit ${r.code}); retried after the next cycle and at the end`);
  };
  savedJournalHash=fileHash(journal);   // just restored from the branch
  const readDay=()=>{try{return dayState(root,Date.now(),fs);}catch(e){console.log(`::warning::day state unreadable: ${e?.message||e}`);return null;}};
  const out=await runLoop({
    sleep:ms=>new Promise(r=>setTimeout(r,ms)),
    runCycle:async({timeoutMs,cycle})=>{
      console.log(`::group::update cycle ${cycle} (${new Date().toISOString()})`);
      try{fs.rmSync(mark,{force:true});}catch{}
      const r=await runCommand('bash',[path.join(root,'scripts/update_cycle.sh')],{timeoutMs,graceMs:LOOP.stopGraceMs,env:{CYCLE_PUSHED_MARK:mark,CYCLE_CARRY_FILE:journal}});
      console.log('::endgroup::');
      await checkpointJournal();
      const changed=CONTROL.find(f=>controlHash(f)!==controlAtStart[f]);
      return {ok:r.code===0&&!r.timedOut,pushed:r.code===0&&fs.existsSync(mark),retryNow:r.code===75&&!r.timedOut,
        stop:changed?`control_code_changed:${changed}`:null,day:readDay(),error:r.timedOut?'cycle timed out':r.code===75?'push rejected':r.error||`exit ${r.code}`};
    },
    journalPending:async()=>{
      const r=await runCommand('node',[path.join(root,'scripts/carry_preclose_saves.mjs'),'pending','dev',journal],{timeoutMs:LOOP.journalCheckTimeoutMs,graceMs:LOOP.stopGraceMs});
      if(r.code===0&&!r.timedOut)return true;if(r.code===1&&!r.timedOut)return false;
      throw Error(r.timedOut?'journal check timed out':`journal check exit ${r.code}`);
    },
    dispatchPages:async()=>{const r=await runCommand('gh',['workflow','run','pages.yml','--ref','main'],{timeoutMs:LOOP.dispatchTimeoutMs,graceMs:LOOP.stopGraceMs});if(r.code!==0)throw Error(`gh exit ${r.code}`);}
  });
  // For the midday hand-over gate (ops/wake-chain/handoff_gate.mjs): how this run's loop ended. Written before exiting,
  // also when the loop failed; a write failure only warns (the loop's own result decides the exit code).
  if(process.env.LOOP_SUMMARY_FILE){try{writeLoopSummary(process.env.LOOP_SUMMARY_FILE,out,fs);}catch(e){console.log(`::warning::loop summary not written: ${e?.message||e}`);}}
  if(!out.ok)process.exit(1);
}
