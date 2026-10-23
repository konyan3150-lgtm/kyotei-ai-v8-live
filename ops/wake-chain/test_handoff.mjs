import assert from 'node:assert/strict';
import {handoff,HANDOFF} from './handoff.mjs';
import {handoffGate,GATE} from './handoff_gate.mjs';

const MIN=60000,jst=(h,m=0)=>Date.UTC(2026,9,23,h-9,m);
// Fake GitHub with a clock; runs change state by scripted events at given times.
function world({start=jst(12,20),runs={},events=[],dispatchFails=0,onDispatch}){
  let t=start,id=5000;const dispatched=[];
  const all=()=>Object.values(runs).flat();
  const tick=()=>{for(const e of events)if(!e.done&&t>=e.at){e.done=true;e.do(runs,t);}};
  const gh={
    runs:async wf=>{tick();return (runs[wf]||[]).map(r=>({...r}));},
    run:async rid=>{tick();const r=all().find(x=>x.id===Number(rid));if(!r)throw Error('no run');return {...r};},
    dispatch:async wf=>{tick();if(dispatchFails-->0)throw Object.assign(Error('HTTP 502'),{status:502});const r={id:++id,status:'queued',event:'workflow_dispatch',created_at:new Date(t).toISOString()};(runs[wf]=runs[wf]||[]).unshift(r);dispatched.push({wf,at:t,id:r.id});onDispatch?.(r,t,runs);}
  };
  return {gh,now:()=>t,sleep:async ms=>{t+=ms;},dispatched,runs,get t(){return t}};
}
const self={targetWorkflow:'update.yml',allowedTargets:['update.yml'],groupWorkflows:['update.yml','recover.yml'],parentId:100};
const parentRunning=()=>({id:100,status:'in_progress',created_at:new Date(jst(7)).toISOString(),run_started_at:new Date(jst(7)).toISOString()});

// 1) Parent still finishing, Recover pending in the group: waits for both, then dispatches, and the run starts.
{const w=world({runs:{'update.yml':[parentRunning()],'recover.yml':[{id:200,status:'queued',created_at:new Date(jst(12)).toISOString()}]},
  events:[{at:jst(12,21),do:r=>{r['update.yml'][0].status='completed';r['update.yml'][0].conclusion='success';r['recover.yml'][0].status='in_progress';}},
          {at:jst(12,23),do:r=>{r['recover.yml'][0].status='completed';r['recover.yml'][0].conclusion='success';}}],
  onDispatch:(run,t)=>{run.status='in_progress';run.run_started_at=new Date(t+20000).toISOString();}});
 const r=await handoff({...w,self});assert.equal(r.result,'started');assert.equal(w.dispatched.length,1);
 assert.ok(w.dispatched[0].at>=jst(12,23),'dispatched only after the group was idle');assert.equal(r.parent_conclusion,'success');}
// 2) Dispatched run is cancelled before starting (replaced by a new Recover): waits for idle again and dispatches once more.
{let n=0;const w=world({runs:{'update.yml':[{...parentRunning(),status:'completed',conclusion:'success'}],'recover.yml':[]},
  onDispatch:(run,t,runs)=>{n++;if(n===1){run.status='completed';run.conclusion='cancelled';runs['recover.yml'].unshift({id:300,status:'in_progress',created_at:new Date(t).toISOString()});
      w2.events.push({at:t+2*MIN,do:r=>{r['recover.yml'][0].status='completed';r['recover.yml'][0].conclusion='success';}});}
    else{run.status='in_progress';run.run_started_at=new Date(t).toISOString();}}});
 var w2={events:[]};const ev=w2.events;w.gh.runs=(orig=>async wf=>{for(const e of ev)if(!e.done&&w.t>=e.at){e.done=true;e.do(w.runs);}return orig(wf);})(w.gh.runs);
 const r=await handoff({...w,self});assert.equal(r.result,'started');assert.equal(w.dispatched.length,2);
 assert.equal(r.attempts[0].state,'cancelled_before_start');assert.equal(r.attempts[1].state,'started');}
// 3) Someone else already started an update (schedule): no dispatch.
{const w=world({runs:{'update.yml':[{id:150,status:'completed',conclusion:'success',run_started_at:new Date(jst(12,18)).toISOString(),created_at:new Date(jst(12,18)).toISOString()},{...parentRunning(),status:'completed',conclusion:'success'}],'recover.yml':[]}});
 const r=await handoff({...w,self});assert.equal(r.result,'recent_run');assert.equal(w.dispatched.length,0);}
// 4) Bounded: parent never finishes / group never idle / always cancelled -> fail, at most MAX_ATTEMPTS dispatches.
{const w=world({runs:{'update.yml':[parentRunning()],'recover.yml':[]}});await assert.rejects(handoff({...w,self}),/parent run completion not reached/);assert.equal(w.dispatched.length,0);}
{const w=world({runs:{'update.yml':[{...parentRunning(),status:'completed',conclusion:'success'}],'recover.yml':[{id:201,status:'in_progress',created_at:'x'}]}});
 await assert.rejects(handoff({...w,self}),/idle concurrency group not reached/);assert.equal(w.dispatched.length,0);}
{const w=world({runs:{'update.yml':[{...parentRunning(),status:'completed',conclusion:'success'}],'recover.yml':[]},onDispatch:run=>{run.status='completed';run.conclusion='cancelled';}});
 await assert.rejects(handoff({...w,self}),/cancelled before starting 3 times/);assert.equal(w.dispatched.length,HANDOFF.maxAttempts);}
// 5) Dispatch answered 502 but created the run: confirmed once, not dispatched twice; target not allowlisted fails; parent id required.
{const w=world({runs:{'update.yml':[{...parentRunning(),status:'completed',conclusion:'success'}],'recover.yml':[]},onDispatch:(run,t)=>{run.status='in_progress';}});
 const orig=w.gh.dispatch;let first=true;w.gh.dispatch=async wf=>{await orig(wf);if(first){first=false;throw Object.assign(Error('HTTP 502'),{status:502});}};
 const r=await handoff({...w,self});assert.equal(r.result,'started');assert.equal(w.dispatched.length,1);assert.match(r.attempts[0].dispatch_errors[0],/502/);}
await assert.rejects(handoff({...world({}),self:{...self,targetWorkflow:'deploy.yml'}}),/not allowed/);
await assert.rejects(handoff({...world({}),self:{...self,parentId:null}}),/parent run id required/);

// 6) Another update already running (not the parent): stops at once as handed over, without waiting for an idle group.
{const w=world({runs:{'update.yml':[{id:160,status:'in_progress',created_at:new Date(jst(12,15)).toISOString(),run_started_at:new Date(jst(12,15)).toISOString()},{...parentRunning(),status:'completed',conclusion:'success'}],'recover.yml':[]}});
 const t0=w.t;const r=await handoff({...w,self});assert.equal(r.result,'already_running');assert.equal(r.target_run,160);assert.equal(w.dispatched.length,0);assert.ok(w.t-t0<MIN);}
//    ... also when it appears while we wait for Recover.
{const w=world({runs:{'update.yml':[{...parentRunning(),status:'completed',conclusion:'success'}],'recover.yml':[{id:210,status:'in_progress',created_at:'x'}]},
  events:[{at:jst(12,25),do:r=>{r['update.yml'].unshift({id:170,status:'queued',created_at:new Date(jst(12,25)).toISOString()});}}]});
 const r=await handoff({...w,self});assert.equal(r.result,'already_running');assert.equal(r.target_run,170);assert.equal(w.dispatched.length,0);}
// 7) Parent not successful (e.g. journal save failed after the loop): no dispatch.
for(const conclusion of ['failure','cancelled','timed_out']){
 const w=world({runs:{'update.yml':[{...parentRunning(),status:'completed',conclusion}],'recover.yml':[]}});
 const r=await handoff({...w,self});assert.equal(r.result,'parent_not_successful');assert.equal(r.parent_conclusion,conclusion);assert.equal(w.dispatched.length,0);}
// 8) Overall deadline: Recover keeps the group busy ~19 min before each attempt and every dispatched run is cancelled
//    ~14 min later. All waits share one budget: the waker gives up within totalMs - reserveMs (inside the job limit).
{let busyUntil=jst(12,39);const w=world({runs:{'update.yml':[{...parentRunning(),status:'completed',conclusion:'success'}],'recover.yml':[{id:220,status:'in_progress',created_at:'x'}]},
  onDispatch:(run,t,runs)=>{w3.push({at:t+14*MIN,do:()=>{run.status='completed';run.conclusion='cancelled';runs['recover.yml'][0].status='in_progress';busyUntil=t+14*MIN+19*MIN;}});}});
 var w3=[];const start=w.t;
 const orig=w.gh.runs,origRun=w.gh.run;const fire=()=>{for(const e of w3)if(!e.done&&w.t>=e.at){e.done=true;e.do();}if(w.t>=busyUntil)w.runs['recover.yml'][0].status='completed';};
 w.gh.runs=async wf=>{fire();return orig(wf);};w.gh.run=async id=>{fire();return origRun(id);};
 await assert.rejects(handoff({...w,self}),/not reached in time|no time left/);
 assert.ok(w.t-start<=HANDOFF.totalMs-HANDOFF.reserveMs,`took ${(w.t-start)/MIN} min`);assert.ok(w.dispatched.length>=1&&w.dispatched.length<=HANDOFF.maxAttempts);}

// 9) ChatGPT's reproduction: parent done at ~20 min, Recover until ~40 min, the dispatched run never shows up.
//    Before: confirmation restarted on the re-dispatch (POST again at 43 min, failure at 46 min).
//    Now: one absolute deadline (45 - 2 min): confirmation stops at 43 min and no POST happens at/after it.
{const s0=jst(12,20);const w=world({start:s0,runs:{'update.yml':[parentRunning()],'recover.yml':[{id:230,status:'in_progress',created_at:'x'}]},
  events:[{at:s0+19.9*MIN,do:r=>{r['update.yml'].find(x=>x.id===100).status='completed';r['update.yml'].find(x=>x.id===100).conclusion='success';}},
          {at:s0+39.9*MIN,do:r=>{r['recover.yml'][0].status='completed';r['recover.yml'][0].conclusion='success';}}],
  onDispatch:(run,t,runs)=>{runs['update.yml'].splice(runs['update.yml'].indexOf(run),1);}});   // accepted but never listed
 const posts=[];const orig=w.gh.dispatch;w.gh.dispatch=async(...a)=>{posts.push(w.t);return orig(...a);};
 await assert.rejects(handoff({...w,self}));
 const limit=s0+HANDOFF.totalMs-HANDOFF.reserveMs;
 assert.ok(w.t<=limit,`ended at ${(w.t-s0)/MIN} min`);assert.ok(posts.length>=1&&posts.every(t=>t<limit),'no POST at or after the deadline');}
// dispatchConfirmed / confirmDispatch with an absolute deadline (the plain wake chain passes none and is unchanged).
{const {dispatchConfirmed,confirmDispatch,github}=await import('./wake.mjs');
 let t=1000,posts=0,lists=0;const gh={dispatch:async()=>{posts++;},runs:async()=>{lists++;return [];}};const clk={now:()=>t,sleep:async ms=>{t+=ms;}};
 await assert.rejects(dispatchConfirmed(gh,'u.yml',undefined,{...clk,confirmMs:180000,pollMs:10000,deadline:1000}),/deadline reached before dispatch/);assert.equal(posts,0);
 t=0;posts=0;lists=0;await assert.rejects(dispatchConfirmed(gh,'u.yml',undefined,{...clk,confirmMs:180000,pollMs:10000,deadline:60000}),/deadline/);
 assert.equal(posts,1,'no second POST after the deadline');assert.ok(t<=60000);
 t=0;lists=0;await assert.rejects(confirmDispatch(gh,'u.yml',0,{...clk,confirmMs:180000,pollMs:10000,deadline:25000}),/deadline/);assert.ok(t<=25000);assert.ok(lists<=4);
 // API timeouts follow the remaining time (1 s minimum, 20 s maximum).
 const seen=[];const g=github({token:'t',repo:'o/r',request:async(u,o)=>{seen.push(o.timeout_ms);return {status:200,ok:true,json:async()=>({workflow_runs:[],status:'completed'})};}});
 await g.runs('u.yml','',{timeoutMs:5000});await g.runs('u.yml');await g.run(1,{timeoutMs:200});await g.run(1,{timeoutMs:99999});
 assert.deepEqual(seen,[5000,20000,1000,20000]);}
// The overall budget plus setup fits the waker job limit (60 min in the workflows).
assert.ok(HANDOFF.totalMs+5*MIN<=60*MIN);

// Gate: only a normal run-time-limit stop, same JST date, before 21:00 JST, at most 3 per day.
const ok={reason:'run_time_limit',ok:true,journal_pending:false},start=new Date(jst(7)).toISOString();
assert.deepEqual(handoffGate({summary:ok,runStartedAt:start,now:jst(12,19),handoffsToday:0}),{handoff:true,reason:'run_time_limit'});
for(const reason of ['too_many_consecutive_failures','outside_racing_hours','late_races_finished','night_hard_limit','control_code_changed:x'])
  assert.equal(handoffGate({summary:{...ok,reason},runStartedAt:start,now:jst(12,19),handoffsToday:0}).handoff,false);
assert.equal(handoffGate({summary:{...ok,journal_pending:true},runStartedAt:start,now:jst(12,19),handoffsToday:0}).handoff,false);
assert.equal(handoffGate({summary:{...ok,ok:false},runStartedAt:start,now:jst(12,19),handoffsToday:0}).handoff,false);
assert.equal(handoffGate({summary:ok,runStartedAt:new Date(jst(7)-86400000).toISOString(),now:jst(12,19),handoffsToday:0}).reason,'date_changed');
assert.equal(handoffGate({summary:ok,runStartedAt:start,now:jst(21,5),handoffsToday:0}).reason,'too_late_in_day');
assert.equal(handoffGate({summary:ok,runStartedAt:start,now:jst(12,19),handoffsToday:GATE.maxPerDay}).reason,'daily_handoff_limit');
assert.equal(handoffGate({summary:ok,runStartedAt:start,now:jst(12,19),handoffsToday:NaN}).reason,'handoff_count_unknown');
assert.equal(handoffGate({summary:null,runStartedAt:start,now:jst(12,19),handoffsToday:0}).reason,'no_loop_summary');
console.log('handoff OK: stops when another update already runs (also while waiting), no hand-over after an unsuccessful parent, one overall deadline inside the job limit (also for dispatch confirmation and re-dispatch: no POST at or after it, API timeouts from the remaining time), waits for the parent and an idle group (pending Recover), dispatch accepted vs actually started, re-dispatch only after a cancel-before-start (max 3), already started elsewhere, bounded waits, 502 handling; gate only after a normal run-time-limit stop, same date, before 21:00, max 3/day');
