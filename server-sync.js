(function(){
  const PREFIX='kyotei_v8_dev_result_';
  const LIVE_BASE='https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-live/main/';
  const diag=()=>document.getElementById('serverDiag');
  let archivesPromise=null,currentData=null;
  let historyRequested=false,hotPromise=null,historyPromise=null;
  window.__v8HistoryStatus='idle';
  const archiveRecords={},archiveVersions={};
  let serverRecords={};
  async function fetchCurrent(){
    let last;
    for(let attempt=0;attempt<2;attempt++){
      try{
        const options={cache:'no-store'};
        if(typeof AbortSignal!=='undefined'&&AbortSignal.timeout)options.signal=AbortSignal.timeout(20000);
        const res=await fetch(`${LIVE_BASE}dev/server-predictions.json?x=${Date.now()}&attempt=${attempt}`,options);
        if(!res.ok)throw Error('HTTP '+res.status);
        const data=await res.json();
        if(data?.schema!=='kyotei-v8-server-predictions'||data?.version!==1||!data.records)throw Error('データ形式不一致');
        return data;
      }catch(e){last=e;if(attempt===0)await new Promise(resolve=>setTimeout(resolve,1000))}
    }
    throw last;
  }
  function freshness(data){
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replace(/-/g,'');
    const pending=Object.entries(data.records||{}).some(([key,r])=>r&&key.startsWith(PREFIX+today+'_')&&!r.settled&&!r.cancelled&&!r.excluded);
    const age=Date.now()-stamp(data.updated_at);
    return pending&&(!stamp(data.updated_at)||age>20*60000)?'｜更新遅れ：保存・結果反映を待っています':'';
  }
  function stamp(v){const n=Date.parse(v||'');return Number.isFinite(n)?n:0}
  function samePicks(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>String(x)===String(b[i]))}
  function keepSavedValueDetails(server,local){
    if(!server||!local?.value_modes)return server;
    const merged={...server,value_modes:{...(server.value_modes||{})}};let kept=false;
    for(const mode of ['hit','balance','return']){
      const incoming=server.value_modes?.[mode],saved=local.value_modes?.[mode];
      if(!incoming||!Array.isArray(saved?.items)||!saved.items.length||(Array.isArray(incoming.items)&&incoming.items.length)||!samePicks(incoming.picks,saved.picks))continue;
      if(!server.value_saved_at||server.value_saved_at!==local.value_saved_at)continue;
      const savedTotal=saved.items.reduce((n,x)=>n+Number(x.stake||0),0);
      if(savedTotal!==Number(incoming.stake)||Number(saved.stake)!==Number(incoming.stake))continue;
      // Server stake and payout are authoritative; recover display details only.
      merged.value_modes[mode]={...incoming,threshold:saved.threshold,stake_strategy:saved.stake_strategy,items:saved.items};kept=true
    }
    if(kept){merged.value_model_version=Math.max(4,Number(server.value_model_version||0),Number(local.value_model_version||0));merged.odds_snapshot_at=server.odds_snapshot_at||local.odds_snapshot_at;merged.value_saved_at=server.value_saved_at||local.value_saved_at}
    return merged
  }
  function choose(local,server){
    if(!local)return server;
    if(server.source==='server'||server.cancelled||server.settled)return keepSavedValueDetails(server,local);
    if(local.source==='server')return server;
    if(local.cancelled||local.settled)return local;
    return stamp(server.cancelled_at||server.settled_at||server.saved_at)>=stamp(local.cancelled_at||local.settled_at||local.saved_at)?server:local
  }
  const displayRecord=rec=>rec&&window.v8SavedValueRecommendations?{...rec,recommendations:window.v8SavedValueRecommendations(rec)}:rec;
  window.v8GetServerPrediction=key=>{
    const server=serverRecords[key];if(!server)return null;
    let local=null;try{local=JSON.parse(localStorage.getItem(key)||'null')}catch(e){}
    return displayRecord(choose(local,server))
  };
  function savedRecords(){
    const records={};
    try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key?.startsWith(PREFIX))continue;try{const r=JSON.parse(localStorage.getItem(key)||'null');if(r)records[key]=r}catch(e){}}}catch(e){}
    for(const [key,server]of Object.entries(serverRecords))records[key]=choose(records[key],server);
    return records;
  }
  window.v8GetSavedPredictions=()=>Object.fromEntries(Object.entries(savedRecords()).map(([key,r])=>[key,displayRecord(r)]));
  window.v8GetSavedPredictionsForAnalysis=savedRecords;
  window.v8GetRecordAudit=filter=>currentData&&window.v8RecordAudit?window.v8RecordAudit({server:serverRecords,displayed:window.v8GetSavedPredictions(),updatedAt:currentData.updated_at,historyStatus:window.__v8HistoryStatus,filter}):null;
  function publish(){
    serverRecords=Object.assign({},...Object.values(archiveRecords),currentData?.records||{});
    const data={...currentData,records:serverRecords};window.__v8ServerPredictionData=data;
    if(typeof invalidateStatsCache==='function')invalidateStatsCache();
    if(typeof draw==='function'&&typeof D!=='undefined'&&D&&typeof sid!=='undefined'&&sid)draw();
    else if(typeof renderStats==='function')renderStats();
    if(typeof window.renderPredictionHistory==='function')window.renderPredictionHistory();
    window.dispatchEvent(new CustomEvent('v8-server-predictions',{detail:data}));
  }
  function importRecords(records){
    let imported=0,updated=0;
    for(const[key,record]of Object.entries(records||{})){
      if(!key.startsWith(PREFIX)||!record||typeof record!=='object')continue;
      let local=null;try{local=JSON.parse(localStorage.getItem(key)||'null')}catch(e){}
      const selected=choose(local,record);if(selected!==local){try{localStorage.setItem(key,JSON.stringify(selected));local?updated++:imported++}catch(e){/* In-memory server data remains available when storage is full. */}}
    }
    return{imported,updated}
  }
  async function syncArchives(){
    if(archivesPromise)return archivesPromise;
    archivesPromise=(async()=>{
      const options=()=>({cache:'no-store',...(typeof AbortSignal!=='undefined'&&AbortSignal.timeout?{signal:AbortSignal.timeout(20000)}:{})});
      const indexRes=await fetch(`${LIVE_BASE}dev/server-predictions-index.json?x=${Date.now()}`,options());if(!indexRes.ok)throw Error('archive index HTTP '+indexRes.status);
      const index=await indexRes.json();if(index?.schema!=='kyotei-v8-server-predictions-index'||index?.version!==1)throw Error('archive index format mismatch');
      let imported=0,updated=0;for(const item of index.archives||[]){
        const version=String(item.updated_at||item.record_count||'1');if(archiveVersions[item.file]===version)continue;
        const res=await fetch(`${LIVE_BASE}dev/${item.file}?v=${encodeURIComponent(version)}`,options());if(!res.ok)throw Error('archive HTTP '+res.status);
        const archive=await res.json();if(archive?.schema!=='kyotei-v8-server-predictions-archive'||archive?.version!==1||!archive.records)throw Error('archive format mismatch');
        archiveRecords[item.file]=archive.records;archiveVersions[item.file]=version;
        const merged=importRecords(archive.records);imported+=merged.imported;updated+=merged.updated;
      }
      return{imported,updated,total:Number(index.total_record_count||0)}
    })().finally(()=>{archivesPromise=null});return archivesPromise
  }
  async function syncHot(){
    const el=diag();try{
      if(el)el.textContent='常時自動保存：同期中…';
      const data=await fetchCurrent();
      if(currentData&&stamp(data.updated_at)<stamp(currentData.updated_at))throw Error('古い応答のため前回取得分を保持');
      currentData=data;
      const current=importRecords(data.records);
      let archive={imported:0,updated:0,total:0},archiveError='';
      if(historyRequested){try{archive=await syncArchives();window.__v8HistoryStatus='ready'}catch(e){archiveError=e.message;window.__v8HistoryStatus='error'}}
      publish();
      const imported=current.imported+archive.imported,updated=current.updated+archive.updated;
      const updatedAt=stamp(data.updated_at)?new Date(data.updated_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'日時不明';
      const total=Number(data.total_record_count||archive.total||data.record_count||0);if(el)el.textContent=`✓ 常時自動保存 接続｜${total}R｜${updatedAt}更新${imported||updated?`｜端末へ${imported+updated}件反映`:''}${archiveError?'｜過去履歴は同期待ち':!historyRequested?'｜過去履歴は成績欄で取得':''}`;
      if(el)el.textContent+=freshness(data);
      return{imported,updated}
    }catch(e){if(el)el.textContent='常時自動保存：接続待ち｜'+e.message;return null}
  }
  function syncServerPredictions(){
    if(hotPromise)return hotPromise;
    hotPromise=syncHot().finally(()=>{hotPromise=null});return hotPromise;
  }
  window.v8LoadFullHistory=()=>{
    historyRequested=true;
    if(historyPromise)return historyPromise;
    if(window.__v8HistoryStatus==='ready')return Promise.resolve();
    window.__v8HistoryStatus='loading';
    historyPromise=(async()=>{
      try{
        if(hotPromise)await hotPromise;
        if(!currentData)await syncServerPredictions();
        if(!currentData)throw Error('直近データの取得待ち');
        if(window.__v8HistoryStatus!=='ready')await syncArchives();
        window.__v8HistoryStatus='ready';
      }catch(e){window.__v8HistoryStatus='error';const el=diag();if(el)el.textContent='過去履歴は同期待ち｜'+e.message}
      publish();
    })().finally(()=>{historyPromise=null});
    publish();
    return historyPromise;
  };
  window.syncServerPredictions=syncServerPredictions;
  if(document.addEventListener)document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncServerPredictions()});
  if(window.addEventListener)window.addEventListener('online',syncServerPredictions);
  setTimeout(syncServerPredictions,900);setInterval(syncServerPredictions,180000);
})();
