(function(){
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const num=v=>v==null||v===''?NaN:Number(v);
  function previewFor(r,k){return typeof mergeOriginalEx==='function'?mergeOriginalEx(r,String(k)):(r?.preview?.racers?.[String(k)]||{})}
  function previousWeight(r,k){
    const racer=r?.racers?.[String(k)],number=String(racer?.number||'');
    if(!number||!D?.programs?.stadiums?.[sid]?.races)return null;
    const currentClose=typeof raceCloseMs==='function'?raceCloseMs(r):NaN,candidates=[];
    for(const [raceNo,race] of Object.entries(D.programs.stadiums[sid].races||{})){
      if(String(raceNo)===String(rno))continue;
      const close=typeof raceCloseMs==='function'?raceCloseMs(race):NaN;
      if(Number.isFinite(currentClose)&&Number.isFinite(close)&&close>=currentClose)continue;
      for(const [lane,boat] of Object.entries(race?.racers||{})){
        if(String(boat?.number||'')!==number)continue;
        const weight=num(race?.preview?.racers?.[lane]?.weight);
        if(Number.isFinite(weight))candidates.push({close:Number.isFinite(close)?close:Number(raceNo),weight,raceNo});
      }
    }
    candidates.sort((a,b)=>b.close-a.close);return candidates[0]||null;
  }
  function partsText(pr){
    const parts=Array.isArray(pr?.parts)?pr.parts:[],names=parts.map(x=>String(x?.number_source||x?.name||'部品').trim()).filter(Boolean);
    if(pr?.propeller)names.push(`プロペラ${pr.propeller}`);
    return names.length?[...new Set(names)].join('・'):'なし';
  }
  function boatLiveInfo(r,k){
    const lane=Number(k),pr=previewFor(r,k),course=num(pr.course_number),currentWeight=num(pr.weight),prior=previousWeight(r,k),weightDelta=prior&&Number.isFinite(currentWeight)?currentWeight-prior.weight:NaN,tilt=num(pr.tilt_adjustment),parts=partsText(pr);
    return{lane,course,currentWeight,priorWeight:prior?.weight,weightDelta,tilt,parts,changed:Number.isFinite(course)&&course!==lane,preview:pr};
  }
  function windInfo(r){const p=r?.preview||{},speed=num(p.wind_speed),direction=String(p.wind_direction_number_source||p.wind_direction_source||p.wind_direction||'').trim(),level=!Number.isFinite(speed)?'取得待ち':speed>=5?'大':speed>=3?'中':'小';return{speed,direction:direction||'--',level}}
  function factorFor(r,k){
    const info=boatLiveInfo(r,k),wind=windInfo(r);let course=1,weight=1,tilt=1,parts=1,windFactor=1;
    if(Number.isFinite(info.course))course=clamp(1+(info.lane-info.course)*.012,.96,1.04);
    if(Number.isFinite(info.weightDelta))weight=clamp(1-info.weightDelta*.004,.99,1.01);
    if(Number.isFinite(info.tilt)&&info.tilt!==0){const outer=(Number.isFinite(info.course)?info.course:info.lane)>=4;tilt=clamp(1+(outer?info.tilt:-Math.max(info.tilt,0))*.006,.99,1.01)}
    if(info.parts!=='なし')parts=.995;
    if(Number.isFinite(wind.speed)&&wind.speed>=3){const c=Number.isFinite(info.course)?info.course:info.lane;windFactor=clamp(1+(3.5-c)*(wind.speed-2)*.0015,.985,1.015)}
    return{factor:clamp(course*weight*tilt*parts*windFactor,.94,1.06),course,weight,tilt,parts,wind:windFactor,info};
  }
  window.liveConditionFactors=(r,rows)=>rows.map(z=>factorFor(r,z.k).factor);
  window.liveConditionScore=(r,k)=>clamp((factorFor(r,k).factor-.94)/.12*100,0,100);
  window.boatLiveInfo=boatLiveInfo;
  window.renderLiveConditions=function(r,rows){
    const el=document.getElementById('liveChanges');if(!el)return;
    const infos=rows.map(z=>boatLiveInfo(r,z.k)),wind=windInfo(r),courseChanges=infos.filter(x=>x.changed),partChanges=infos.filter(x=>x.parts!=='なし'),tilts=infos.filter(x=>Number.isFinite(x.tilt)&&x.tilt!==0),weights=infos.filter(x=>Number.isFinite(x.weightDelta)&&Math.abs(x.weightDelta)>=.05);
    const courseText=courseChanges.length?courseChanges.map(x=>`${x.lane}号艇 ${x.lane}→${x.course}`).join('、'):'枠なり',partText=partChanges.length?partChanges.map(x=>`${x.lane}号艇 ${x.parts}`).join('、'):'交換なし',tiltText=tilts.length?tilts.map(x=>`${x.lane}号艇 ${x.tilt>0?'+':''}${x.tilt}`).join('、'):'変更なし',weightText=weights.length?weights.map(x=>`${x.lane}号艇 ${x.weightDelta>0?'+':''}${x.weightDelta.toFixed(1)}kg`).join('、'):'前走比なし';
    el.innerHTML=`<div class="livechange"><small>展示進入</small><b>${courseText}</b></div><div class="livechange"><small>部品・プロペラ</small><b>${partText}</b></div><div class="livechange"><small>チルト</small><b>${tiltText}</b></div><div class="livechange"><small>前走体重比</small><b>${weightText}</b></div><div class="livewind"><span>風向×1M影響</span><b>${wind.direction} ${Number.isFinite(wind.speed)?wind.speed+'m':'--'}｜影響 ${wind.level}</b></div>`;
  };
})();
