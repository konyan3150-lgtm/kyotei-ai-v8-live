import assert from 'node:assert/strict';
import {runLoop,inRacingHours,racingStop,dayState,runCommand,LOOP} from './update_loop.mjs';

const MIN=60000,jst=(h,m=0)=>Date.UTC(2026,9,13,h-9,m);   // JST wall time on 2026-10-13
function sim({startMs,cycleMs=()=>MIN,outcome=()=>({ok:true,pushed:true}),pagesFail=false,journalPending}){
  let t=startMs;const starts=[],ends=[],logs=[];let pages=0;
  return {run:runLoop({now:()=>t,sleep:async ms=>{assert.ok(ms>0);t+=ms;},log:m=>logs.push(m),
    runCycle:async({timeoutMs,cycle})=>{starts.push(t);const d=Math.min(cycleMs(cycle),timeoutMs);t+=d;ends.push(t);const o=outcome(cycle,t);if(o instanceof Error)throw o;return d>=timeoutMs?{ok:false,error:'cycle timed out'}:o;},
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
// 16) The journal check itself fails (unreadable/invalid journal, command error): never read as empty; the run fails.
{const s=sim({startMs:jst(21,55),journalPending:async()=>{throw Error('journal check exit 2')}});const r=await s.run;
 assert.equal(r.ok,false);assert.equal(r.journal_pending,true);assert.equal(r.cycles,3);   // 2 regular + 1 flush attempt
 assert.ok(s.logs.some(m=>m.includes('journal check failed')));assert.ok(s.logs.some(m=>m.includes('could not be checked')));}

// --- Races closing after 22:00 JST (10/14: Shimonoseki 11R 22:20, 12R 22:45) ---
const D='20261013',late=(lastH,lastM,unsettledAt)=>(c,t)=>({ok:true,pushed:true,day:{date:D,lastCloseMs:jst(lastH,lastM),unsettled:unsettledAt(t)}});
const lastEnd=s=>Math.max(...s.ends);
// 17) Late races, results on time: keeps the 3-minute updates past 22:00 through the 22:45 close and stops 30 min after it
//     once everything is settled.
{const s=sim({startMs:jst(20),outcome:late(22,45,t=>t<jst(22,58)?1:0)});const r=await s.run;
 assert.equal(r.reason,'late_races_finished');assert.ok(r.ok);
 for(let i=1;i<s.starts.length;i++)assert.equal(s.starts[i]-s.starts[i-1],3*MIN);
 assert.ok(s.starts.some(x=>x>=jst(22,15)&&x<jst(22,20)),'odds refreshed shortly before the 22:20 close');
 assert.ok(s.starts.some(x=>x>=jst(22,40)&&x<jst(22,45)),'odds refreshed shortly before the 22:45 close');
 assert.ok(s.starts.at(-1)<jst(23,15)&&s.starts.at(-1)>=jst(23,12));assert.ok(r.late_cycles>0);assert.equal(r.unsettled,0);}
// 18) Result published late: continues while a closed race is unsettled, then stops at the next check.
{const s=sim({startMs:jst(20),outcome:late(22,45,t=>t<jst(23,31)?1:0)});const r=await s.run;
 assert.equal(r.reason,'late_races_finished');assert.ok(s.starts.at(-1)>=jst(23,30)&&s.starts.at(-1)<jst(23,36));}
// 19) Result never published / result fetch failing: bounded by the hard end (23:45 JST), every cycle ends before midnight.
{const s=sim({startMs:jst(20),outcome:late(22,45,()=>2)});const r=await s.run;
 assert.equal(r.reason,'night_hard_limit');assert.ok(r.ok);assert.ok(s.starts.at(-1)<jst(23,45));assert.ok(lastEnd(s)<jst(24));}
//     Same with failing cycles (they still report the day state): the hard end or the failure streak stops it.
{const s=sim({startMs:jst(20),outcome:(c,t)=>t>=jst(22,30)?{ok:false,error:'results down',day:{date:D,lastCloseMs:jst(22,45),unsettled:2}}:late(22,45,()=>2)(c,t)});const r=await s.run;
 assert.equal(r.reason,'too_many_consecutive_failures');assert.ok(lastEnd(s)<jst(23,45));}
//     A failed day-state read (null) never extends the run.
{const s=sim({startMs:jst(21,50),outcome:()=>({ok:true,pushed:true,day:null})});const r=await s.run;assert.equal(r.reason,'outside_racing_hours');assert.equal(s.starts.at(-1),jst(21,59));}
// 20) No race after 22:00 (last close 20:45): stops at 22:00 as before, even with an unsettled race.
{const s=sim({startMs:jst(20),outcome:late(20,45,()=>1)});const r=await s.run;assert.equal(r.reason,'outside_racing_hours');assert.equal(s.starts.at(-1),jst(21,57));assert.equal(r.late_cycles,0);}
// 21) Day state of another date (stale odds) or unknown: no extension.
{const s=sim({startMs:jst(20),outcome:()=>({ok:true,pushed:true,day:{date:'20261012',lastCloseMs:jst(22,45)-86400000,unsettled:3}})});const r=await s.run;assert.equal(r.reason,'outside_racing_hours');}
{const s=sim({startMs:jst(20)});const r=await s.run;assert.equal(r.reason,'outside_racing_hours');}
// 22) A run that starts at 22:30 (pending run after the previous one hit its limit): continues for the late races.
{const s=sim({startMs:jst(22,30),outcome:late(22,45,t=>t<jst(23)?1:0)});const r=await s.run;assert.equal(r.reason,'late_races_finished');assert.ok(s.starts.length>10);}
//     Started after the hard end: exactly one cycle, as before.
{const s=sim({startMs:jst(23,50),outcome:late(22,45,()=>1)});const r=await s.run;assert.equal(s.starts.length,1);assert.equal(r.reason,'night_hard_limit');}
// 23) The 5.5 h run limit still applies during the late window (the next pending run takes over).
{const s=sim({startMs:jst(17,30),outcome:late(22,45,()=>1)});const r=await s.run;assert.equal(r.reason,'run_time_limit');assert.ok(lastEnd(s)-jst(17,30)<=LOOP.maxRunMs);}
// 24) Pre-close purchases are still flushed after a late stop; still failing if they stay pending.
{let pending=true;const s=sim({startMs:jst(23),outcome:(c,t)=>{if(c>1)pending=false;return late(22,45,()=>0)(c,t);},journalPending:async()=>pending});
 const r=await s.run;assert.equal(r.reason,'late_races_finished');assert.ok(r.ok);assert.equal(r.journal_pending,false);}
{const s=sim({startMs:jst(23,40),outcome:late(22,45,()=>1),journalPending:async()=>true});const r=await s.run;assert.equal(r.reason,'night_hard_limit');assert.equal(r.ok,false);assert.equal(r.journal_pending,true);}
// 25) racingStop boundaries.
{const day={date:D,lastCloseMs:jst(22,45),unsettled:0};
 assert.equal(racingStop(jst(6,59),day),'outside_racing_hours');assert.equal(racingStop(jst(7),day),null);assert.equal(racingStop(jst(21,59),null),null);
 assert.equal(racingStop(jst(22),null),'outside_racing_hours');assert.equal(racingStop(jst(23,14),day),null);assert.equal(racingStop(jst(23,15),day),'late_races_finished');
 assert.equal(racingStop(jst(23,44),{...day,unsettled:1}),null);assert.equal(racingStop(jst(23,45),{...day,unsettled:1}),'night_hard_limit');
 assert.equal(racingStop(jst(24,30),{...day,unsettled:1}),'outside_racing_hours');}   // next day 00:30: other date
// 26) dayState: last close over all races of today in dev/odds.json; unsettled = today's saved records already closed.
{const fs=await import('node:fs'),os=await import('node:os'),p=await import('node:path');const root=fs.mkdtempSync(p.join(os.tmpdir(),'v8-day-'));fs.mkdirSync(p.join(root,'dev'));
 const w=(f,o)=>fs.writeFileSync(p.join(root,'dev',f),JSON.stringify(o));
 w('odds.json',{date:'20261014',races:{19:{11:{closed_at:'2026-10-14T22:20:00+09:00'},12:{closed_at:'2026-10-14T22:45:00+09:00'}},4:{1:{closed_at:'2026-10-14T10:30:00+09:00'},2:{}}}});
 const rec=(c,x={})=>({closed_at:c,...x});
 w('server-predictions.json',{records:{
   kyotei_v8_dev_result_20261014_19_11:rec('2026-10-14T13:20:00.000Z'),kyotei_v8_dev_result_20261014_19_12:rec('2026-10-14T13:45:00.000Z'),
   kyotei_v8_dev_result_20261014_04_01:rec('2026-10-14T01:30:00.000Z',{settled:true}),kyotei_v8_dev_result_20261014_04_02:rec('2026-10-14T02:00:00.000Z',{cancelled:true}),
   kyotei_v8_dev_result_20261013_19_12:rec('2026-10-13T13:45:00.000Z')}});
 const now=Date.parse('2026-10-14T22:30:00+09:00');
 assert.deepEqual(dayState(root,now,fs),{date:'20261014',lastCloseMs:Date.parse('2026-10-14T22:45:00+09:00'),unsettled:1});
 assert.equal(dayState(root,Date.parse('2026-10-14T23:00:00+09:00'),fs).unsettled,2);
 w('odds.json',{date:'20261013',races:{19:{12:{closed_at:'2026-10-13T22:45:00+09:00'}}}});
 assert.deepEqual(dayState(root,now,fs),{date:'20261014',lastCloseMs:null,unsettled:0});
 fs.writeFileSync(p.join(root,'dev','odds.json'),'{broken');assert.throws(()=>dayState(root,now,fs));}
assert.ok(Object.isFrozen(LOOP));assert.ok(LOOP.hardEndHourJst<24);assert.ok(LOOP.maxRunMs+LOOP.cycleTimeoutMs<=345*MIN);   // regular cycles end by maxRunMs; one journal flush cycle still ends before the 350-min job limit (cache save after)
console.log('update loop OK: 3-minute cadence, 5.5 h bound, racing-hours stop, late races after 22:00 until last close + result grace (hard end 23:45 JST), single night cycle, failure streak stop, slow and timed-out cycles bounded, Pages dispatch only after a push, process-group timeout, immediate retry after a rejected push, stop on control code change, no surviving child after return, journal flush before ending and failure if it stays pending or cannot be checked');
