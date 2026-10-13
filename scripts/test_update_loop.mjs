import assert from 'node:assert/strict';
import {runLoop,inRacingHours,runCommand,LOOP} from './update_loop.mjs';

const MIN=60000,jst=(h,m=0)=>Date.UTC(2026,9,13,h-9,m);   // JST wall time on 2026-10-13
function sim({startMs,cycleMs=()=>MIN,outcome=()=>({ok:true,pushed:true}),pagesFail=false,journalPending}){
  let t=startMs;const starts=[],ends=[],logs=[];let pages=0;
  return {run:runLoop({now:()=>t,sleep:async ms=>{assert.ok(ms>0);t+=ms;},log:m=>logs.push(m),
    runCycle:async({timeoutMs,cycle})=>{starts.push(t);const d=Math.min(cycleMs(cycle),timeoutMs);t+=d;ends.push(t);const o=outcome(cycle);if(o instanceof Error)throw o;return d>=timeoutMs?{ok:false,error:'cycle timed out'}:o;},
    dispatchPages:async()=>{pages++;if(pagesFail)throw Error('dispatch down');},...(journalPending?{journalPending}:{})}),starts,ends,logs,get pages(){return pages}};
}
assert.equal(inRacingHours(jst(6,59)),false);assert.equal(inRacingHours(jst(7,0)),true);assert.equal(inRacingHours(jst(21,59)),true);assert.equal(inRacingHours(jst(22,0)),false);

// 1) Morning start: a cycle every 3 minutes until the 5.5 h limit; no cycle can end after 330 minutes.
{const s=sim({startMs:jst(7)});const r=await s.run;
 assert.equal(r.reason,'run_time_limit');assert.ok(r.ok);
 for(let i=1;i<s.starts.length;i++)assert.equal(s.starts[i]-s.starts[i-1],3*MIN);
 assert.equal(s.starts.length,107);assert.ok(Math.max(...s.ends)-jst(7)<=LOOP.maxRunMs);assert.equal(s.pages,107);}
// 2) Evening start: stops at 22:00 JST.
{const s=sim({startMs:jst(20)});const r=await s.run;assert.equal(r.reason,'outside_racing_hours');assert.equal(s.starts.length,40);assert.equal(s.starts.at(-1),jst(21,57));}
// 3) Triggered at night (manual or push): exactly one cycle, as before.
{const s=sim({startMs:jst(23)});const r=await s.run;assert.equal(s.starts.length,1);assert.equal(r.reason,'outside_racing_hours');assert.ok(r.ok);}
// 4) Five consecutive failures stop the run and mark it failed.
{const s=sim({startMs:jst(9),outcome:()=>({ok:false,error:'boom'})});const r=await s.run;assert.equal(r.cycles,5);assert.equal(r.ok,false);assert.equal(r.reason,'too_many_consecutive_failures');assert.equal(s.pages,0);}
// 5) Intermittent failures (and thrown errors) do not stop the loop; the streak resets after a success.
{const s=sim({startMs:jst(9),outcome:c=>c%5===0?{ok:true,pushed:false}:c%2?new Error('thrown'):{ok:false,error:'x'}});const r=await s.run;
 assert.equal(r.reason,'run_time_limit');assert.ok(r.ok);assert.ok(r.failures>0&&r.succeeded>0);assert.equal(s.pages,0);}   // not pushed -> no Pages dispatch
// 6) Slow cycles: the next starts right after (no waiting), and every cycle still ends within the run limit.
{const s=sim({startMs:jst(7),cycleMs:()=>11*MIN});const r=await s.run;
 for(let i=1;i<s.starts.length;i++)assert.equal(s.starts[i],s.ends[i-1]);assert.ok(Math.max(...s.ends)-jst(7)<=LOOP.maxRunMs);assert.equal(r.reason,'run_time_limit');}
// 7) A cycle that hits its timeout counts as a failure; the loop still bounded.
{const s=sim({startMs:jst(7),cycleMs:()=>60*MIN});const r=await s.run;assert.equal(r.cycles,5);assert.equal(r.ok,false);
 assert.ok(Math.max(...s.ends)-jst(7)<=LOOP.maxRunMs);}
// 8) Pages dispatch failure is only a warning.
{const s=sim({startMs:jst(21,50),pagesFail:true});const r=await s.run;assert.ok(r.ok);assert.equal(r.cycles,4);assert.ok(s.logs.some(m=>m.includes('Pages dispatch failed')));}
// 9) Real process timeout: a hanging command is stopped (its whole process group) and reported as timed out.
{const t0=Date.now();const r=await runCommand('bash',['-c','sleep 30 & sleep 30; wait'],{timeoutMs:300});
 assert.equal(r.timedOut,true);assert.ok(Date.now()-t0<5000);
 const ok=await runCommand('bash',['-c','exit 0']);assert.deepEqual([ok.code,ok.timedOut],[0,false]);
 const bad=await runCommand('bash',['-c','exit 3']);assert.equal(bad.code,3);}
// 10) A rejected push is retried right away (up to 2 times), then the normal 3-minute cadence resumes.
{let n=0;const s=sim({startMs:jst(9),outcome:()=>(++n<=4?{ok:false,retryNow:true,error:'push rejected'}:{ok:true,pushed:true})});
 const r=await s.run;assert.equal(s.starts[1]-s.ends[0],0);assert.equal(s.starts[2]-s.ends[1],0);   // two immediate retries
 assert.equal(s.starts[3],s.starts[2]+3*MIN);assert.equal(s.starts[4],s.ends[3]);assert.ok(r.ok);}
// 11) Control code changed on main (loop, workflow, dependencies): stop so the pending run restarts with it.
{const s=sim({startMs:jst(9),outcome:c=>c===3?{ok:true,pushed:true,stop:'control_code_changed:scripts/update_loop.mjs'}:{ok:true,pushed:true}});
 const r=await s.run;assert.equal(r.cycles,3);assert.equal(r.reason,'control_code_changed:scripts/update_loop.mjs');assert.ok(r.ok);}
// 12) The parent exits on SIGTERM but a child ignores it: runCommand returns only after the child is gone too.
{const fs=await import('node:fs'),os=await import('node:os'),p=await import('node:path');const pidFile=p.join(fs.mkdtempSync(p.join(os.tmpdir(),'v8-loop-')),'child.pid');
 const r=await runCommand('bash',['-c',`(trap "" TERM; exec sleep 60) & echo $! > ${pidFile}; sleep 60`],{timeoutMs:300,graceMs:300});
 const pid=Number(fs.readFileSync(pidFile,'utf8'));let alive=true;try{process.kill(pid,0);}catch{alive=false;}
 assert.equal(r.timedOut,true);assert.equal(alive,false,'child still running after runCommand returned');
 // A background child left behind by a normally finished command is also stopped before returning.
 const r2=await runCommand('bash',['-c',`(trap "" TERM; exec sleep 60) & echo $! > ${pidFile}; exit 0`],{graceMs:300});
 const pid2=Number(fs.readFileSync(pidFile,'utf8'));let alive2=true;try{process.kill(pid2,0);}catch{alive2=false;}
 assert.equal(r2.code,0);assert.equal(alive2,false);}
// 13) Push rejected on the very last cycle: one more cycle runs right away to flush the journal (within the job limit).
{let pending=false;const s=sim({startMs:jst(7),cycleMs:()=>11*MIN,outcome:c=>{if(c===29){pending=true;return {ok:false,retryNow:true,error:'push rejected'};}if(c===30)pending=false;return {ok:true,pushed:true};},journalPending:async()=>pending});
 const r=await s.run;assert.equal(r.reason,'run_time_limit');assert.equal(r.cycles,30);assert.ok(r.ok);assert.equal(r.journal_pending,false);
 assert.equal(s.starts[29],s.ends[28]);assert.ok(Math.max(...s.ends)-jst(7)<=LOOP.maxRunMs+LOOP.cycleTimeoutMs);}
// 14) Journal still pending after the flush (e.g. stopped for racing hours / control change / failures): the run fails, not quietly.
for(const opts of [{startMs:jst(21,55)},{startMs:jst(9),outcome:c=>c===2?{ok:true,pushed:true,stop:'control_code_changed:x'}:{ok:true,pushed:true}},{startMs:jst(9),outcome:()=>({ok:false,error:'x'})}]){
  const s=sim({...opts,journalPending:async()=>true});const r=await s.run;
  assert.equal(r.ok,false);assert.equal(r.journal_pending,true);assert.ok(s.logs.some(m=>m.includes('still pending in the journal')));}
// 15) No pending journal: no extra cycle.
{const s=sim({startMs:jst(21,55),journalPending:async()=>false});const r=await s.run;assert.equal(r.cycles,2);assert.ok(r.ok);}
assert.ok(Object.isFrozen(LOOP));assert.ok(LOOP.maxRunMs+LOOP.cycleTimeoutMs<=345*MIN);   // regular cycles end by maxRunMs; one journal flush cycle still ends before the 350-min job limit (cache save after)
console.log('update loop OK: 3-minute cadence, 5.5 h bound, racing-hours stop, single night cycle, failure streak stop, slow and timed-out cycles bounded, Pages dispatch only after a push, process-group timeout, immediate retry after a rejected push, stop on control code change, no surviving child after return, journal flush before ending and failure if it stays pending');
