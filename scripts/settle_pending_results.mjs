import {verifyIndividualResult} from './verified_outcome.mjs';
import {applyResults} from './settlement.mjs';
export {applyResults} from './settlement.mjs';
import {loadHistory,writeJsonBatch} from './history_store.mjs';
// Results-only recovery: independent of the current day's program, odds and model.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseOfficialPayPage} from './fetch_official_results.mjs';
import {summarizeExperts} from './update_server_predictions.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const day=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).replaceAll('-','');

export async function recover({root=ROOT,now=new Date(),fetchIndividual,fetchPage=async date=>{
  const res=await fetch(`https://www.boatrace.jp/owpc/pc/race/pay?hd=${date}`,{headers:{'user-agent':'kyotei-v8-results-recovery/1.0'},signal:AbortSignal.timeout(30000)});
  if(!res.ok)throw Error(`official pay HTTP ${res.status}`);
  return res.text();
}}={}){
  const dir=path.join(root,'dev'),hotFile=path.join(dir,'server-predictions.json'),indexFile=path.join(dir,'server-predictions-index.json');
  const history=loadHistory(hotFile,path.join(dir,'server-predictions-archive'),indexFile),hot=history.hot,index=history.index,archives=(index.archives||[]).map(x=>({meta:x,file:path.join(dir,x.file),data:history.archives.get(x.month)}));
  const stores=[{file:hotFile,data:hot},...archives],all=stores.flatMap(x=>Object.values(x.data.records||{}));
  const dates=[...new Set(all.filter(x=>!x.settled&&!x.excluded&&(!x.cancelled||x.cancellation_source==='inferred')&&/^\d{8}$/.test(x.date)&&x.date<=day(now)).map(x=>x.date))].sort();
  let settled=0,cancelled=0,excluded=0;const changed=new Set(),errors=[];
  for(const date of dates){
    try{
      const payload=parseOfficialPayPage(await fetchPage(date),date);
      const requests=new Map(all.filter(rec=>rec.date===date&&!rec.settled&&!rec.excluded&&(!rec.cancelled||rec.cancellation_source==='inferred')).map(rec=>[`${Number(rec.stadium)}-${Number(rec.race)}`,rec]));
      for(const rec of requests.values()){
        const sid=String(Number(rec.stadium)),race=String(Number(rec.race)),published=payload.races?.[sid]?.[race];
        if(!published||published.cancelled)continue;
        payload.races[sid][race]=await verifyIndividualResult({date,stadium:sid,race},published,{fetchIndividual});
      }
      for(const store of stores){const counts=applyResults(store.data.records,payload);settled+=counts.settled;cancelled+=counts.cancelled;excluded+=counts.excluded;if(counts.settled+counts.cancelled+counts.excluded)changed.add(store.file)}
    }catch(e){errors.push(`${date}: ${e.message}`)}
  }
  if(errors.length)throw Error(`Some official results could not be fetched: ${errors.join('; ')}`);
  if(settled+cancelled+excluded){
    const stamp=now.toISOString();hot.expert_summary=summarizeExperts(all);hot.updated_at=stamp;
    hot.result_recovery={updated_at:stamp,settled,cancelled,excluded,errors};changed.add(hotFile);
    for(const archive of archives)if(changed.has(archive.file)){archive.data.updated_at=stamp;archive.meta.updated_at=stamp}
    index.updated_at=stamp;
    writeJsonBatch([...stores.filter(store=>changed.has(store.file)).map(store=>[store.file,store.data]),[indexFile,index]]);
  }
  const pending=all.filter(x=>!x.settled&&!x.cancelled&&!x.excluded).length;
  console.log(JSON.stringify({dates,settled,cancelled,excluded,pending,errors}));
  return{settled,cancelled,excluded,pending};
}
if(import.meta.url===`file://${process.argv[1]}`)await recover();
