(function(){
  const PREFIX='kyotei_v8_result_';
  const MODES=['hit','balance','return'];
  const LABELS={hit:'的中重視',balance:'バランス',return:'回収重視'};
  const LEVELS={buy:'購入推奨',caution:'注意',skip:'見送り',none:'判定なし'};
  const pct=v=>(Number(v||0)*100).toFixed(1)+'%';

  function assess(r,rows,mode){
    if(!Array.isArray(rows)||rows.length<6||rows.some(x=>!Array.isArray(x.p)))return{level:'none',score:0,reasons:['V8計算データが不足しています']};
    let details=[];try{details=v8ScoreDetails(r,rows,exhibitionScores(r))||[]}catch(e){}
    const coverage=details.length?Math.round(details.reduce((s,x)=>s+Number(x.coverage||0),0)/details.length):0;
    const ranked=rows.map(x=>Number(x.p?.[0]||0)).sort((a,b)=>b-a),top=ranked[0]||0,gap=top-(ranked[1]||0);
    const picks=makeBets(rows,6,mode),hole=Number(picks[0]?.hole||0);
    let level='skip',score=0;
    if(mode==='hit'){
      score=Math.round(Math.min(100,top*58+gap*85+coverage*.32));
      if(coverage>=72&&top>=.48&&gap>=.14)level='buy';
      else if(coverage>=62&&top>=.36&&gap>=.07)level='caution';
    }else if(mode==='balance'){
      score=Math.round(Math.min(100,top*52+gap*72+coverage*.36));
      if(coverage>=72&&top>=.41&&gap>=.10)level='buy';
      else if(coverage>=62&&top>=.32&&gap>=.05)level='caution';
    }else{
      score=Math.round(Math.min(100,hole*80+top*34+coverage*.45));
      if(coverage>=72&&top>=.30&&hole>=.16)level='buy';
      else if(coverage>=62&&top>=.24&&hole>=.09)level='caution';
    }
    if(coverage<55)level='skip';
    const reasons=[`1着最上位 ${pct(top)}・2位との差 ${pct(gap)}`,`情報充足度 ${coverage}%`];
    if(mode==='return')reasons.push(`V8穴度 ${(hole*100).toFixed(0)}%（オッズ未反映）`);
    if(coverage<72)reasons.push('不足データがあるため判定を抑えています');
    return{level,score,coverage,top,gap,hole,reasons,created_at:new Date().toISOString()}
  }

  function allAssessments(r,rows){return Object.fromEntries(MODES.map(m=>[m,assess(r,rows,m)]))}
  function openForSaving(r){if(hasOfficialResult(r))return false;const close=typeof raceCloseMs==='function'?raceCloseMs(r):NaN;return !Number.isFinite(close)||close>Date.now()}
  function saveAssessments(r,rows,recs){
    if(!openForSaving(r))return false;
    const key=resultStoreKey();let rec;try{rec=JSON.parse(localStorage.getItem(key)||'null')}catch(e){return false}
    if(!rec||rec.settled)return false;
    rec.recommendations=recs;rec.recommendation_version=1;
    try{localStorage.setItem(key,JSON.stringify(rec));return true}catch(e){return false}
  }

  function storedAssessments(){let rec;try{rec=JSON.parse(localStorage.getItem(resultStoreKey())||'null')}catch(e){}return rec?.recommendations||null}
  function recommendedStats(mode){
    let races=0,hits=0,invest=0,payout=0;
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(!key?.startsWith(PREFIX))continue;let rec;try{rec=JSON.parse(localStorage.getItem(key)||'null')}catch(e){continue}
      if(rec?.recommendations?.[mode]?.level!=='buy')continue;
      const data=rec?.modes?.[mode]||((rec?.mode||'hit')===mode?rec:null);if(!data?.settled)continue;
      races++;if(data.hit)hits++;invest+=Number(data.stake||0);payout+=Number(data.payout||0)
    }
    return{races,hits,hitRate:races?hits/races*100:0,roi:invest?payout/invest*100:0}
  }

  function ensureBox(){
    let box=document.getElementById('recommendationBox');if(box)return box;
    const bets=document.getElementById('bets');if(!bets)return null;
    box=document.createElement('div');box.id='recommendationBox';box.className='recommendation-box';bets.insertAdjacentElement('beforebegin',box);return box
  }
  function renderRecommendation(r,rows){
    const box=ensureBox();if(!box)return;
    let recs=allAssessments(r,rows),isOpen=openForSaving(r),saved=storedAssessments();
    if(!isOpen){if(saved)recs=saved;else recs=Object.fromEntries(MODES.map(m=>[m,{level:'none',score:0,reasons:['締切前の判定記録がありません']}]))}
    const current=recs[predictionMode]||recs.hit,stats=recommendedStats(predictionMode);
    const chips=MODES.map(m=>`<div class="recommend-chip ${m===predictionMode?'active':''} ${recs[m]?.level||'none'}"><span>${LABELS[m]}</span><b>${LEVELS[recs[m]?.level]||'判定なし'}</b></div>`).join('');
    const statText=stats.races?`購入推奨のみ：${stats.races}R・的中率 ${stats.hitRate.toFixed(1)}%・回収率 ${stats.roi.toFixed(1)}%`:'購入推奨の確定実績は、これから蓄積されます';
    box.innerHTML=`<div class="recommend-title"><span>V8 購入判断</span><strong class="${current.level}">${LEVELS[current.level]||'判定なし'}</strong></div><div class="recommend-chips">${chips}</div><div class="recommend-score">判定指数 <b>${Number(current.score||0)}</b>/100</div><ul>${(current.reasons||[]).map(x=>`<li>${String(x)}</li>`).join('')}</ul><div class="recommend-stats">${statText}</div>`
  }

  const baseSave=savePredictionSnapshot;
  savePredictionSnapshot=function(r,rows){const result=baseSave(r,rows);if(openForSaving(r)&&models.length===3&&rows?.length===6)saveAssessments(r,rows,allAssessments(r,rows));return result};
  const baseRace=race;
  race=function(r){baseRace(r);try{renderRecommendation(r,predictionRowsForRace(r))}catch(e){const box=ensureBox();if(box)box.textContent='購入判断を計算できません'} };
})();
