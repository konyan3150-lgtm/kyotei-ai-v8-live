// Decides, at the end of an update run, whether to hand over to a new update run.
// Only a normal stop at the run time limit qualifies — never consecutive failures, racing-hours/night stops,
// control-code stops or a pending journal — and only on the same JST date as the run started, before LAST_HOUR JST,
// and at most MAX_PER_DAY hand-overs per JST day (counted from earlier hand-over runs), so it cannot restart forever.
export const GATE=Object.freeze({lastHourJst:21,maxPerDay:3});
const jstDate=ms=>new Date(ms+9*3600000).toISOString().slice(0,10);
const jstHour=ms=>new Date(ms+9*3600000).getUTCHours();
// Hand-overs already made on the JST day of `now`: only workflow_dispatch runs of the hand-over workflow count
// (push-triggered test runs and anything else do not; 10/23 a push test was counted and used up one of the 3).
export function countHandoffsToday(runs,now){
  if(!Array.isArray(runs))throw Error('invalid runs');
  const today=jstDate(now);
  return runs.filter(r=>r&&r.event==='workflow_dispatch'&&Number.isFinite(Date.parse(r.created_at))&&jstDate(Date.parse(r.created_at))===today).length;
}
export function handoffGate({summary,runStartedAt,now,handoffsToday,gate=GATE}){
  if(!summary||typeof summary!=='object')return {handoff:false,reason:'no_loop_summary'};
  if(summary.reason!=='run_time_limit')return {handoff:false,reason:`loop_stopped_${summary.reason||'unknown'}`};
  if(!summary.ok||summary.journal_pending)return {handoff:false,reason:'loop_not_ok_or_journal_pending'};
  const started=Date.parse(runStartedAt);
  if(!Number.isFinite(started)||jstDate(started)!==jstDate(now))return {handoff:false,reason:'date_changed'};
  if(jstHour(now)>=gate.lastHourJst)return {handoff:false,reason:'too_late_in_day'};
  if(!(handoffsToday>=0))return {handoff:false,reason:'handoff_count_unknown'};
  if(handoffsToday>=gate.maxPerDay)return {handoff:false,reason:'daily_handoff_limit'};
  return {handoff:true,reason:'run_time_limit'};
}

// CLI: decide from the loop summary file, count today's hand-over runs, and dispatch the hand-over waker.
// Never fails the calling (update) run: a failed decision or dispatch is an error annotation; the update's own
// results are already saved.
if(import.meta.url===`file://${process.argv[1]}`){
  const fs=await import('node:fs'),{github}=await import('./wake.mjs');const env=process.env;
  const note=(level,title,msg)=>console.log(`::${level} title=${title}::${msg}`);
  try{
    let loop=null;try{loop=JSON.parse(fs.readFileSync(env.LOOP_SUMMARY_FILE,'utf8'));}catch{}
    const gh=github({token:env.GITHUB_TOKEN,repo:env.GITHUB_REPOSITORY}),now=Date.now();
    let handoffsToday=NaN;
    try{
      handoffsToday=countHandoffsToday(await gh.runs(env.HANDOFF_WORKFLOW),now);}catch(e){note('warning','handoff count failed',String(e?.message||e));}
    // DEV tests may lift the hour limit (HANDOFF_TEST_LAST_HOUR_JST); the production workflow never sets it.
    const gate=env.HANDOFF_TEST_LAST_HOUR_JST?{...GATE,lastHourJst:Number(env.HANDOFF_TEST_LAST_HOUR_JST)}:GATE;
    const d=handoffGate({summary:loop,runStartedAt:env.RUN_STARTED_AT,now,handoffsToday,gate});
    if(!d.handoff){note('notice','no hand-over',JSON.stringify({...d,handoffs_today:handoffsToday}));process.exit(0);}
    await gh.dispatch(env.HANDOFF_WORKFLOW,{parent_run_id:String(env.GITHUB_RUN_ID)});
    note('notice','hand-over dispatched',JSON.stringify({...d,handoffs_today:handoffsToday,parent_run_id:env.GITHUB_RUN_ID,at:new Date().toISOString()}));
  }catch(e){note('error','hand-over dispatch failed',String(e?.message||e));}
}
