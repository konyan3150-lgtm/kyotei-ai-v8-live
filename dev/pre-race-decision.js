(function(){
  const MODES=['hit','balance','return'];
  function v8BuyForMode(r,rows,mode){
    if(!Array.isArray(rows)||rows.length<6||rows.some(x=>!Array.isArray(x.p)))return false;
    let details=[];try{details=v8ScoreDetails(r,rows,exhibitionScores(r))||[]}catch(e){return false}
    const coverage=details.length?Math.round(details.reduce((s,x)=>s+Number(x.coverage||0),0)/details.length):0;
    const ranked=rows.map(x=>Number(x.p?.[0]||0)).sort((a,b)=>b-a),top=ranked[0]||0,gap=top-(ranked[1]||0),picks=makeBets(rows,6,mode),hole=Number(picks[0]?.hole||0);
    if(mode==='hit')return coverage>=82&&top>=.62&&gap>=.25;
    if(mode==='balance')return coverage>=80&&top>=.55&&gap>=.18;
    return coverage>=80&&top>=.38&&hole>=.22;
  }
  function decisionFor(r,raceNo){
    if(typeof models==='undefined'||models.length!==3)return{state:'pending',value:false,v8:false};
    const oldRace=rno;let rows,value=false,v8=false;
    try{
      rno=String(raceNo);rows=predictionRowsForRace(r);
      v8=MODES.some(mode=>v8BuyForMode(r,rows,mode));
      if(typeof valueAssessmentForMode==='function')value=MODES.some(mode=>{const x=valueAssessmentForMode(mode,rows);return x?.available&&Array.isArray(x.picks)&&x.picks.length>0});
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
      if(hasOfficialResult(r)||Number.isFinite(close)&&close<=now)return;
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
  try{if(D&&sid)draw()}catch(e){}
})();
