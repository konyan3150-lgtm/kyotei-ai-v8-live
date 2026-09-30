// Development-only collection. Never changes prediction probabilities or bets.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const clean=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;|\u00a0/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim().normalize('NFKC');
const blocks=(s,tag)=>[...String(s).matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,'gi'))].map(x=>x[1]);
const numeric=s=>{const t=clean(s);return /^-?\d+(?:\.\d+)?$/.test(t)?Number(t):null};
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
export const jstDay=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).replaceAll('-','');
export function closeMs(value){if(!value)return NaN;const s=String(value).replace(' ','T');return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s)?s:s+'+09:00')}

export function parseSeries(html,date,raceNo){
  const racers={};
  for(const body of blocks(html,'tbody')){
    const rows=blocks(body,'tr');if(rows.length!==4)continue;
    const cells=rows.map(x=>blocks(x,'td')),id=body.match(/toban=(\d{4})/),lane=body.match(/is-boatColor([1-6])/);
    if(!id||!lane||cells[0].length<10||cells[1].length<12||cells[2].length<12||cells[3].length<12)continue;
    const results=[];
    for(let i=0;i<cells[3].length;i++){
      const cell=cells[3][i],hd=cell.match(/[?&](?:amp;)?hd=(\d{8})/),rn=cell.match(/[?&](?:amp;)?rno=(\d+)/);
      if(!hd||!rn||hd[1]>date||(hd[1]===date&&Number(rn[1])>=Number(raceNo)))continue;
      const finish=clean(cell),stText=clean(cells[2][i]),course=numeric(cells[1][i]);
      const st=/^\.\d+$/.test(stText)?Number(stText):/^0\.\d+$/.test(stText)?Number(stText):null;
      if(!finish)continue;
      results.push({date:hd[1],race:Number(rn[1]),finish,course,st,start_fault:/^[FL]/.test(stText)?stText:null});
    }
    const finishes=results.map(x=>numeric(x.finish)).filter(x=>x>=1&&x<=6);
    const starts=results.map(x=>x.st).filter(x=>x!==null);
    const name=cells[0][2].match(/<div\b[^>]*class="[^"]*is-fs18[^\"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    racers[lane[1]]={registration_number:id[1],name:name?clean(name):null,series_results:results,
      completed:finishes.length,average_finish:mean(finishes),average_st:mean(starts),st_count:starts.length,
      wins:finishes.filter(x=>x===1).length,top2:finishes.filter(x=>x<=2).length};
  }
  const stage=blocks(html,'h3').map(clean).find(x=>/\d+m/.test(x))||null;
  const title=blocks(html,'h2').map(clean).find(x=>x&&!/ネット投票|ボートレース場/.test(x))||null;
  return{meeting_name:title,race_stage:stage,racers};
}

export function parsePointChart(html){
  const racers={};
  for(const body of blocks(html,'tbody'))for(const row of blocks(body,'tr')){
    const cells=blocks(row,'td'),id=row.match(/toban=(\d{4})/),lane=row.match(/is-boatColor([1-6])/);
    if(!id||!lane||cells.length<12)continue;
    // Fail closed if the official layout changes: exactly six finish scenarios.
    if(cells.length!==13)continue;
    const projected=cells.slice(5,11).map(numeric);
    racers[lane[1]]={registration_number:id[1],point_rate:numeric(cells[3]),rank:numeric(cells[4]),
      projected_point_rates:projected,required_points:numeric(cells[11])};
  }
  const asOf=clean(html).match(/(?:\d+R終了時点|前日終了時点)/)?.[0]||null;
  return{provided:Object.keys(racers).length>0,as_of:asOf,racers};
}

export function combineContext(series,points,{date,stadium,race,closed_at,observed_at,source_urls}){
  const racers={};
  for(const [lane,r] of Object.entries(series.racers)){
    const p=points.racers[lane];
    racers[lane]={...r,...(p?.registration_number===r.registration_number?p:{})};
  }
  return{date,stadium:String(stadium),race:String(race),closed_at,observed_at,source_urls,
    meeting_name:series.meeting_name,race_stage:series.race_stage,point_chart_provided:points.provided,
    point_chart_as_of:points.as_of,racers,used_in_prediction:false};
}

export function saveObservation(store,key,record){
  if(!Object.keys(record.racers||{}).length)return false;
  const observed=Date.parse(record.observed_at),close=closeMs(record.closed_at);
  if(!Number.isFinite(observed)||!Number.isFinite(close))return false;
  store.latest??={};store.snapshots??={};
  store.latest[key]=record;
  if(observed<close){
    const previous=store.snapshots[key];
    if(!previous||Date.parse(previous.observed_at)<observed)store.snapshots[key]={...record,captured_before_close:true};
  }
  return true;
}

async function get(url){const res=await fetch(url,{headers:{'user-agent':'kyotei-v8-dev-meeting/1.0'},signal:AbortSignal.timeout(25000)});if(!res.ok)throw Error(`HTTP ${res.status}`);return res.text()}
const read=(p,fallback)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return fallback}};

export async function collect({date=jstDay(),outputRoot=ROOT,sample=null}={}){
  const dir=path.join(outputRoot,'dev'),out=path.join(dir,'meeting-context.json'),archive=path.join(dir,'meeting-context-archive',date+'.json');
  const old=read(out,{}),daily=read(archive,{});
  const store={schema:'kyotei-v8-meeting-context',version:1,date,
    latest:old.date===date?old.latest||{}:daily.latest||{},snapshots:old.date===date?old.snapshots||{}:daily.snapshots||{}};
  const errors=[],targets=[];
  if(sample)targets.push(sample);
  else{
    let program;
    try{program=JSON.parse(await get(`https://boatraceopenapi.github.io/api/v1/${date.slice(0,4)}/${date}.json`))}
    catch(e){if(e.message==='HTTP 404'){console.log(`Program not published for ${date}; retain saved files and retry next scheduled run`);return null}throw e}
    const venues=program?.programs?.stadiums;if(!venues)throw Error('Program unavailable');
    for(const [stadium,v] of Object.entries(venues)){
      const races=Object.entries(v.races||{}).filter(([,r])=>Number.isFinite(closeMs(r.closed_at))).sort((a,b)=>Number(a[0])-Number(b[0]));
      // One upcoming race per venue limits official-site load. A late capture is reference-only.
      const target=races.find(([,r])=>closeMs(r.closed_at)>Date.now())||races.at(-1);
      if(!target)continue;
      const key=`${date}_${Number(stadium)}_${Number(target[0])}`;
      if(closeMs(target[1].closed_at)<=Date.now()&&store.latest[key])continue;
      targets.push({stadium,race:target[0],closed_at:target[1].closed_at,expected_racers:target[1].racers});
    }
  }
  let saved=0;
  for(const t of targets){
    const qs=`hd=${date}&jcd=${String(t.stadium).padStart(2,'0')}&rno=${t.race}`;
    const seriesUrl=`https://www.boatrace.jp/owpc/pc/race/racelist?${qs}`,pointsUrl=`https://www.boatrace.jp/owpc/pc/race/pointchart?${qs}`;
    try{
      const html=await get(seriesUrl),series=parseSeries(html,date,t.race);
      let points={provided:false,as_of:null,racers:{}};
      try{points=parsePointChart(await get(pointsUrl))}catch(e){errors.push(`${t.stadium}/${t.race}: pointchart ${e.message}`)}
      if(Object.keys(series.racers).length!==6)throw Error('Official six-racer layout unavailable');
      if(t.expected_racers&&Object.entries(series.racers).some(([lane,r])=>String(t.expected_racers[lane]?.number)!==r.registration_number))throw Error('Program racer identity mismatch');
      const record=combineContext(series,points,{date,stadium:t.stadium,race:t.race,closed_at:t.closed_at,observed_at:new Date().toISOString(),source_urls:[seriesUrl,pointsUrl]});
      if(saveObservation(store,`${date}_${Number(t.stadium)}_${Number(t.race)}`,record))saved++;
    }catch(e){errors.push(`${t.stadium}/${t.race}: ${e.message}`)}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!saved&&!Object.keys(store.latest).length)throw Error(`No meeting data: ${errors.join('; ')}`);
  store.updated_at=new Date().toISOString();store.errors=errors;store.snapshot_count=Object.keys(store.snapshots).length;
  fs.mkdirSync(path.dirname(archive),{recursive:true});
  fs.writeFileSync(out,JSON.stringify(store)+'\n');fs.writeFileSync(archive,JSON.stringify(store)+'\n');
  console.log(`Meeting context: ${saved} updated, ${store.snapshot_count} pre-close snapshots, ${errors.length} errors`);
  return store;
}

if(import.meta.url===`file://${process.argv[1]}`){
  const args=process.argv.slice(2),date=args.find(x=>/^\d{8}$/.test(x))||jstDay();
  await collect({date,outputRoot:process.env.MEETING_OUTPUT_ROOT||ROOT});
}
