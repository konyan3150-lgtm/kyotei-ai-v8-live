import assert from 'node:assert/strict';
import {nextTarget,parseTarget,plan,duplicateWaker,targetDecision,github,confirmDispatch,wake,DEFAULTS} from './wake.mjs';
const MIN=60000,jst=(d,h,m=0)=>Date.UTC(2026,9,d,h-9,m);

// nextTarget: next 07:00 JST (a waker a few minutes late still means today's 07:00).
assert.equal(nextTarget(jst(14,23,45),'07:00'),jst(15,7));assert.equal(nextTarget(jst(15,7,5),'07:00'),jst(15,7));
assert.equal(nextTarget(jst(15,7,30),'07:00'),jst(16,7));assert.equal(nextTarget(jst(15,0,10),'06:55'),jst(15,6,55));
assert.throws(()=>nextTarget(0,'7:00'),/invalid/);assert.throws(()=>nextTarget(0,'24:00'),/invalid/);
assert.throws(()=>parseTarget('x',0),/invalid/);assert.throws(()=>parseTarget(new Date(jst(17,7)).toISOString(),jst(15,7)),/too far/);
// plan: hop while the target is beyond one run's sleep, bounded hops; wait otherwise; stale targets are skipped.
assert.deepEqual(plan({now:jst(14,23,45),target:jst(15,7)}),{action:'hop',sleepMs:330*MIN});
assert.deepEqual(plan({now:jst(15,5,15),target:jst(15,7)}),{action:'wait',sleepMs:105*MIN});
assert.deepEqual(plan({now:jst(15,7,2),target:jst(15,7)}),{action:'wait',sleepMs:0});
assert.equal(plan({now:jst(15,11),target:jst(15,7)}).action,'stale_target');
assert.throws(()=>plan({now:jst(14,1),target:jst(15,7),hop:3}),/too many hops/);
// duplicates: an older active waker for the same target wins; the hop's parent and finished runs do not count.
const T='2026-10-14T22:00:00.000Z',W=(id,status,title=`wake ${T} hop 1`)=>({id,status,display_title:title});
assert.equal(duplicateWaker([W(5,'in_progress'),W(9,'in_progress')],{selfId:9,targetIso:T}).id,5);
assert.equal(duplicateWaker([W(5,'in_progress'),W(9,'in_progress')],{selfId:5,targetIso:T}),null);   // the newer one yields, not the older
assert.equal(duplicateWaker([W(5,'in_progress'),W(9,'in_progress')],{selfId:9,parentId:5,targetIso:T}),null);
assert.equal(duplicateWaker([W(5,'completed'),W(9,'in_progress')],{selfId:9,targetIso:T}),null);
assert.equal(duplicateWaker([W(5,'queued','wake 2026-10-15T22:00:00.000Z hop 0'),W(9,'in_progress')],{selfId:9,targetIso:T}),null);
// target decision: never while active; not if it ran within 10 minutes; unknown statuses fail closed.
const now=jst(15,7);
for(const st of ['queued','in_progress','waiting','pending','requested'])assert.equal(targetDecision([{id:1,status:st}],now).decision,'already_running');
assert.equal(targetDecision([{id:1,status:'completed',run_started_at:new Date(now-5*MIN).toISOString()}],now).decision,'recent_run');
assert.equal(targetDecision([{id:1,status:'completed',run_started_at:new Date(now-60*MIN).toISOString()}],now).decision,'dispatch');
assert.equal(targetDecision([],now).decision,'dispatch');
assert.throws(()=>targetDecision([{id:1,status:'weird'}],now),/unknown run status/);
// github(): token required, only this repository, HTTP errors raised, timeouts set.
assert.throws(()=>github({repo:'a/b'}),/GITHUB_TOKEN/);assert.throws(()=>github({token:'t',repo:'a/b/../c'}),/invalid repository/);
{const calls=[];const gh=github({token:'t',repo:'o/r',request:async(url,o)=>{calls.push({url,o});return o.method==='POST'?{status:204,ok:true}:{status:200,ok:true,json:async()=>({workflow_runs:[]})};}});
 await gh.runs('x.yml');await gh.dispatch('x.yml',{a:'1'});
 assert.ok(calls.every(c=>c.url.startsWith('https://api.github.com/repos/o/r/actions/workflows/x.yml/')));assert.equal(calls[1].o.headers.Authorization,'Bearer t');
 assert.deepEqual(JSON.parse(calls[1].o.body),{ref:'main',inputs:{a:'1'}});assert.ok(calls.every(c=>c.o.signal));
 const bad=github({token:'t',repo:'o/r',request:async()=>({status:403,ok:false})});await assert.rejects(bad.dispatch('x.yml'),/HTTP 403/);}

// Simulated GitHub + clock for whole runs.
function fakeGitHub({start,targetRuns=[],wakerRuns=[],dispatchFails=false,noAppear=false,fiveXX=0,fiveXXCreates=true,listFail=null}){
  let t=start,id=1000;const dispatched=[],sleeps=[];
  const runs={'wake.yml':wakerRuns,'update.yml':targetRuns};
  const gh={runs:async(wf,q='')=>{if(listFail&&dispatched.length&&q.includes('workflow_dispatch'))await listFail();return (runs[wf]||[]).filter(r=>!q.includes('workflow_dispatch')||r.event==='workflow_dispatch');},
    dispatch:async(wf,inputs)=>{if(dispatchFails)throw Object.assign(Error('GitHub POST dispatches HTTP 422'),{status:422});dispatched.push({wf,inputs,at:t});
      const err=fiveXX-->0;
      if(!noAppear&&(!err||fiveXXCreates))(runs[wf]=runs[wf]||[]).unshift({id:++id,status:'queued',event:'workflow_dispatch',created_at:new Date(t).toISOString(),display_title:wf==='wake.yml'?`wake ${inputs.target_iso} hop ${inputs.hop}`:'Update'});
      if(err)throw Object.assign(Error('GitHub POST dispatches HTTP 502'),{status:502});}};
  return {gh,now:()=>t,sleep:async ms=>{sleeps.push(ms);t+=ms;},dispatched,sleeps,get t(){return t}};
}
const self=(o={})=>({selfWorkflow:'wake.yml',targetWorkflow:'update.yml',allowedTargets:['update.yml'],selfId:500,hop:0,targetTime:'07:00',...o});
const ISO=new Date(jst(15,7)).toISOString();
// 1) Started by schedule/hand at 23:45 (no target): hands over to a titled waker for 07:00 the next day.
{const f=fakeGitHub({start:jst(14,23,45)});const r=await wake({...f,log:()=>{},self:self()});
 assert.equal(r.result,'normalized');assert.equal(r.target,ISO);assert.equal(f.dispatched[0].inputs.target_iso,ISO);assert.equal(f.dispatched[0].inputs.hop,'0');assert.equal(f.dispatched[0].inputs.parent_run_id,'500');}
// 2) Titled waker at 23:46: sleeps 5.5 h (below the 6 h job limit) and hops; the hop at 05:16 sleeps until 07:00 and dispatches.
{const f=fakeGitHub({start:jst(14,23,46),wakerRuns:[W(400,'completed')]});
 let r=await wake({...f,log:()=>{},self:self({targetIso:ISO,parentId:400})});
 assert.equal(r.result,'hopped');assert.equal(f.sleeps[0],330*MIN);assert.equal(f.dispatched[0].inputs.hop,'1');
 r=await wake({...f,log:()=>{},self:self({targetIso:ISO,selfId:r.next_run,parentId:500,hop:1})});
 assert.equal(r.result,'dispatched');assert.equal(f.dispatched.at(-1).wf,'update.yml');assert.equal(f.dispatched.at(-1).at,jst(15,7));assert.ok(r.target_run);}
// 3) Duplicate suppression: a second waker for the same target exits before sleeping; and right before dispatching.
{const f=fakeGitHub({start:jst(15,5),wakerRuns:[{id:450,status:'in_progress',display_title:`wake ${ISO} hop 1`}]});
 const r=await wake({...f,log:()=>{},self:self({targetIso:ISO,selfId:600,hop:1})});assert.equal(r.result,'duplicate_waker');assert.equal(r.other,450);assert.equal(f.sleeps.length,0);assert.equal(f.dispatched.length,0);}
{const wr=[];const f=fakeGitHub({start:jst(15,6),wakerRuns:wr});const s=f.sleep;f.sleep=async ms=>{await s(ms);wr.push({id:300,status:'in_progress',display_title:`wake ${ISO} hop 0`});};
 const r=await wake({...f,log:()=>{},self:self({targetIso:ISO,selfId:600,hop:1})});assert.equal(r.result,'duplicate_waker');assert.equal(f.dispatched.length,0);}
// 4) Target already running (e.g. GitHub's schedule did start it) or ran recently: no dispatch.
{const f=fakeGitHub({start:jst(15,6,59),targetRuns:[{id:7,status:'in_progress'}]});const r=await wake({...f,log:()=>{},self:self({targetIso:ISO})});assert.equal(r.result,'already_running');assert.equal(f.dispatched.length,0);}
{const f=fakeGitHub({start:jst(15,6,59),targetRuns:[{id:7,status:'completed',run_started_at:new Date(jst(15,6,55)).toISOString()}]});const r=await wake({...f,log:()=>{},self:self({targetIso:ISO})});assert.equal(r.result,'recent_run');}
// 5) Failures are raised (the run fails and the summary records them): dispatch rejected, dispatch not confirmed,
//    target not allowed, unknown status, too many hops.
{const f=fakeGitHub({start:jst(15,6,59),dispatchFails:true});await assert.rejects(wake({...f,log:()=>{},self:self({targetIso:ISO})}),/HTTP 422/);}
{const f=fakeGitHub({start:jst(15,6,59),noAppear:true});await assert.rejects(wake({...f,log:()=>{},self:self({targetIso:ISO}),limits:{confirmMs:60000,pollMs:10000}}),/not confirmed/);}
{const f=fakeGitHub({start:jst(15,6,59)});await assert.rejects(wake({...f,log:()=>{},self:self({targetWorkflow:'deploy.yml',targetIso:ISO})}),/not allowed/);}
{const f=fakeGitHub({start:jst(15,6,59),targetRuns:[{id:1,status:'action_required'}]});await assert.rejects(wake({...f,log:()=>{},self:self({targetIso:ISO})}),/unknown run status/);}
{const f=fakeGitHub({start:jst(14,9)});await assert.rejects(wake({...f,log:()=>{},self:self({targetIso:ISO,hop:3})}),/too many hops/);}
// 5b) HTTP 502 that still created the run (seen in DEV): confirmed, not dispatched twice, error recorded.
{const f=fakeGitHub({start:jst(15,6,59),fiveXX:1});const r=await wake({...f,log:()=>{},self:self({targetIso:ISO})});
 assert.equal(r.result,'dispatched');assert.equal(f.dispatched.length,1);assert.match(r.dispatch_errors[0],/502/);}
{const f=fakeGitHub({start:jst(14,23,45),fiveXX:1});const r=await wake({...f,log:()=>{},self:self()});assert.equal(r.result,'normalized');assert.equal(f.dispatched.length,1);}
//     502 without a run: dispatched once more and confirmed; twice without a run: fails with both errors.
{const f=fakeGitHub({start:jst(15,6,59),fiveXX:1,fiveXXCreates:false});const r=await wake({...f,log:()=>{},self:self({targetIso:ISO}),limits:{confirmMs:30000,pollMs:10000}});
 assert.equal(r.result,'dispatched');assert.equal(f.dispatched.length,2);}
{const f=fakeGitHub({start:jst(15,6,59),fiveXX:2,fiveXXCreates:false});await assert.rejects(wake({...f,log:()=>{},self:self({targetIso:ISO}),limits:{confirmMs:30000,pollMs:10000}}),/not confirmed.*502.*502/);assert.equal(f.dispatched.length,2);}
// 5c) The confirmation listing fails (HTTP 403 / 503 / timeout / invalid response): unknown, not "no run" ->
//     no second dispatch, the waker fails. Also when the dispatch itself answered 5xx without creating a run.
for(const [name,fail] of [['403',()=>{throw Object.assign(Error('GitHub GET /runs HTTP 403'),{status:403});}],['503',()=>{throw Object.assign(Error('GitHub GET /runs HTTP 503'),{status:503});}],
  ['timeout',()=>{throw Object.assign(Error('The operation was aborted due to timeout'),{name:'TimeoutError'});}],['invalid',()=>{throw Error('invalid runs response');}]]){
  for(const opts of [{},{fiveXX:1,fiveXXCreates:false},{noAppear:true}]){
    const f=fakeGitHub({start:jst(15,6,59),listFail:fail,...opts});
    await assert.rejects(wake({...f,log:()=>{},self:self({targetIso:ISO}),limits:{confirmMs:30000,pollMs:10000}}),/could not be confirmed/,name);
    assert.equal(f.dispatched.length,1,`${name}: posted once`);}
  const f=fakeGitHub({start:jst(14,23,45),listFail:fail});await assert.rejects(wake({...f,log:()=>{},self:self()}),/could not be confirmed/);assert.equal(f.dispatched.length,1);}
//     A listing that fails once mid-confirmation also stops it (no retry of the list as "absent").
{let n=0;const f=fakeGitHub({start:jst(15,6,59),noAppear:true,listFail:()=>{if(++n===2)throw Error('GitHub GET /runs HTTP 503');}});
 await assert.rejects(wake({...f,log:()=>{},self:self({targetIso:ISO}),limits:{confirmMs:60000,pollMs:10000}}),/could not be confirmed/);assert.equal(f.dispatched.length,1);}
// 6) Stale target (chain delayed > 3 h): no dispatch at a wrong time.
{const f=fakeGitHub({start:jst(15,10,30)});const r=await wake({...f,log:()=>{},self:self({targetIso:ISO})});assert.equal(r.result,'stale_target');assert.equal(f.dispatched.length,0);}
assert.ok(DEFAULTS.maxSleepMs<=330*MIN);   // with setup and confirmation well below the 6 h job limit
console.log('wake chain OK: next target time, bounded hops below the job limit, normalization of untargeted starts, duplicate wakers (before sleeping and before dispatch), no dispatch while the target is active or ran recently, dispatch confirmation (5xx checked before one re-dispatch only after a successful empty listing; failed listings never re-dispatch), allowlisted target, failures raised, stale targets skipped');
