import fs from 'node:fs';
import path from 'node:path';

const ROOT=path.resolve(import.meta.dirname,'..');
const OUT=process.env.OFFICIAL_PREVIEWS_PATH||path.join(ROOT,'dev/official-previews.json');
const PROGRAM_BASE=process.env.PROGRAM_BASE||'https://boatraceopenapi.github.io/api/v1';
const OFFICIAL_BASE=process.env.OFFICIAL_BASE||'https://www.boatrace.jp/owpc/pc/race/beforeinfo';
const jstDay=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).replaceAll('-','');
const closeMs=r=>Date.parse(String(r?.closed_at||'').replace(' ','T')+'+09:00');
const strip=s=>String(s||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const number=s=>{const n=Number(String(s||'').replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null};

export function parseOfficialPreview(html){
  const racers={};
  for(const match of String(html).matchAll(/<tbody class="is-fs12[^"]*"[^>]*>([\s\S]*?)<\/tbody>/g)){
    const cells=[...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x=>strip(x[1])),lane=String(Number(cells[0]));
    if(!/^[1-6]$/.test(lane))continue;
    const exhibition=number(cells[4]),tilt=number(cells[5]);racers[lane]={};
    if(exhibition!=null)racers[lane].exhibition_time=exhibition;
    if(tilt!=null)racers[lane].tilt_adjustment=tilt;
  }
  let course=0;
  for(const match of String(html).matchAll(/table1_boatImage1Number[^>]*>([1-6])<\/span>[\s\S]*?table1_boatImage1Time[^>]*>([^<]+)<\/span>/g)){
    const lane=String(Number(match[1])),raw=strip(match[2]);course++;
    const timing=number(raw);racers[lane]=racers[lane]||{};racers[lane].course_number=course;
    if(timing!=null)racers[lane].start_timing=/^F/i.test(raw)?-Math.abs(timing):timing;
  }
  return Object.keys(racers).length===6&&course===6?{racers}:null;
}

async function get(url){const res=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; kyotei-v8-preview/1.0)','accept':'text/html,application/json'},signal:AbortSignal.timeout(30000)});if(!res.ok)throw Error(`HTTP ${res.status}`);return res}
async function mapLimit(items,limit,fn){let cursor=0;const workers=Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const index=cursor++;await fn(items[index],index)}});await Promise.all(workers)}

export async function run({now=new Date()}={}){
  const date=jstDay(now),year=date.slice(0,4),program=await (await get(`${PROGRAM_BASE}/${year}/${date}.json`)).json(),targets=[];
  for(const[sid,venue]of Object.entries(program?.programs?.stadiums||{}))for(const[raceNo,race]of Object.entries(venue?.races||{})){
    const close=closeMs(race),preview=Object.values(race?.preview?.racers||{}),complete=preview.length===6&&preview.every(x=>x?.course_number!=null&&x?.start_timing!=null&&x?.exhibition_time!=null);
    if(!complete&&Number.isFinite(close)&&close>=now.getTime()-25*60000&&close<=now.getTime()+45*60000)targets.push({sid,raceNo});
  }
  let old={};try{old=JSON.parse(fs.readFileSync(OUT,'utf8'))}catch{}
  const races=String(old?.date)===date?{...(old.races||{})}:{},errors=[];let fetched=0;
  await mapLimit(targets,4,async({sid,raceNo})=>{try{const url=`${OFFICIAL_BASE}?rno=${Number(raceNo)}&jcd=${String(sid).padStart(2,'0')}&hd=${date}`,html=await(await get(url)).text(),parsed=parseOfficialPreview(html);if(!parsed)return;(races[String(Number(sid))]??={})[String(Number(raceNo))]={...parsed,fetched_at:new Date().toISOString()};fetched++}catch(e){errors.push(`${sid}-${raceNo}:${e.message}`)}});
  const payload={schema:'kyotei-v8-official-previews',version:1,date,updated_at:new Date().toISOString(),race_count:Object.values(races).reduce((n,x)=>n+Object.keys(x||{}).length,0),fetched,races,errors:errors.slice(0,10)};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(payload));console.log(JSON.stringify({date,targets:targets.length,fetched,races:payload.race_count,errors:errors.length}));return payload;
}

function selfTest(){const rows=Array.from({length:6},(_,i)=>`<tbody class="is-fs12 "><tr><td class="is-boatColor${i+1}">${i+1}</td><td></td><td>A</td><td>52.0kg</td><td>6.92</td><td>-0.5</td></tr></tbody>`).join(''),starts=Array.from({length:6},(_,i)=>`<span class="table1_boatImage1Number is-type${i+1}">${i+1}</span><span class="table1_boatImage1Time">${i===5?'F.06':'.1'+i}</span>`).join(''),parsed=parseOfficialPreview(rows+starts);if(!parsed||parsed.racers['1'].exhibition_time!==6.92||parsed.racers['1'].tilt_adjustment!==-.5||parsed.racers['6'].course_number!==6||parsed.racers['6'].start_timing!==-.06)throw Error('official preview self-test failed');console.log('official preview self-test OK')}
if(import.meta.url===`file://${process.argv[1]}`){if(process.argv.includes('--self-test'))selfTest();else await run()}
