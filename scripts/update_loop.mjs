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
  maxConsecutiveFailures:5
});

export function inRacingHours(ms,{startHourJst=LOOP.startHourJst,endHourJst=LOOP.endHourJst}={}){
  const d=new Date(ms+9*3600000),h=d.getUTCHours()+d.getUTCMinutes()/60;
  return h>=startHourJst&&h<endHourJst;
}

export async function runLoop({now=()=>Date.now(),sleep,runCycle,dispatchPages,log=console.log,limits=LOOP}){
  const start=now();let cycles=0,succeeded=0,failures=0,streak=0,pushed=0,reason=null;
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
    const wait=t+limits.intervalMs-now();
    if(wait>0)await sleep(wait);
  }
  const summary={cycles,succeeded,failures,pushed,reason,elapsed_ms:now()-start};
  log(JSON.stringify({update_loop:summary}));
  return {...summary,ok:succeeded>0&&reason!=='too_many_consecutive_failures'};
}

export function runCommand(cmd,args,{timeoutMs,env}={}){
  return new Promise(resolve=>{
    const child=spawn(cmd,args,{stdio:'inherit',detached:true,env:{...process.env,...env}});
    let timedOut=false;
    const timer=timeoutMs?setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGTERM')}catch{}setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},10000).unref();},timeoutMs):null;
    child.on('exit',code=>{if(timer)clearTimeout(timer);resolve({code,timedOut});});
    child.on('error',e=>{if(timer)clearTimeout(timer);resolve({code:-1,error:String(e)});});
  });
}

if(import.meta.url===`file://${process.argv[1]}`){
  const root=path.resolve(import.meta.dirname,'..'),mark=path.join(process.env.RUNNER_TEMP||'/tmp','cycle-pushed');
  const fs=await import('node:fs');
  const out=await runLoop({
    sleep:ms=>new Promise(r=>setTimeout(r,ms)),
    runCycle:async({timeoutMs,cycle})=>{
      console.log(`::group::update cycle ${cycle} (${new Date().toISOString()})`);
      try{fs.rmSync(mark,{force:true});}catch{}
      const r=await runCommand('bash',[path.join(root,'scripts/update_cycle.sh')],{timeoutMs,env:{CYCLE_PUSHED_MARK:mark}});
      console.log('::endgroup::');
      return {ok:r.code===0&&!r.timedOut,pushed:r.code===0&&fs.existsSync(mark),error:r.timedOut?'cycle timed out':r.error||`exit ${r.code}`};
    },
    dispatchPages:async()=>{const r=await runCommand('gh',['workflow','run','pages.yml','--ref','main'],{timeoutMs:60000});if(r.code!==0)throw Error(`gh exit ${r.code}`);}
  });
  if(!out.ok)process.exit(1);
}
