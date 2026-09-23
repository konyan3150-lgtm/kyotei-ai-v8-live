(function(){
  const PREFIX='kyotei_v8_dev_result_';
  const diag=()=>document.getElementById('serverDiag');
  let archivesPromise=null;
  function stamp(v){const n=Date.parse(v||'');return Number.isFinite(n)?n:0}
  function choose(local,server){
    if(!local)return server;
    if(server.cancelled||server.settled)return server;
    if(local.cancelled||local.settled)return local;
    return stamp(server.cancelled_at||server.settled_at||server.saved_at)>=stamp(local.cancelled_at||local.settled_at||local.saved_at)?server:local
  }
  function importRecords(records){
    let imported=0,updated=0;
    for(const[key,record]of Object.entries(records||{})){
      if(!key.startsWith(PREFIX)||!record||typeof record!=='object')continue;
      let local=null;try{local=JSON.parse(localStorage.getItem(key)||'null')}catch(e){}
      const selected=choose(local,record);if(selected!==local){localStorage.setItem(key,JSON.stringify(selected));local?updated++:imported++}
    }
    return{imported,updated}
  }
  async function syncArchives(){
    if(archivesPromise)return archivesPromise;
    archivesPromise=(async()=>{
      const indexRes=await fetch(`dev/server-predictions-index.json?x=${Date.now()}`,{cache:'no-store'});if(!indexRes.ok){if(indexRes.status===404)return{imported:0,updated:0,total:0};throw Error('archive index HTTP '+indexRes.status)}
      const index=await indexRes.json();if(index?.schema!=='kyotei-v8-server-predictions-index'||index?.version!==1)return{imported:0,updated:0,total:0};
      let imported=0,updated=0;for(const item of index.archives||[]){const version=encodeURIComponent(item.updated_at||item.record_count||'1'),res=await fetch(`dev/${item.file}?v=${version}`);if(!res.ok)continue;const archive=await res.json();if(archive?.schema!=='kyotei-v8-server-predictions-archive'||archive?.version!==1)continue;const merged=importRecords(archive.records);imported+=merged.imported;updated+=merged.updated}
      return{imported,updated,total:Number(index.total_record_count||0)}
    })().catch(e=>{archivesPromise=null;throw e});return archivesPromise
  }
  async function syncServerPredictions(){
    const el=diag();try{
      if(el)el.textContent='常時自動保存：同期中…';
      const res=await fetch(`dev/server-predictions.json?x=${Date.now()}`,{cache:'no-store'});if(!res.ok)throw Error('HTTP '+res.status);
      const data=await res.json();if(data?.schema!=='kyotei-v8-server-predictions'||data?.version!==1||!data.records)throw Error('データ形式不一致');
      const current=importRecords(data.records),archive=await syncArchives();let imported=current.imported+archive.imported,updated=current.updated+archive.updated;
      if((imported||updated)&&typeof draw==='function'&&typeof D!=='undefined'&&D&&typeof sid!=='undefined'&&sid)draw();
      else{if(typeof renderStats==='function')renderStats();if(typeof window.renderPredictionHistory==='function')window.renderPredictionHistory()}
      const updatedAt=data.updated_at?new Date(data.updated_at).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'}):'--:--';
      const total=Number(data.total_record_count||archive.total||data.record_count||0);if(el)el.textContent=`✓ 常時自動保存 接続｜${total}R｜${updatedAt}更新${imported||updated?`｜端末へ${imported+updated}件反映`:''}`;
      return{imported,updated}
    }catch(e){if(el)el.textContent='常時自動保存：接続待ち｜'+e.message;return null}
  }
  window.syncServerPredictions=syncServerPredictions;
  setTimeout(syncServerPredictions,900);setInterval(syncServerPredictions,180000);
})();
