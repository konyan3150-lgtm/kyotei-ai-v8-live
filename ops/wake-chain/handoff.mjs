// Midday hand-over for the production update loop.
// The update loop stops at its 5.5 h run limit (about 12:19 JST when it starts at 07:00). Its pending successor in the
// shared concurrency group can be replaced by another workflow's pending run (Recover), so no update runs until a late
// `schedule` start (10/20-10/23: about 2 h without odds updates). The loop's workflow then dispatches this hand-over
// waker, which runs in its own group and:
//   1. waits until the parent update run has completed (it is still running its final steps when it dispatches us),
//   2. waits until no run of the shared group is queued or running (e.g. Recover), so the dispatch neither replaces
//      a pending Recover nor gets replaced by it right away,
//   3. stops if another update run is active or started within RECENT (someone else already took over),
//   4. dispatches the update and confirms that the dispatch created a run (accepted) — same rules as the wake chain,
//   5. waits until that run has actually started (in_progress, or completed with a non-cancelled conclusion);
//      if it was cancelled before starting (replaced in the group), it goes back to 2, at most MAX_ATTEMPTS times.
// Only a parent whose final conclusion is success is handed over. While waiting for an idle group it also stops as soon
// as another update is running or started recently (already handed over). One overall deadline (inside the job limit,
// with time reserved for the result record) bounds every wait; every decision is written to the summary/annotations.
import {ACTIVE,targetDecision,dispatchConfirmed,DEFAULTS} from './wake.mjs';

export const HANDOFF=Object.freeze({totalMs:45*60000,reserveMs:2*60000,parentWaitMs:20*60000,idleWaitMs:20*60000,startWaitMs:15*60000,pollMs:30000,maxAttempts:3,recentMs:10*60000});

// Poll fn until it returns a value, within min(capMs, remaining overall budget).
async function until(fn,{now,sleep,pollMs,capMs,budget,what}){
  const deadline=Math.min(now()+capMs,budget());
  while(true){const v=await fn();if(v)return v;if(now()>=deadline)throw Error(`${what} not reached in time`);await sleep(Math.max(0,Math.min(pollMs,deadline-now())));}
}

export async function handoff({gh,now=Date.now,sleep,log=()=>{},self,limits={}}){
  const L={...HANDOFF,...limits},{targetWorkflow,allowedTargets,groupWorkflows,parentId}=self;
  if(!allowedTargets.includes(targetWorkflow))throw Error(`target workflow not allowed: ${targetWorkflow}`);
  if(parentId==null||parentId===''||!Number.isSafeInteger(Number(parentId))||Number(parentId)<=0)throw Error('parent run id required');
  const parentRun=Number(parentId),out={mode:'handoff',target_workflow:targetWorkflow,parent_run:parentRun,attempts:[]};
  // One overall deadline (inside the job limit, with time kept for writing the result); every wait uses what is left.
  const hardEnd=now()+L.totalMs-L.reserveMs,budget=()=>hardEnd;
  const opt={now,sleep,pollMs:L.pollMs,budget};
  const fail=(msg)=>Object.assign(Error(msg),{out});
  const mine=()=>new Set(out.attempts.map(x=>x.run).filter(Boolean));
  // Another update (not the parent, not ours, not cancelled before doing anything) active or started recently.
  const takenOver=async()=>{
    const others=(await gh.runs(targetWorkflow)).filter(r=>r.id!==parentRun&&!mine().has(r.id)&&!(r.status==='completed'&&r.conclusion==='cancelled'));
    const d=targetDecision(others,now(),{recentMs:L.recentMs});
    return d.decision==='dispatch'?null:d;
  };
  // 1. parent finished, and only a fully successful parent is handed over (its journal save etc. may fail after the loop)
  let parent;
  try{parent=await until(async()=>{const r=await gh.run(parentRun);return r.status==='completed'?r:null;},{...opt,capMs:L.parentWaitMs,what:'parent run completion'});}
  catch(e){throw fail(e.message);}
  out.parent_conclusion=parent.conclusion;
  if(parent.conclusion!=='success')return {...out,result:'parent_not_successful'};
  for(let attempt=1;attempt<=L.maxAttempts;attempt++){
    const a={attempt};out.attempts.push(a);
    // 2. wait for an idle group; meanwhile, if another update is already running or just started, we are done
    let state;
    try{state=await until(async()=>{
      const t=await takenOver();if(t)return {taken:t};
      for(const wf of groupWorkflows){const runs=await gh.runs(wf);if(runs.some(r=>ACTIVE.has(r.status)&&r.id!==parentRun))return null;}
      return {idle:true};
    },{...opt,capMs:L.idleWaitMs,what:'idle concurrency group'});}
    catch(e){throw fail(e.message);}
    if(state.taken)return {...out,result:state.taken.decision,target_run:state.taken.run};
    a.group_idle_at=new Date(now()).toISOString();
    // 3. dispatch accepted = a new run exists (confirmation also limited by the remaining budget)
    const left=budget()-now();if(left<=0)throw fail('no time left to dispatch');
    const since=now();let res;
    try{res=await dispatchConfirmed(gh,targetWorkflow,undefined,{...opt,confirmMs:Math.min(DEFAULTS.confirmMs,left)});}
    catch(e){throw fail(e.message);}
    a.dispatched_at=new Date(since).toISOString();a.run=res.run.id;if(res.dispatch_errors.length)a.dispatch_errors=res.dispatch_errors;
    // 4. actually started?
    let started;
    try{started=await until(async()=>{const r=await gh.run(res.run.id);
      if(r.status==='in_progress'||(r.status==='completed'&&r.conclusion!=='cancelled'))return {state:'started',run:r};
      if(r.status==='completed'&&r.conclusion==='cancelled')return {state:'cancelled_before_start',run:r};
      return null;},{...opt,capMs:L.startWaitMs,what:`start of run ${res.run.id}`});}
    catch(e){throw fail(e.message);}
    a.state=started.state;a.run_started_at=started.run.run_started_at||null;
    if(started.state==='started')return {...out,result:'started',target_run:res.run.id,run_started_at:started.run.run_started_at||null};
    log(`run ${res.run.id} was cancelled before it started (replaced in the concurrency group); attempt ${attempt}/${L.maxAttempts}`);
  }
  throw fail(`update was cancelled before starting ${L.maxAttempts} times`);
}

if(import.meta.url===`file://${process.argv[1]}`){
  const fs=await import('node:fs'),{github}=await import('./wake.mjs');const env=process.env;
  const summary=t=>{if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,t+'\n');};
  const limits=env.HANDOFF_POLL_MS?{pollMs:Number(env.HANDOFF_POLL_MS)}:{};
  const self={targetWorkflow:env.HANDOFF_TARGET,allowedTargets:(env.HANDOFF_ALLOWED||'').split(',').filter(Boolean),groupWorkflows:(env.HANDOFF_GROUP||'').split(',').filter(Boolean),parentId:env.HANDOFF_PARENT};
  try{
    const r=await handoff({gh:github({token:env.GITHUB_TOKEN,repo:env.GITHUB_REPOSITORY}),sleep:ms=>new Promise(res=>setTimeout(res,ms)),log:m=>console.log(m),self,limits});
    console.log(`::notice title=handoff ${r.result}::${JSON.stringify(r)}`);summary('### update hand-over\n\n```json\n'+JSON.stringify(r,null,2)+'\n```');
  }catch(e){const m=String(e?.message||e);console.log(`::error title=handoff failed::${m}${e?.out?' '+JSON.stringify(e.out):''}`);summary('### update hand-over FAILED\n\n'+m);process.exit(1);}
}
