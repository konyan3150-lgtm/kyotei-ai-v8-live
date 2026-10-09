(function(){
  window.v8ValueRecordState=function(rec,mode){
    if(rec?.cancelled)return {kind:'cancelled',reason:'開催中止のため購入対象外です'};
    const m=rec?.value_modes?.[mode];
    if(!m)return {kind:'missing',reason:'締切前の期待値保存記録がありません'};
    if(Array.isArray(m.picks)&&m.picks.length)return {kind:'ready'};
    if(rec.odds_snapshot_at)return {kind:'skipped',reason:'保存時の期待値基準を満たす買い目がなく、見送りでした'};
    return {kind:'unavailable',reason:'保存時のオッズが未取得のため、期待値の買い目を作成できませんでした'};
  };
  window.v8SavedValueRecommendations=function(rec){
    if(!rec)return null;
    return Object.fromEntries(['hit','balance','return'].map(mode=>{
      const state=window.v8ValueRecordState(rec,mode),saved=rec.recommendations?.[mode];
      return [mode,state.kind==='ready'?(saved||{level:'none',score:0,reasons:['締切前の購入判断記録がありません']}):{level:state.kind==='skipped'?'skip':'none',score:0,reasons:[state.reason]}];
    }));
  };
})();
