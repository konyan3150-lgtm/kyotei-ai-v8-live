(function(){
  const MODES=['hit','balance','return'];
  function decisionFor(r,raceNo){
    if(typeof models==='undefined'||models.length!==3)return{state:'pending',value:false,v8:false};
    const oldRace=rno;let rows,value=false,v8=false;
    try{
      rno=String(raceNo);rows=predictionRowsForRace(r);
      if(typeof purchaseRecommendationsForRace!=='function')return{state:'pending',value:false,v8:false};
      const recs=purchaseRecommendationsForRace(r,rows),valueMode=MODES.includes(valuePredictionMode)?valuePredictionMode:'hit',baseMode=MODES.includes(basePredictionMode)?basePredictionMode:'hit';
      value=recs?.value?.[valueMode]?.level==='buy';
      v8=recs?.base?.[baseMode]?.level==='buy';
    }catch(e){return{state:'pending',value:false,v8:false}}
    finally{rno=oldRace}
    return{state:value||v8?'buy':'skip',value,v8};
  }
  function badgeHtml(d,soon){
    if(d.state!=='buy')return'';
    return `<span class="predecision buy">${d.value?'<i class="value">期</i>':''}${d.v8?'<i class="v8">V</i>':''}</span>`;
  }
  function decorate(){
    const venue=D?.programs?.stadiums?.[sid],sc=document.getElementById('raceScroll');if(!venue||!sc)return;
    const races=Object.entries(venue.races||{}).sort((a,b)=>Number(a[0])-Number(b[0])),buttons=[...sc.querySelectorAll('.racechip')],now=Date.now();
    races.forEach(([raceNo,r],i)=>{
      const b=buttons[i],close=raceCloseMs(r);if(!b)return;
      b.querySelector('.predecision')?.remove();
      b.classList.remove('race-buy','race-skip','race-decision-pending');
      if(typeof isRaceCancelled==='function'&&isRaceCancelled(r,venue.races)||hasOfficialResult(r)||Number.isFinite(close)&&close<=now)return;
      b.querySelector('.racebadge.close')?.remove();
      const d=decisionFor(r,raceNo),soon=Number.isFinite(close)&&close-now<=15*60*1000;
      b.classList.add(d.state==='buy'?'race-buy':d.state==='skip'?'race-skip':'race-decision-pending');
      const badge=badgeHtml(d,soon);if(badge)b.insertAdjacentHTML('beforeend',badge);
      b.setAttribute('aria-label',`${raceNo}R ${time(r)} ${d.state==='buy'?'買い候補':d.state==='skip'?'見送り':'判定待ち'}${soon?' 締切間近':''}`);
    });
  }
  const baseDraw=draw;
  draw=function(){baseDraw();decorate()};
  window.preRaceDecisionFor=decisionFor;
  window.refreshPreRaceDecisions=decorate;
  try{if(D&&sid)draw()}catch(e){}
})();
