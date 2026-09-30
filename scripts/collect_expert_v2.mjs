import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {assess}=createRequire(import.meta.url)(process.env.EXPERT_CLASSIFIER_PATH||path.join(ROOT,'expert-classifier-v2.js'));
const jstDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const closeMs=r=>Date.parse(String(r?.closed_at||'').replace(' ','T')+'+09:00');
const read=(p,fallback)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return fallback}};
async function get(url){const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json()}
export function capture(records,key,r,{date,stadium,race,now=new Date()}){
  const close=closeMs(r),lead=close-now.getTime();
  if(String(r.date||'').replaceAll('-','')!==date)return false;
  if(!Number.isFinite(close)||lead<=0||lead>20*60000||records[key]?.outcome)return false;
  const rows=Object.entries(r.racers||{}).map(([k,x])=>({k,x}));if(rows.length!==6)return false;
  records[key]={...assess(r,rows),date,stadium:String(stadium),race:String(race),closed_at:r.closed_at,
    saved_at:now.toISOString(),captured_before_close:true,source:'BOAT RACE Open API pre-close program'};
  return true;
}
export function attachOutcome(rec,source){
  if(rec.version!==2||!rec.captured_before_close||rec.outcome||!source?.settled||!source.result||!Number.isFinite(Date.parse(rec.saved_at))||!Number.isFinite(closeMs(rec))||Date.parse(rec.saved_at)>=closeMs(rec))return false;
  rec.outcome={result:source.result,winner:source.result.split('-')[0],inside_won:source.result.split('-')[0]==='1',
    settled_at:source.settled_at,baseline_modes:source.expert_result?.modes,baseline_value_modes:source.expert_result?.value_modes};
  return true;
}
export async function collect({root=process.env.EXPERT_OUTPUT_ROOT||ROOT,date=jstDay()}={}){
  const dir=path.join(root,'dev'),archives=path.join(dir,'expert-v2-archive');fs.mkdirSync(archives,{recursive:true});
  const files=fs.readdirSync(archives).filter(x=>/^\d{8}\.json$/.test(x));
  const stores=new Map(files.map(f=>[f.slice(0,8),read(path.join(archives,f),{records:{}})]));
  const current=stores.get(date)||{schema:'kyotei-v8-expert-v2',version:2,date,records:{}};stores.set(date,current);
  let program=null;
  try{program=await get(`https://boatraceopenapi.github.io/api/v1/${date.slice(0,4)}/${date}.json`)}catch(e){if(e.message!=='HTTP 404')throw e}
  const now=new Date();let saved=0,settled=0;
  for(const [stadium,v] of Object.entries(program?.programs?.stadiums||{}))for(const [race,r] of Object.entries(v.races||{}))if(capture(current.records,`${date}_${Number(stadium)}_${Number(race)}`,r,{date,stadium,race,now}))saved++;
  let source=null;try{source=await get('https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-live/main/dev/server-predictions.json')}catch(e){console.warn('Result source waiting:',e.message)}
  const changed=new Set(saved?[date]:[]),monthly=new Map();
  for(const [d,store] of stores)for(const rec of Object.values(store.records)){
    if(rec.outcome)continue;
    const key=`kyotei_v8_dev_result_${d}_${rec.stadium.padStart(2,'0')}_${rec.race.padStart(2,'0')}`;
    let src=source?.records?.[key];
    if(!src&&d<date){const m=d.slice(0,6);if(!monthly.has(m)){try{monthly.set(m,await get(`https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-live/main/dev/server-predictions-archive/${m}.json`))}catch{monthly.set(m,null)}}src=monthly.get(m)?.records?.[key]}
    if(attachOutcome(rec,src)){settled++;changed.add(d)}
  }
  if(!files.includes(date+'.json'))changed.add(date);
  for(const d of changed){const s=stores.get(d);s.updated_at=new Date().toISOString();fs.writeFileSync(path.join(archives,d+'.json'),JSON.stringify(s)+'\n')}
  const all=[...stores.values()].flatMap(s=>Object.values(s.records));
  current.summary={saved:all.length,settled:all.filter(r=>r.outcome).length,by_active:Object.fromEntries(['normal','inside','upset','exhibition','water'].map(k=>[k,all.filter(r=>r.active===k).length]))};
  current.status=program?'collecting':'program_unpublished';
  fs.writeFileSync(path.join(dir,'expert-v2.json'),JSON.stringify(current)+'\n');
  console.log(JSON.stringify({version:2,date,saved,settled,total:all.length,status:current.status}));
  return current;
}
if(import.meta.url===`file://${process.argv[1]}`)await collect();
