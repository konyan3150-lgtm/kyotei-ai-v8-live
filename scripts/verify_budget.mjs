// Time budget for per-race official result verification.
// Each race is checked one by one against the official site. After an outage many races are pending at once;
// without a budget the job hits its timeout and commits nothing, so the next run faces the same backlog.
// With a budget, races verified so far are saved and the rest stay pending for the next run.
export function verifyBudget({budgetMs,clock=()=>Date.now()}={}){
  const limit=Number.isFinite(Number(budgetMs))&&Number(budgetMs)>0?Number(budgetMs):Infinity,start=clock();
  let deferred=0;
  return {
    allow(){if(clock()-start<limit)return true;deferred++;return false;},
    get deferred(){return deferred;},
    get limitMs(){return limit;}
  };
}
