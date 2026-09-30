// Results-only recovery: independent of the current day's program, odds and model.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseOfficialPayPage} from './fetch_official_results.mjs';
import {settle,cancel,summarizeExperts} from './update_server_predictions.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const day=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).replaceAll('-','');

export function applyResults(records,payload){
  let settled=0,cancelled=0;
  for(const rec of Object.values(records||{})){
    if(rec.settled||rec.cancelled||rec.date!==payload.date)continue;
    const result=payload.races?.[String(Number(rec.stadium))]?.[String(Number(rec.race))];
    if(!result)continue;
    if(result.cancelled){cancel(rec);cancelled++;continue}
    const combo=String(result.combination||''),amount=Number(result.amount);
    if(!/^[1-6]-[1-6]-[1-6]$/.test(combo)||new Set(combo.split('-')).size!==3||!Number.isFinite(amount)||amount<=0)continue;
    settle(rec,{combination:combo,amount},{preserveSaved:true});settled++;
  }
  return{settled,cancelled};
}

export async function recover({root=ROOT,now=new Date(),fetchPage=async date=>{
  const res=await fetch(`https://www.boatrace.jp/owpc/pc/race/pay?hd=${date}`,{headers:{'user-agent':'kyotei-v8-results-recovery/1.0'},signal:AbortSignal.timeout(30000)});
  if(!res.ok)throw Error(`official pay HTTP ${res.status}`);
  return res.text();
}}={}){
  const dir=path.join(root,'dev'),hotFile=path.join(dir,'server-predictions.json'),indexFile=path.join(dir,'server-predictions-index.json');
  const hot=read(hotFile),index=read(indexFile),archives=(index.archives||[]).map(x=>({meta:x,file:path.join(dir,x.file),data:read(path.join(dir,x.file))}));
  const stores=[{file:hotFile,data:hot},...archives],all=stores.flatMap(x=>Object.values(x.data.records||{}));
  const dates=[...new Set(all.filter(x=>!x.settled&&!x.cancelled&&/^\d{8}$/.test(x.date)&&x.date<=day(now)).map(x=>x.date))].sort();
  let settled=0,cancelled=0;const changed=new Set(),errors=[];
  for(const date of dates){
    try{
      const payload=parseOfficialPayPage(await fetchPage(date),date);
      for(const store of stores){const counts=applyResults(store.data.records,payload);settled+=counts.settled;cancelled+=counts.cancelled;if(counts.settled+counts.cancelled)changed.add(store.file)}
    }catch(e){errors.push(`${date}: ${e.message}`)}
  }
  if(settled+cancelled){
    const stamp=now.toISOString();hot.expert_summary=summarizeExperts(all);hot.updated_at=stamp;
    hot.result_recovery={updated_at:stamp,settled,cancelled,errors};changed.add(hotFile);
    for(const archive of archives)if(changed.has(archive.file)){archive.data.updated_at=stamp;archive.meta.updated_at=stamp}
    index.updated_at=stamp;
    for(const store of stores)if(changed.has(store.file))fs.writeFileSync(store.file,JSON.stringify(store.data)+'\n');
    fs.writeFileSync(indexFile,JSON.stringify(index)+'\n');
  }
  const pending=all.filter(x=>!x.settled&&!x.cancelled).length;
  console.log(JSON.stringify({dates,settled,cancelled,pending,errors}));
  if(errors.length)throw Error(`Some official results could not be fetched: ${errors.join('; ')}`);
  return{settled,cancelled,pending};
}
if(import.meta.url===`file://${process.argv[1]}`)await recover();
