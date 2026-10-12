// Time budget for per-race official result verification.
// Each race is checked one by one against the official site. After an outage many races are pending at once;
// without a budget the job hits its timeout and commits nothing, so the next run faces the same backlog.
// With a budget, races verified so far are saved through the normal checks and atomic write, and the rest
// stay pending (never treated as a miss) for the next run.
export const MAX_FETCH_TIMEOUT_MS=15000,MIN_FETCH_TIMEOUT_MS=1000;
export function verifyBudget({budgetMs,clock=()=>Date.now()}={}){
  const limit=Number.isFinite(Number(budgetMs))&&Number(budgetMs)>0?Number(budgetMs):Infinity,start=clock();
  let deferred=0,attempts=0;const outcomes={};
  const remainingMs=()=>limit-(clock()-start);
  return {
    // Checked before each new fetch; a fetch is only started with at least the minimum timeout left.
    allow(){if(remainingMs()>=MIN_FETCH_TIMEOUT_MS){attempts++;return true;}deferred++;return false;},
    // Per-attempt fetch timeout (two attempts) that keeps a started fetch inside the remaining time.
    fetchTimeoutMs(){const r=remainingMs();return Number.isFinite(r)?Math.max(MIN_FETCH_TIMEOUT_MS,Math.min(MAX_FETCH_TIMEOUT_MS,Math.floor(r/2))):MAX_FETCH_TIMEOUT_MS;},
    note(kind){outcomes[kind]=(outcomes[kind]||0)+1;},
    remainingMs,
    summary(){return {limit_ms:Number.isFinite(limit)?limit:null,elapsed_ms:clock()-start,attempts,deferred_by_time_budget:deferred,outcomes:{...outcomes}};},
    get deferred(){return deferred;},
    get attempts(){return attempts;},
    get limitMs(){return limit;}
  };
}
