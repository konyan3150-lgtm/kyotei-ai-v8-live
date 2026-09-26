(function(){
  const PREFIX='kyotei_v8_dev_result_';
  const EV_THRESHOLDS={hit:1.00,balance:1.08,return:1.15};
  const POOL_LIMITS={hit:12,balance:40,return:120};
  const MAX_PICKS=4;
  const SAFETY_FACTOR=.75;
  const EV_STAKES=[{min:1.30,yen:300},{min:1.15,yen:200},{min:1.00,yen:100}];
  const stakeForEv=ev=>EV_STAKES.find(x=>Number(ev)>=x.min)?.yen||0;
  const stakeBadge=ev=>Number(ev)>=1.30?'<span class="ev-stake-badge ev-stake-strong">🔥 強く厚張り</span>':Number(ev)>=1.15?'<span class="ev-stake-badge ev-stake-thick">厚張り</span>':'<span class="ev-stake-badge ev-stake-normal">通常</span>';
  let oddsPayload=null,oddsStatus='loading';

  function currentOdds(){
    if(!oddsPayload||String(oddsPayload.date)!==String(day()))return null;
    return oddsPayload.races?.[String(sid)]?.[String(rno)]||null
  }
  function oddsFor(record,combo){const [a,b,c]=String(combo).split('-');return Number(record?.trifecta?.[a]?.[b]?.[c]||0)}
  function valueCandidates(rows,mode){
    const record=currentOdds(),threshold=EV_THRESHOLDS[mode]||1.15;
    if(!record)return{available:false,status:oddsStatus,threshold,picks:[],record:null};
    const calibrated=typeof calibratedPredictionRows==='function'?calibratedPredictionRows(rows):rows;
    const strength=new Map(calibrated.slice().sort((a,b)=>weightedV8Total(b.p)-weightedV8Total(a.p)).map((z,i)=>[z.k,i]));
    let all=[];for(const x of calibrated)for(const y of calibrated)for(const z of calibrated){if(x.k===y.k||x.k===z.k||y.k===z.k)continue;const raw=Math.max(1e-12,Number(x.p?.[0]))*Math.max(1e-12,Number(y.p?.[1]))*Math.max(1e-12,Number(z.p?.[2]));all.push({combo:`${x.k}-${y.k}-${z.k}`,boats:[x.k,y.k,z.k],ranks:[strength.get(x.k)||0,strength.get(y.k)||0,strength.get(z.k)||0],raw})}
    const total=all.reduce((s,x)=>s+x.raw,0)||1;all=all.map(x=>{const odds=oddsFor(record,x.combo),prob=x.raw/total,safeProb=prob*SAFETY_FACTOR;return{...x,prob,safeProb,odds,ev:safeProb*odds}}).filter(x=>x.odds>0&&x.prob>=.002);
    const favorite=rows.slice().sort((a,b)=>Number(b.p?.[0]||0)-Number(a.p?.[0]||0))[0]?.k;
    const candidates=mode==='hit'?all.filter(x=>x.boats?.[0]===favorite&&x.ranks?.[1]<=3&&x.ranks?.[2]<=4):all;
    const pool=candidates.sort((a,b)=>b.prob-a.prob).slice(0,POOL_LIMITS[mode]||120);
    const qualified=pool.filter(x=>x.ev>=threshold);
    qualified.sort(mode==='hit'?(a,b)=>b.prob-a.prob:mode==='balance'?(a,b)=>(b.ev*Math.sqrt(b.prob))-(a.ev*Math.sqrt(a.prob)):(a,b)=>b.ev-a.ev);
    return{available:true,status:'ok',threshold,picks:qualified.slice(0,MAX_PICKS),record}
  }
  window.valueAssessmentForMode=function(mode,rows){return valueCandidates(rows,mode)};
  function cancelledRace(r){return typeof isRaceCancelled==='function'&&isRaceCancelled(r,D?.programs?.stadiums?.[sid]?.races)}

  function savedValueMode(){
    try{const rec=JSON.parse(localStorage.getItem(resultStoreKey())||'null');return rec?.value_modes?.[valuePredictionMode]||null}catch(e){return null}
  }
  function renderSavedValueBets(saved){
    const el=document.getElementById('bets');if(!el||!saved)return false;
    const items=Array.isArray(saved.items)?saved.items:[],picks=Array.isArray(saved.picks)?saved.picks:[];
    if(items.length){
      const strong=items.some(x=>Number(x.ev)>=1.30),thick=items.some(x=>Number(x.ev)>=1.15);
      el.innerHTML=`<div class="odds-head">保存済み期待値買い目 <b>${items.length}点</b><span>締切前保存データ</span></div>${strong?'<div class="ev-race-alert strong">🔥 厚張り候補あり（保存時）</div>':thick?'<div class="ev-race-alert">厚張り候補あり（保存時）</div>':''}<table class="bettable value-table"><thead><tr><th>組番</th><th>V8確率</th><th>オッズ</th><th>EV</th><th>判断</th><th>推奨額</th></tr></thead><tbody>${items.map(x=>`<tr><td>${x.combo}</td><td>${(Number(x.prob||0)*100).toFixed(1)}%</td><td>${Number(x.odds||0).toFixed(1)}</td><td class="${Number(x.ev)>=1.15?'ev-high':''}">${Number(x.ev||0).toFixed(2)}</td><td>${stakeBadge(x.ev)}</td><td>¥${Number(x.stake||stakeForEv(x.ev)).toLocaleString()}</td></tr>`).join('')}</tbody></table><div class="value-note">終了済みレース：締切前に保存したオッズ・EVから表示</div>`;return true
    }
    if(!picks.length)return false;
    el.innerHTML=`<div class="odds-head">保存済み期待値買い目 <b>${picks.length}点</b><span>締切前保存データ</span></div><table class="bettable value-table"><thead><tr><th>組番</th><th>保存状態</th></tr></thead><tbody>${picks.map(combo=>`<tr><td>${String(combo)}</td><td>締切前保存</td></tr>`).join('')}</tbody></table><div class="value-note">締切前の組番は保存済みです。保存記録にEV・オッズ詳細がないため、ここでは組番のみ表示しています。</div>`;return true
  }
  function renderValueBets(rows){
    const el=document.getElementById('bets');if(!el)return;
    const r=D?.programs?.stadiums?.[sid]?.races?.[rno];if(cancelledRace(r)){el.innerHTML='<div class="odds-wait">開催中止のため買い目対象外</div>';return}const close=typeof raceCloseMs==='function'?raceCloseMs(r):NaN,official=!!r?.result?.payouts?.trifecta?.[0]||(typeof hasOfficialResult==='function'&&hasOfficialResult(r)),closed=official||(Number.isFinite(close)&&close<=Date.now());if(closed){const saved=savedValueMode();if(renderSavedValueBets(saved))return;el.innerHTML='<div class="odds-wait">締切済み｜締切前の保存買い目がありません</div>';return}
    const value=valueCandidates(rows,valuePredictionMode);
    if(!value.available){el.innerHTML=`<div class="odds-wait">${oddsStatus==='loading'?'3連単オッズ取得中…':'3連単オッズ未取得｜期待値判定待機'}</div>`;return}
    const updated=value.record?.fetched_at?new Date(value.record.fetched_at).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'}):'--:--';
    if(!value.picks.length){el.innerHTML=`<div class="odds-head">期待値判定 <b>見送り</b><span>オッズ ${updated}更新</span></div><div class="value-empty">基準EV ${value.threshold.toFixed(2)}以上の買い目がありません。</div>`;return}
    const strong=value.picks.some(x=>x.ev>=1.30),thick=value.picks.some(x=>x.ev>=1.15);el.innerHTML=`<div class="odds-head">期待値買い目 <b>${value.picks.length}点</b><span>オッズ ${updated}更新</span></div>${strong?'<div class="ev-race-alert strong">🔥 厚張り候補あり</div>':thick?'<div class="ev-race-alert">厚張り候補あり</div>':''}<table class="bettable value-table"><thead><tr><th>組番</th><th>V8確率</th><th>オッズ</th><th>EV</th><th>判断</th><th>推奨額</th></tr></thead><tbody>${value.picks.map(x=>`<tr><td>${x.combo}</td><td>${(x.safeProb*100).toFixed(1)}%</td><td>${x.odds.toFixed(1)}</td><td class="${x.ev>=1.15?'ev-high':''}">${x.ev.toFixed(2)}</td><td>${stakeBadge(x.ev)}</td><td>¥${stakeForEv(x.ev).toLocaleString()}</td></tr>`).join('')}</tbody></table><div class="value-note">全120通り正規化＋確率校正＋安全率75%｜EV別推奨額：1.00〜 ¥100 / 1.15〜 ¥200 / 1.30〜 ¥300｜最大4点</div>`
  }

  function renderBaseBetsPanel(rows){
    const el=document.getElementById('baseBets');if(!el)return;
    const r=D?.programs?.stadiums?.[sid]?.races?.[rno];if(cancelledRace(r)){el.innerHTML='<div class="odds-wait">開催中止のため買い目対象外</div>';return}
    if(typeof models==='undefined'||models.length!==3){el.textContent='V8モデル待機中';return}
    const picks=makeBets(rows,6,basePredictionMode);
    if(!picks.length){el.textContent='通常V8買い目を計算できません';return}
    const notes={hit:'確率上位を優先した通常V8予想',balance:'本命を残しながら着順を分散した通常V8予想',return:'V8穴度を加味した通常V8予想（オッズ未反映）'};
    el.innerHTML=`<div class="modehint">${notes[basePredictionMode]}</div><table class="bettable"><thead><tr><th>順</th><th>組番</th><th>モード指数</th></tr></thead><tbody>${picks.map(b=>`<tr><td>${b.rank}</td><td>${b.combo}</td><td>${(b.share*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table>`
  }

  const baseRenderBets=renderBets;
  renderBets=function(rows){renderValueBets(rows);renderBaseBetsPanel(rows)};

  function saveValueSnapshot(r,rows){
    if(!currentOdds()||hasOfficialResult(r)||cancelledRace(r))return false;const close=typeof raceCloseMs==='function'?raceCloseMs(r):NaN;if(Number.isFinite(close)&&close<=Date.now())return false;
    let rec;const key=resultStoreKey();try{rec=JSON.parse(localStorage.getItem(key)||'null')}catch(e){return false}if(!rec||rec.settled)return false;
    rec.value_modes=rec.value_modes||{};
    for(const mode of ['hit','balance','return']){const v=valueCandidates(rows,mode),picks=v.picks.map(x=>x.combo);const items=v.picks.map(x=>({combo:x.combo,prob:x.safeProb,odds:x.odds,ev:x.ev,stake:stakeForEv(x.ev)})),stake=items.reduce((s,x)=>s+x.stake,0);rec.value_modes[mode]={picks,stake,settled:false,hit:false,payout:0,skipped:!picks.length,threshold:v.threshold,stake_strategy:'ev_tier_v1',items}}
    const oddsAt=currentOdds().fetched_at||new Date().toISOString();
    rec.odds_snapshot_at=oddsAt;rec.value_mode=valuePredictionMode;rec.value_model_version=4;rec.probability_calibration=typeof v8CalibrationStatus==='function'?v8CalibrationStatus():{active:false};rec.value_saved_at=new Date().toISOString();
    // Keep the saved EV picks tied to the exact odds snapshot used for the on-screen EV calculation.
    // recommendation.js will stamp the matching recommendation with this same odds timestamp.
    try{localStorage.setItem(key,JSON.stringify(rec));return true}catch(e){return false}
  }
  const baseSavePredictionSnapshot=savePredictionSnapshot;
  savePredictionSnapshot=function(r,rows){const ok=baseSavePredictionSnapshot(r,rows);saveValueSnapshot(r,rows);return ok};

  const baseSettlePredictionKey=settlePredictionKey;
  settlePredictionKey=function(r,key){const changed=baseSettlePredictionKey(r,key),t=r?.result?.payouts?.trifecta?.[0];if(!t)return changed;let rec;try{rec=JSON.parse(localStorage.getItem(key)||'null')}catch(e){return changed}if(!rec?.value_modes)return changed;const combo=String(t.combination||'').trim(),amount=Number(t.amount||0);for(const mode of Object.keys(rec.value_modes)){const m=rec.value_modes[mode];m.settled=true;m.result=combo;m.hit=Array.isArray(m.picks)&&m.picks.includes(combo);const hitItem=Array.isArray(m.items)?m.items.find(x=>x.combo===combo):null;m.payout=m.hit?amount*(Number(hitItem?.stake||100)/100):0}try{localStorage.setItem(key,JSON.stringify(rec))}catch(e){}return true};

  async function loadLiveOdds(){
    if(typeof dateOffset!=='undefined'&&dateOffset!==0){oddsStatus='unavailable';return}
    try{let data=null,last='';const urls=[`https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-live/main/odds.json?d=${day()}&x=${Date.now()}`,`odds.json?d=${day()}&x=${Date.now()}`];for(const url of urls){try{const res=await fetch(url,{cache:'no-store'});if(!res.ok)throw new Error('HTTP '+res.status);const candidate=await res.json();if(String(candidate?.date)!==String(day())||!candidate?.races)throw new Error('本日データ待機中');data=candidate;break}catch(e){last=e.message}}if(!data)throw new Error(last||'本日オッズ未取得');oddsPayload=data;oddsStatus='ok'}catch(e){oddsPayload=null;oddsStatus='unavailable'}
    try{if(D&&sid){if(typeof autoSaveAllPredictions==='function')autoSaveAllPredictions();draw()}}catch(e){}
  }
  setTimeout(loadLiveOdds,500);setInterval(loadLiveOdds,180000);
})();
