// Wake chain: start a workflow at a fixed JST time without relying on GitHub's `schedule` (which on 10/14 did not
// start between 07:00 and 09:53 JST, and not at all after 22:07). A waker run sleeps (at most maxSleep per run,
// below the 6 h job limit), dispatches the next waker if the target is further away, and at the target time
// dispatches the target workflow unless it is already running or ran recently.
// Credentials: only the job's own GITHUB_TOKEN (actions: write on this repository). No personal token, no other service.
// Duplicate suppression: one waker per target time (older active waker wins; a hop ignores its parent), and the target
// is not dispatched while it is active or ran within `recentMs`. Every decision is written to the job summary;
// failures (API errors, dispatch not confirmed, too many hops, unknown statuses) fail the run (red X in Actions).
export const ACTIVE=new Set(['queued','in_progress','waiting','pending','requested']);
export const DEFAULTS=Object.freeze({maxSleepMs:330*60000,maxHops:3,recentMs:10*60000,lateLimitMs:180*60000,confirmMs:180000,pollMs:10000});
const JST=9*3600000;

// Next occurrence of hh:mm JST at or after now - graceMs (a waker started a little late still targets today's time).
export function nextTarget(nowMs,hhmm,graceMs=10*60000){
  const m=/^(\d{2}):(\d{2})$/.exec(hhmm||'');if(!m||+m[1]>23||+m[2]>59)throw Error(`invalid target time: ${hhmm}`);
  const day=nowMs-((nowMs+JST)%86400000);let t=day+(+m[1]*60+ +m[2])*60000;
  if(t<nowMs-graceMs)t+=86400000;
  return t;
}
export function parseTarget(iso,nowMs,{lateLimitMs=DEFAULTS.lateLimitMs}={}){
  const t=Date.parse(iso||'');if(!Number.isFinite(t))throw Error(`invalid target_iso: ${iso}`);
  if(t>nowMs+36*3600000)throw Error(`target too far ahead: ${iso}`);
  return t;
}
export function plan({now,target,hop=0,maxSleepMs=DEFAULTS.maxSleepMs,maxHops=DEFAULTS.maxHops,lateLimitMs=DEFAULTS.lateLimitMs}){
  const remaining=target-now;
  if(remaining<-lateLimitMs)return {action:'stale_target',lateMs:-remaining};
  if(remaining>maxSleepMs){
    if(hop>=maxHops)throw Error(`too many hops (${hop}) for a target ${Math.round(remaining/60000)} min ahead`);
    return {action:'hop',sleepMs:maxSleepMs};
  }
  return {action:'wait',sleepMs:Math.max(0,remaining)};
}
// Another active waker for the same target (older run id) already takes care of it; the parent of a hop is ignored.
export function duplicateWaker(runs,{selfId,parentId,targetIso}){
  return runs.find(r=>r.id!==selfId&&r.id!==parentId&&r.id<selfId&&ACTIVE.has(r.status)&&String(r.display_title||'').includes(targetIso))||null;
}
export function targetDecision(runs,now,{recentMs=DEFAULTS.recentMs}={}){
  for(const r of runs){
    if(ACTIVE.has(r.status))return {decision:'already_running',run:r.id};
    if(r.status!=='completed')throw Error(`unknown run status ${r.status} (run ${r.id}); not dispatching`);
  }
  const recent=runs.find(r=>now-Date.parse(r.run_started_at||r.created_at)<recentMs);
  if(recent)return {decision:'recent_run',run:recent.id};
  return {decision:'dispatch'};
}

export function github({token,repo,request=fetch}){
  if(!token)throw Error('GITHUB_TOKEN missing');
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo||''))throw Error(`invalid repository ${repo}`);
  const base=`https://api.github.com/repos/${repo}`;
  const headers={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'v8-wake-chain',Authorization:`Bearer ${token}`};
  const call=async(path,options={})=>{
    const res=await request(base+path,{...options,headers:{...headers,...(options.body?{'Content-Type':'application/json'}:{})},signal:AbortSignal.timeout(20000)});
    if(res.status===204)return null;
    if(!res.ok)throw Object.assign(Error(`GitHub ${options.method||'GET'} ${path.split('?')[0]} HTTP ${res.status}`),{status:res.status});
    return res.json();
  };
  return {
    runs:async(workflow,query='')=>{const p=await call(`/actions/workflows/${workflow}/runs?branch=main&per_page=50${query}`);if(!Array.isArray(p?.workflow_runs))throw Error('invalid runs response');return p.workflow_runs;},
    dispatch:async(workflow,inputs)=>call(`/actions/workflows/${workflow}/dispatches`,{method:'POST',body:JSON.stringify({ref:'main',...(inputs?{inputs}:{})})}),
    run:async id=>{if(!Number.isSafeInteger(Number(id)))throw Error(`invalid run id ${id}`);const r=await call(`/actions/runs/${Number(id)}`);if(!r||typeof r.status!=='string')throw Error('invalid run response');return r;}
  };
}

// Waits until a workflow_dispatch run of `workflow` created at/after `since` appears (dispatch confirmed).
export async function confirmDispatch(gh,workflow,since,{now=Date.now,sleep,confirmMs=DEFAULTS.confirmMs,pollMs=DEFAULTS.pollMs,match=()=>true}={}){
  const deadline=now()+confirmMs;
  while(true){
    // A failed or unreadable listing is "unknown", never "no run": it ends the confirmation (no re-dispatch).
    let runs;
    try{runs=await gh.runs(workflow,'&event=workflow_dispatch');}
    catch(e){throw Object.assign(Error(`dispatch of ${workflow} could not be confirmed: ${e?.message||e}`),{confirm:'unknown'});}
    const run=runs.find(r=>Date.parse(r.created_at)>=since-5000&&match(r));
    if(run)return run;
    if(now()>=deadline)throw Object.assign(Error(`dispatch of ${workflow} not confirmed within ${confirmMs/1000}s`),{confirm:'absent'});
    await sleep(pollMs);
  }
}

// Dispatch and confirm. A 5xx (or network error) answer can still have created the run (seen in DEV: HTTP 502 with
// the run created), so it is not retried blindly: first look for the run. Dispatch once more only when the run list
// was read successfully until the deadline and showed no such run ('absent'). A failed/invalid list read ('unknown')
// fails without another dispatch. 4xx answers to the dispatch fail at once. Returns {run, dispatch_errors}.
export async function dispatchConfirmed(gh,workflow,inputs,{now,sleep,confirmMs,pollMs,match=()=>true,attempts=2}){
  const errors=[];
  for(let i=1;i<=attempts;i++){
    const since=now();
    try{await gh.dispatch(workflow,inputs);}
    catch(e){if(e?.status&&e.status<500)throw e;errors.push(String(e?.message||e));}
    try{return {run:await confirmDispatch(gh,workflow,since,{now,sleep,confirmMs,pollMs,match}),dispatch_errors:errors};}
    catch(e){if(e?.confirm!=='absent'||i===attempts)throw Error(`${e.message}${errors.length?` (dispatch errors: ${errors.join('; ')})`:''}`);}
  }
}

export async function wake({gh,now=Date.now,sleep,log=console.log,self,target:targetIn,limits={}}){
  const L={...DEFAULTS,...limits};
  const {selfWorkflow,targetWorkflow,allowedTargets,selfId,parentId=null,hop=0,targetTime,targetIso,extraInputs={}}=self;
  if(!allowedTargets.includes(targetWorkflow))throw Error(`target workflow not allowed: ${targetWorkflow}`);
  const target=targetIso?parseTarget(targetIso,now(),L):nextTarget(now(),targetTime);
  const iso=new Date(target).toISOString();
  const out={target:iso,target_workflow:targetWorkflow,hop,run:selfId};
  const opts={now,sleep,confirmMs:L.confirmMs,pollMs:L.pollMs};
  const dispatchSelf=async(nextHop,result)=>{
    const {run,dispatch_errors}=await dispatchConfirmed(gh,selfWorkflow,{...extraInputs,target_iso:iso,target_workflow:targetWorkflow,hop:String(nextHop),parent_run_id:String(selfId)},
      {...opts,match:r=>r.id!==selfId&&String(r.display_title||'').includes(iso)});
    return {...out,result,next_run:run.id,...(dispatch_errors.length?{dispatch_errors}:{})};
  };
  // Started by schedule or by hand (no explicit target): hand over to a run whose title names the target, so that
  // wakers started from several sources can see each other and only the oldest one stays.
  if(!targetIso)return dispatchSelf(hop,'normalized');
  const dup=duplicateWaker(await gh.runs(selfWorkflow),{selfId,parentId,targetIso:iso});
  if(dup)return {...out,result:'duplicate_waker',other:dup.id};
  const p=plan({now:now(),target,hop,maxSleepMs:L.maxSleepMs,maxHops:L.maxHops,lateLimitMs:L.lateLimitMs});
  if(p.action==='stale_target')return {...out,result:'stale_target',late_min:Math.round(p.lateMs/60000)};
  log(`${p.action}: sleeping ${Math.round(p.sleepMs/1000)}s (target ${iso})`);
  await sleep(p.sleepMs);
  if(p.action==='hop')return dispatchSelf(hop+1,'hopped');
  // Re-check for a duplicate right before acting (another waker may have started while this one slept).
  const dup2=duplicateWaker(await gh.runs(selfWorkflow),{selfId,parentId,targetIso:iso});
  if(dup2)return {...out,result:'duplicate_waker',other:dup2.id};
  const d=targetDecision(await gh.runs(targetWorkflow),now(),L);
  if(d.decision!=='dispatch')return {...out,result:d.decision,target_run:d.run};
  const since=now();
  const {run,dispatch_errors}=await dispatchConfirmed(gh,targetWorkflow,undefined,opts);
  return {...out,result:'dispatched',target_run:run.id,dispatched_at:new Date(since).toISOString(),...(dispatch_errors.length?{dispatch_errors}:{})};
}

if(import.meta.url===`file://${process.argv[1]}`){
  const fs=await import('node:fs');const env=process.env;
  const summary=(text)=>{if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,text+'\n');};
  const self={selfWorkflow:env.WAKE_SELF_WORKFLOW,targetWorkflow:env.WAKE_TARGET_WORKFLOW,allowedTargets:(env.WAKE_ALLOWED_TARGETS||'').split(',').filter(Boolean),
    selfId:Number(env.GITHUB_RUN_ID),parentId:env.WAKE_PARENT_RUN_ID?Number(env.WAKE_PARENT_RUN_ID):null,hop:Number(env.WAKE_HOP||0),
    targetTime:env.WAKE_TARGET_TIME,targetIso:env.WAKE_TARGET_ISO||null,extraInputs:env.WAKE_MAX_SLEEP_MIN?{max_sleep_min:env.WAKE_MAX_SLEEP_MIN}:{}};
  const limits=env.WAKE_MAX_SLEEP_MIN?{maxSleepMs:Number(env.WAKE_MAX_SLEEP_MIN)*60000}:{};
  try{
    const gh=github({token:env.GITHUB_TOKEN,repo:env.GITHUB_REPOSITORY});
    const r=await wake({gh,sleep:ms=>new Promise(res=>setTimeout(res,ms)),self,limits});
    console.log(`::notice title=wake chain ${r.result}::${JSON.stringify(r)}`);summary(`### wake chain\n\n\`\`\`json\n${JSON.stringify(r,null,2)}\n\`\`\``);
  }catch(e){
    const msg=String(e?.message||e);console.log(`::error title=wake chain failed::${msg}`);summary(`### wake chain FAILED\n\n${msg}`);process.exit(1);
  }
}
