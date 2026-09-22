let techniqueStatsData=null;
let techniqueCorrectionActive=false;

function techniqueVenueName(){return modelPlace?.[sid]||N?.[sid]||String(sid||'')}
function techniqueWindBand(v){v=Number(v||0);return v<=0?'0m':v<=2?'1〜2m':v<=4?'3〜4m':'5m以上'}
function techniqueWaveBand(v){v=Number(v||0);return v<=2?'0〜2cm':v<=5?'3〜5cm':'6cm以上'}
function techniqueMix(r){
  const d=techniqueStatsData;if(!d)return null;
  const venue=d.venues?.[techniqueVenueName()],preview=r?.preview||{},wind=d.wind?.[techniqueWindBand(preview.wind_speed)],wave=d.wave?.[techniqueWaveBand(preview.wave_height)],parts=[[d.national,.15],[venue,.55],[wind,.2],[wave,.1]].filter(([x])=>x?.r);
  const total=parts.reduce((s,[,w])=>s+w,0),rates=d.techniques.map((_,i)=>parts.reduce((s,[x,w])=>s+Number(x.r[i]||0)*w,0)/total);
  return rates.map((rate,i)=>({name:d.techniques[i],rate})).sort((a,b)=>b.rate-a.rate);
}
function techniqueBoatSignal(r,k,x){
  const d=techniqueStatsData,mix=techniqueMix(r);if(!d||!mix?.length)return null;
  const course=String(typeof currentCourse==='function'?currentCourse(r,k):racePreviewCourse(k)),venue=d.venues?.[techniqueVenueName()],courseStat=venue?.courses?.[course]||d.courses?.[course],player=d.players?.[String(x?.number)];
  let topIndex=Number(courseStat?.[3]),share=Number(courseStat?.[4]),starts=Number(courseStat?.[0]||0),wins=Number(courseStat?.[1]||0),source='会場×コース';
  const playerCourse=player?.[4]?.[course];
  if(playerCourse&&Number(playerCourse[0])>=6&&Number(playerCourse[1])>=3){topIndex=Number(playerCourse[3]);share=Number(playerCourse[4]);starts=Number(playerCourse[0]);wins=Number(playerCourse[1]);source='選手×コース'}
  else if(player&&Number(player[2])>=20&&Number(player[3])>=3){topIndex=Number(player[0]);share=Number(player[1]);starts=Number(player[2]);wins=Number(player[3]);source='選手全体'}
  if(!Number.isInteger(topIndex)||topIndex<0||topIndex>=d.techniques.length)return null;
  const raceRate=Number(mix.find(v=>v.name===d.techniques[topIndex])?.rate),nationalRate=Number(d.national?.r?.[topIndex]);
  if(!Number.isFinite(raceRate)||!Number.isFinite(nationalRate)||nationalRate<=0)return null;
  const sampleReliability=Math.min(1,Math.sqrt(Math.max(1,wins)/12)),styleReliability=Math.max(.2,Math.min(1,share/65)),reliability=sampleReliability*styleReliability;
  const relative=Math.max(.7,Math.min(1.3,raceRate/nationalRate)),raw=(relative-1)*reliability;
  return{factor:Math.max(.96,Math.min(1.04,Math.exp(raw*.18))),score:50+raw*125,technique:d.techniques[topIndex],share,starts,wins,source,course,raceRate,reliability};
}

const preTechniqueProbs=probs;
probs=function(r,k,x){
  const base=preTechniqueProbs(r,k,x),signal=techniqueBoatSignal(r,k,x);if(!signal)return base;
  const factors=[signal.factor,Math.sqrt(signal.factor),Math.pow(signal.factor,.35)];
  if(Math.abs(signal.factor-1)>.0001)techniqueCorrectionActive=true;
  return base.map((value,index)=>Math.max(1e-6,Math.min(.999999,value*factors[index])));
};
function racePreviewCourse(k){const raceObj=D?.programs?.stadiums?.[sid]?.races?.[rno];return raceObj?.preview?.racers?.[String(k)]?.course_number||k}
function techniquePlayerRow(k,x){
  const d=techniqueStatsData,p=d?.players?.[String(x?.number)],course=String(racePreviewCourse(k));
  if(!p)return`<tr><td><span class="lanechip l${k}">${k}</span></td><td>${q(x?.name,'--')}</td><td>データ待ち</td><td>--</td></tr>`;
  if(Number(p[3]||0)===0)return`<tr><td><span class="lanechip l${k}">${k}</span></td><td class="name">${q(x?.name,'--')}</td><td>勝利データなし<small>全体 ${p[2]}走</small></td><td>--</td></tr>`;
  const cp=p[4]?.[course],useCourse=cp&&cp[0]>=6&&cp[1]>=3,topIndex=useCourse?cp[3]:p[0],share=useCourse?cp[4]:p[1],sample=useCourse?`${course}C ${cp[0]}走・${cp[1]}勝`:`全体 ${p[2]}走・${p[3]}勝`;
  return`<tr><td><span class="lanechip l${k}">${k}</span></td><td class="name">${q(x?.name,'--')}</td><td><b>${d.techniques[topIndex]||'--'}</b><small>${sample}</small></td><td>${Number(share||0).toFixed(1)}%</td></tr>`
}
function renderTechniqueTraits(r){
  const el=document.getElementById('techniqueTraits'),diag=document.getElementById('techniqueDiag'),d=techniqueStatsData;if(!el)return;
  if(!d){el.textContent='決まり手データ待ち';if(diag)diag.textContent='決まり手傾向：取得待ち';return}
  const mix=techniqueMix(r),top=mix?.slice(0,3)||[],venue=d.venues?.[techniqueVenueName()],rows=Object.entries(r?.racers||{}).sort((a,b)=>+a[0]-+b[0]);
  el.innerHTML=`<div class="techniquelead"><small>今回の想定</small><div class="techniquechips">${top.map((x,i)=>`<span class="techniquechip rank${i+1}"><b>${x.name}</b>${x.rate.toFixed(1)}%</span>`).join('')}</div><div class="techniquenote">${techniqueVenueName()}＋風${q(r?.preview?.wind_speed,0)}m＋波${q(r?.preview?.wave_height,0)}cmの過去傾向｜選手×コースを優先してV8へ最大±4%補正</div></div><div class="tablewrap"><table class="data techniquetable"><thead><tr><th>枠</th><th>選手</th><th>勝ちパターン</th><th>勝利内</th></tr></thead><tbody>${rows.map(([k,x])=>techniquePlayerRow(k,x)).join('')}</tbody></table></div>`;
  if(diag)diag.textContent=`✓ 決まり手取得OK｜${Number(d.source.races).toLocaleString()}R｜V8決まり手補正${techniqueCorrectionActive?'適用中':'待機'}`;
}

async function loadTechniqueStats(){
  const diag=document.getElementById('techniqueDiag');
  try{if(diag)diag.textContent='決まり手傾向：学習データ取得中…';const res=await fetch('technique-stats.json?v=151');if(!res.ok)throw new Error('HTTP '+res.status);const data=await res.json();if(data?.schema!=='kyotei-technique-stats'||!data.venues)throw new Error('データ形式不一致');techniqueStatsData=data;if(D&&sid){if(typeof autoSaveAllPredictions==='function')autoSaveAllPredictions();draw()}}catch(e){techniqueStatsData=null;if(diag)diag.textContent='決まり手傾向：取得待ち｜'+e.message}
}

const preTechniqueRace=race;
race=function(r){techniqueCorrectionActive=false;preTechniqueRace(r);renderTechniqueTraits(r)};
loadTechniqueStats();
