let venueStatsData=null;
let venueCorrectionActive=false;

function venueName(){return modelPlace?.[sid]||N?.[sid]||String(sid||'')}
function venueRecord(){return venueStatsData?.venues?.[venueName()]||null}
function venueFactorParts(r,k){
  const venue=venueRecord(),lane=String(k);
  if(!venue?.lanes?.[lane])return null;
  const ds=String(r?.date||day()).replace(/-/g,''),month=String(Number(ds.slice(4,6))),raceNo=String(Number(rno||r?.number||0));
  const base=venue.lanes[lane],monthPart=venue.months?.[month]?.factors?.[lane],racePart=venue.raceNumbers?.[raceNo]?.factors?.[lane];
  return [1,2,3].map(rank=>{const key=`f${rank}`,b=Number(base[key]||1),m=Number(monthPart?.[key]||1),q=Number(racePart?.[key]||1);return Math.max(.95,Math.min(1.05,b*Math.pow(m,.35)*Math.pow(q,.35)))})
}
function venueScoreForLane(r,k){const lane=venueRecord()?.lanes?.[String(k)];if(!lane)return NaN;return Number(lane.p1)*.5+Number(lane.p2)*.3+Number(lane.p3)*.2}

const preVenueProbs=probs;
probs=function(r,k,x){const base=preVenueProbs(r,k,x),factors=venueFactorParts(r,k);if(!factors)return base;if(factors.some(v=>Math.abs(v-1)>.0001))venueCorrectionActive=true;return base.map((value,index)=>Math.max(1e-6,Math.min(.999999,value*factors[index]))) };

function renderVenueTraits(){
  const el=document.getElementById('venueTraits'),diag=document.getElementById('venueDiag'),venue=venueRecord(),name=venueName();
  if(!el)return;
  if(!venue){el.textContent='会場特性データ待ち';if(diag)diag.textContent=`会場特性：${name}のデータ待ち`;return}
  el.innerHTML=`<div class="venueprofile"><div><small>会場</small><b>${name}</b></div><div><small>傾向</small><b>${venue.bias}</b></div><div><small>1号艇勝率</small><b>${Number(venue.lane1Win).toFixed(1)}%</b></div><div><small>4〜6号艇勝率</small><b>${Number(venue.outsideWin).toFixed(1)}%</b></div></div><div class="venuenote">過去${Number(venue.races).toLocaleString()}R｜会場×枠・月・レース番号を全国平均との差で補正（最大±5%）</div>`;
  if(diag)diag.textContent=`✓ 会場特性取得OK｜${name} ${Number(venue.races).toLocaleString()}R｜V8会場補正${venueCorrectionActive?'適用中':'待機'}`
}

async function loadVenueStats(){
  const diag=document.getElementById('venueDiag');
  try{if(diag)diag.textContent='会場特性：学習データ取得中…';const res=await fetch(`venue-stats.json?v=86&x=${Date.now()}`,{cache:'no-store'});if(!res.ok)throw new Error('HTTP '+res.status);const data=await res.json();if(data?.schema!=='kyotei-venue-stats'||!data.venues)throw new Error('データ形式不一致');venueStatsData=data;if(D&&sid){if(typeof autoSaveAllPredictions==='function')autoSaveAllPredictions();draw()}else renderVenueTraits()}catch(e){venueStatsData=null;if(diag)diag.textContent='会場特性：取得待ち｜'+e.message}}

const preVenueRace=race;
race=function(r){venueCorrectionActive=false;preVenueRace(r);renderVenueTraits()};
loadVenueStats();
