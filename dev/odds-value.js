(function(){
  const PREFIX='kyotei_v8_dev_result_';
  const EV_THRESHOLDS={hit:1.00,balance:1.08,return:1.15};
  const POOL_LIMITS={hit:20,balance:40,return:120};
  const MAX_PICKS=4;
  const SAFETY_FACTOR=.75;
  let oddsPayload=null,oddsStatus='loading';

  function currentOdds(){
    if(!oddsPayload||String(oddsPayload.date)!==String(day()))return null;
    return oddsPayload.races?.[String(sid)]?.[String(rno)]||null
  }
  function oddsFor(record,combo){const [a,b,c]=String(combo).split('-');return Number(record?.trifecta?.[a]?.[b]?.[c]||0)}
  function valueCandidates(rows,mode){
    const record=currentOdds(),threshold=EV_THRESHOLDS[mode]||1.15;
    if(!record)return{available:false,status:oddsStatus,threshold,picks:[],record:null};
    const all=makeBets(rows,120,'hit').map(x=>{const odds=oddsFor(record,x.combo),prob=Number(x.share||0),safeProb=prob*SAFETY_FACTOR;return{...x,prob,safeProb,odds,ev:safeProb*odds}}).filter(x=>x.odds>0&&x.prob>=.002);
    const pool=all.sort((a,b)=>b.prob-a.prob).slice(0,POOL_LIMITS[mode]||120);
    const qualified=pool.filter(x=>x.ev>=threshold);
    qualified.sort(mode==='hit'?(a,b)=>b.prob-a.prob:mode==='balance'?(a,b)=>(b.ev*Math.sqrt(b.prob))-(a.ev*Math.sqrt(a.prob)):(a,b)=>b.ev-a.ev);
    return{available:true,status:'ok',threshold,picks:qualified.slice(0,MAX_PICKS),record}
  }
  window.valueAssessmentForMode=function(mode,rows){return valueCandidates(rows,mode)};

  function renderValueBets(rows){
    const el=document.getElementById('bets');if(!el)return;
    const value=valueCandidates(rows,predictionMode);
    if(!value.available){baseRenderBets(rows);const note=document.createElement('div');note.className='odds-wait';note.textContent=oddsStatus==='loading'?'3連単オッズ取得中…':'3連単オッズ未取得｜通常のV8買い目を表示';el.prepend(note);return}
    const updated=value.record?.fetched_at?new Date(value.record.fetched_at).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'}):'--:--';
    if(!value.picks.length){el.innerHTML=`<div class="odds-head">期待値判定 <b>見送り</b><span>オッズ ${updated}更新</span></div><div class="value-empty">基準EV ${value.threshold.toFixed(2)}以上の買い目がありません。</div>`;return}
    el.innerHTML=`<div class="odds-head">期待値買い目 <b>${value.picks.length}点</b><span>オッズ ${updated}更新</span></div><table class="bettable value-table"><thead><tr><th>組番</th><th>V8確率</th><th>オッズ</th><th>EV</th></tr></thead><tbody>${value.picks.map(x=>`<tr><td>${x.combo}</td><td>${(x.safeProb*100).toFixed(1)}%</td><td>${x.odds.toFixed(1)}</td><td class="${x.ev>=1.15?'ev-high':''}">${x.ev.toFixed(2)}</td></tr>`).join('')}</tbody></table><div class="value-note">確率は安全率75%で計算｜1点100円｜最大4点</div>`
  }

  const baseRenderBets=renderBets;
  renderBets=function(rows){renderValueBets(rows)};

  function saveValueSnapshot(r,rows){
    if(!currentOdds()||hasOfficialResult(r))return false;const close=typeof raceCloseMs==='function'?raceCloseMs(r):NaN;if(Number.isFinite(close)&&close<=Date.now())return false;
    let rec;const key=resultStoreKey();try{rec=JSON.parse(localStorage.getItem(key)||'null')}catch(e){return false}if(!rec||rec.settled)return false;
    rec.value_modes=rec.value_modes||{};
    for(const mode of ['hit','balance','return']){const v=valueCandidates(rows,mode),picks=v.picks.map(x=>x.combo);rec.value_modes[mode]={picks,stake:picks.length*100,settled:false,hit:false,payout:0,skipped:!picks.length,threshold:v.threshold,items:v.picks.map(x=>({combo:x.combo,prob:x.safeProb,odds:x.odds,ev:x.ev}))}}
    rec.odds_snapshot_at=currentOdds().fetched_at||new Date().toISOString();rec.value_model_version=1;
    try{localStorage.setItem(key,JSON.stringify(rec));return true}catch(e){return false}
  }
  const baseSavePredictionSnapshot=savePredictionSnapshot;
  savePredictionSnapshot=function(r,rows){const ok=baseSavePredictionSnapshot(r,rows);saveValueSnapshot(r,rows);return ok};

  const baseSettlePredictionKey=settlePredictionKey;
  settlePredictionKey=function(r,key){const changed=baseSettlePredictionKey(r,key),t=r?.result?.payouts?.trifecta?.[0];if(!t)return changed;let rec;try{rec=JSON.parse(localStorage.getItem(key)||'null')}catch(e){return changed}if(!rec?.value_modes)return changed;const combo=String(t.combination||'').trim(),amount=Number(t.amount||0);for(const mode of Object.keys(rec.value_modes)){const m=rec.value_modes[mode];m.settled=true;m.result=combo;m.hit=Array.isArray(m.picks)&&m.picks.includes(combo);m.payout=m.hit?amount:0}try{localStorage.setItem(key,JSON.stringify(rec))}catch(e){}return true};

  async function loadLiveOdds(){
    if(typeof dateOffset!=='undefined'&&dateOffset!==0){oddsStatus='unavailable';return}
    try{const res=await fetch(`odds.json?d=${day()}&x=${Date.now()}`,{cache:'no-store'});if(!res.ok)throw new Error('HTTP '+res.status);const data=await res.json();if(String(data?.date)!==String(day())||!data?.races)throw new Error('本日データ待機中');oddsPayload=data;oddsStatus='ok'}catch(e){oddsPayload=null;oddsStatus='unavailable'}
    try{if(D&&sid)draw()}catch(e){}
  }
  setTimeout(loadLiveOdds,500);setInterval(loadLiveOdds,180000);
})();
