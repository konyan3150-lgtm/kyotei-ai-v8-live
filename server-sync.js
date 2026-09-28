(function(){
  const PREFIX='kyotei_v8_dev_result_';
  const LIVE_BASE='https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-live/main/';
  const diag=()=>document.getElementById('serverDiag');
  let archivesPromise=null,currentData=null;
  function stamp(v){const n=Date.parse(v||'');return Number.isFinite(n)?n:0}
  function samePicks(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>String(x)===String(b[i]))}
  function keepSavedValueDetails(server,local){
    if(!server||!local?.value_modes)return server;
    const merged={...server,value_modes:{...(server.value_modes||{})}};let kept=false;
    for(const mode of ['hit','balance','return']){
      const incoming=server.value_modes?.[mode],saved=local.value_modes?.[mode];
      if(!incoming||!Array.isArray(saved?.items)||!saved.items.length||(Array.isArray(incoming.items)&&incoming.items.length)||!samePicks(incoming.picks,saved.picks))continue;
      const hitItem=saved.items.find(x=>String(x.combo)===String(incoming.result||server.result||'')),payout=incoming.hit&&hitItem?Number(incoming.payout||0)*(Number(hitItem.stake||100)/100):incoming.payout;
      merged.value_modes[mode]={...incoming,threshold:saved.threshold,stake_strategy:saved.stake_strategy,items:saved.items,stake:Number(saved.stake||incoming.stake||0),payout};kept=true
    }
    if(kept){merged.value_model_version=Math.max(4,Number(server.value_model_version||0),Number(local.value_model_version||0));merged.odds_snapshot_at=server.odds_snapshot_at||local.odds_snapshot_at;merged.value_saved_at=server.value_saved_at||local.value_saved_at}
    return merged
  }
  function choose(local,server){
    if(!local)return server;
    if(server.cancelled||server.settled)return keepSavedValueDetails(server,local);
    if(local.cancelled||local.settled)return local;
    return stamp(server.cancelled_at||server.settled_at||server.saved_at)>=stamp(local.cancelled_at||local.settled_at||local.saved_at)?server:local
  }
  window.v8GetServerPrediction=key=>{
    const server=currentData?.records?.[key];if(!server)return null;
    let local=null;try{local=JSON.parse(localStorage.getItem(key)||'null')}catch(e){}
    return choose(local,server)
  };
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
      const indexRes=await fetch(`${LIVE_BASE}dev/server-predictions-index.json?x=${Date.now()}`,{cache:'no-store'});if(!indexRes.ok){if(indexRes.status===404)return{imported:0,updated:0,total:0};throw Error('archive index HTTP '+indexRes.status)}
      const index=await indexRes.json();if(index?.schema!=='kyotei-v8-server-predictions-index'||index?.version!==1)return{imported:0,updated:0,total:0};
      let imported=0,updated=0;for(const item of index.archives||[]){const version=encodeURIComponent(item.updated_at||item.record_count||'1'),res=await fetch(`${LIVE_BASE}dev/${item.file}?v=${version}`);if(!res.ok)continue;const archive=await res.json();if(archive?.schema!=='kyotei-v8-server-predictions-archive'||archive?.version!==1)continue;const merged=importRecords(archive.records);imported+=merged.imported;updated+=merged.updated}
      return{imported,updated,total:Number(index.total_record_count||0)}
    })().catch(e=>{archivesPromise=null;throw e});return archivesPromise
  }
  async function syncServerPredictions(){
    const el=diag();try{
      if(el)el.textContent='常時自動保存：同期中…';
      const res=await fetch(`${LIVE_BASE}dev/server-predictions.json?x=${Date.now()}`,{cache:'no-store'});if(!res.ok)throw Error('HTTP '+res.status);
      const data=await res.json();if(data?.schema!=='kyotei-v8-server-predictions'||data?.version!==1||!data.records)throw Error('データ形式不一致');
      currentData=data;window.__v8ServerPredictionData=data;
      const current=importRecords(data.records);
      if(typeof invalidateStatsCache==='function')invalidateStatsCache();
      if(typeof draw==='function'&&typeof D!=='undefined'&&D&&typeof sid!=='undefined'&&sid)draw();
      else if(typeof renderStats==='function')renderStats();
      window.dispatchEvent(new CustomEvent('v8-server-predictions',{detail:data}));
      let archive={imported:0,updated:0,total:0},archiveError='';
      try{archive=await syncArchives()}catch(e){archiveError=e.message}
      const imported=current.imported+archive.imported,updated=current.updated+archive.updated;
      if(archive.imported||archive.updated){if(typeof invalidateStatsCache==='function')invalidateStatsCache();if(typeof renderStats==='function')renderStats();if(typeof window.renderPredictionHistory==='function')window.renderPredictionHistory()}
      const updatedAt=data.updated_at?new Date(data.updated_at).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'}):'--:--';
      const total=Number(data.total_record_count||archive.total||data.record_count||0);if(el)el.textContent=`✓ 常時自動保存 接続｜${total}R｜${updatedAt}更新${imported||updated?`｜端末へ${imported+updated}件反映`:''}${archiveError?'｜過去履歴は同期待ち':''}`;
      return{imported,updated}
    }catch(e){if(el)el.textContent='常時自動保存：接続待ち｜'+e.message;return null}
  }
  window.syncServerPredictions=syncServerPredictions;
  setTimeout(syncServerPredictions,900);setInterval(syncServerPredictions,180000);
})();
