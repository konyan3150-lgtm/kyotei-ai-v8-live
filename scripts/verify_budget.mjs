// Time budget for per-race official result verification.
// Each race is checked one by one against the official site. After an outage many races are pending at once;
// without a budget the job hits its timeout and commits nothing, so the next run faces the same backlog.
// With a budget, races verified so far are saved through the normal checks and atomic write, and the rest
// stay pending (never treated as a miss) for the next run.
export const MAX_FETCH_TIMEOUT_MS=15000,MIN_FETCH_TIMEOUT_MS=1000,RETRY_DELAY_MS=250,FETCH_ATTEMPTS=2;
// Smallest remaining time that can hold every attempt at the minimum timeout plus the retry waits.
export const MIN_START_MS=FETCH_ATTEMPTS*MIN_FETCH_TIMEOUT_MS+(FETCH_ATTEMPTS-1)*RETRY_DELAY_MS;

// Explicit "unlimited" is the only way to disable the budget. Missing values use the default;
// a wrong value (0, negative, not a number) also falls back to the default instead of becoming unlimited.
export function parseBudgetMs(raw,defaultMs){
  if(!(Number.isFinite(defaultMs)&&defaultMs>0))throw Error('A positive default verification budget is required');
  if(raw===undefined||raw===null||String(raw).trim()==='')return {ms:defaultMs,source:'default'};
  if(raw===Infinity||/^(unlimited|infinity)$/i.test(String(raw).trim()))return {ms:Infinity,source:'unlimited'};
  const n=Number(String(raw).trim());
  if(Number.isFinite(n)&&n>0)return {ms:n,source:'configured'};
  return {ms:defaultMs,source:'invalid_fallback',invalid:String(raw)};
}

// Start the queue at a different place each run so a few slow failures at the head cannot use up every
// run's budget; over several runs every pending race gets its turn. The run time is mixed with an integer
// hash so fixed schedules (every 6 minutes, hourly at :17) do not repeat the same start for common queue sizes.
export function rotationOffset(runMs,length){
  if(!(length>0))return 0;
  let h=Math.floor(Number(runMs)/1000)>>>0;
  h=Math.imul(h^(h>>>16),0x45d9f3b)>>>0;h=Math.imul(h^(h>>>16),0x45d9f3b)>>>0;h=(h^(h>>>16))>>>0;
  return h%length;
}
export function rotate(list,runMs){
  const offset=rotationOffset(runMs,list.length);
  return [...list.slice(offset),...list.slice(0,offset)];
}

export function verifyBudget({budgetMs,defaultMs=300000,clock=()=>Date.now()}={}){
  const parsed=parseBudgetMs(budgetMs,defaultMs),limit=parsed.ms,start=clock();
  if(parsed.source==='invalid_fallback')console.warn(`Invalid VERIFY_BUDGET_MS "${parsed.invalid}"; using the default ${defaultMs} ms`);
  let deferred=0,attempts=0;const outcomes={};
  const remainingMs=()=>limit-(clock()-start);
  return {
    // Checked before each new fetch; a fetch is only started when all of its attempts fit in the time left.
    allow(){if(remainingMs()>=MIN_START_MS){attempts++;return true;}deferred++;return false;},
    // Per-attempt timeout: all attempts plus the retry waits end within the remaining time (checked by allow()).
    fetchTimeoutMs(){const r=remainingMs();return Number.isFinite(r)?Math.max(MIN_FETCH_TIMEOUT_MS,Math.min(MAX_FETCH_TIMEOUT_MS,Math.floor((r-(FETCH_ATTEMPTS-1)*RETRY_DELAY_MS)/FETCH_ATTEMPTS))):MAX_FETCH_TIMEOUT_MS;},
    note(kind){outcomes[kind]=(outcomes[kind]||0)+1;},
    remainingMs,
    summary(){return {limit_ms:Number.isFinite(limit)?limit:null,limit_source:parsed.source,elapsed_ms:clock()-start,attempts,deferred_by_time_budget:deferred,outcomes:{...outcomes}};},
    get deferred(){return deferred;},
    get attempts(){return attempts;},
    get limitMs(){return limit;}
  };
}
