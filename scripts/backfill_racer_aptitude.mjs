#!/usr/bin/env node
import fs from 'node:fs';

const args=Object.fromEntries(process.argv.slice(2).map((x,i,a)=>x.startsWith('--')?[x.slice(2),a[i+1]&&!a[i+1].startsWith('--')?a[i+1]:true]:null).filter(Boolean));
const input=args.input||'racer-aptitude.json', output=args.output||input;
const jstDay=(offset=0)=>{const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo'}).format(new Date());const d=new Date(p+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10).replaceAll('-','')};
const input=args.input||'racer-aptitude.json', output=args.output||input;
const basePreview=JSON.parse(fs.readFileSync(input,'utf8'));
const nextDay=s=>{const x=String(s||'').replaceAll('-','');if(!/^\\d{8}$/.test(x))return null;const d=new Date(x.slice(0,4)+'-'+x.slice(4,6)+'-'+x.slice(6,8)+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10).replaceAll('-','')};
const start=args.start||nextDay(basePreview.history_end)||'20250730', end=args.end||jstDay(-1);
const API='https://boatraceopenapi.github.io/results/v3';
const blank=()=>[0,0,0,0,0,0,0,0,0];
const add=(a,place,st)=>{a=a||blank();a[0]++;if(Number.isFinite(place)&&place>=1&&place<=6){a[1]++;if(place===1)a[2]++;if(place<=2)a[3]++;if(place<=3)a[4]++;a[5]+=place}if(Number.isFinite(st)){a[6]++;a[7]+=st;a[8]+=st*st}return a};
const addArray=(a,b)=>{a=a||blank();for(let i=0;i<9;i++)a[i]=Number(a[i]||0)+Number(b?.[i]||0);return a};
const dayIter=function*(a,b){let d=new Date(a.slice(0,4)+'-'+a.slice(4,6)+'-'+a.slice(6,8)+'T00:00:00Z'),z=new Date(b.slice(0,4)+'-'+b.slice(4,6)+'-'+b.slice(6,8)+'T00:00:00Z');for(;d<=z;d.setUTCDate(d.getUTCDate()+1))yield d.toISOString().slice(0,10).replaceAll('-','')};
function accumulate(delta,payload){
  for(const race of payload?.results||[]){
    const venue=String(Number(race.stadium_number||0));if(!venue||venue==='0')continue;
    for(const b of race.boats||[]){
      const id=String(Number(b.racer_number||0)),course=String(Number(b.racer_course_number||0)),place=Number(b.racer_place_number),st=Number(b.racer_start_timing);
      if(!id||id==='0'||!['1','2','3','4','5','6'].includes(course))continue;
      const r=delta.racers[id]??={o:blank(),c:{},v:{},x:{}};
      r.o=add(r.o,place,Number.isFinite(st)?st:NaN);
      r.c[course]=add(r.c[course],place,Number.isFinite(st)?st:NaN);
      r.v[venue]=add(r.v[venue],place,Number.isFinite(st)?st:NaN);
      r.x[venue+':'+course]=add(r.x[venue+':'+course],place,Number.isFinite(st)?st:NaN);
      delta.global_course[course]=add(delta.global_course[course],place,Number.isFinite(st)?st:NaN);
      delta.boat_rows++;
    }
    if((race.boats||[]).some(b=>b.racer_number))delta.races++;
  }
}
function merge(base,delta){
  base.racers=base.racers||{};base.global_course=base.global_course||{};
  for(const [id,d] of Object.entries(delta.racers)){const r=base.racers[id]??={o:blank(),c:{},v:{},x:{}};r.o=addArray(r.o,d.o);for(const k of ['c','v','x'])for(const [key,a] of Object.entries(d[k]||{}))r[k][key]=addArray(r[k][key],a)}
  for(const [c,a] of Object.entries(delta.global_course))base.global_course[c]=addArray(base.global_course[c],a);
  base.schema=base.schema||'kyotei-v8-racer-aptitude';base.history_start=base.history_start||null;base.history_end=end;base.updated_at=new Date().toISOString();
  base.backfill={from:start,to:end,races_added:delta.races,boat_rows_added:delta.boat_rows,source:'BoatraceOpenAPI results v3; verify against BOAT RACE official where needed'};
  return base
}
async function fetchDay(day){
  const res=await fetch(`${API}/${day.slice(0,4)}/${day}.json`,{headers:{'user-agent':'kyotei-ai-v8-live aptitude backfill/1.0'},signal:AbortSignal.timeout(30000)});
  if(res.status===404)return null;if(!res.ok)throw Error(day+' HTTP '+res.status);return res.json()
}
async function main(){
  if(args['self-test']){const d={racers:{},global_course:{},races:0,boat_rows:0};accumulate(d,{results:[{stadium_number:8,boats:[{racer_number:5038,racer_course_number:1,racer_place_number:1,racer_start_timing:.12}]}]});const a=d.racers['5038'].x['8:1'];if(a[0]!==1||a[2]!==1||a[7]!==.12)throw Error('self-test failed');console.log('racer aptitude backfill self-test OK');return}
  const base=JSON.parse(fs.readFileSync(input,'utf8'));if(base.history_end&&String(base.history_end).replaceAll('-','')>=end){console.log('already current through '+base.history_end);return}
  const delta={racers:{},global_course:{},races:0,boat_rows:0};let days=0,missing=0;
  for(const day of dayIter(start,end)){const p=await fetchDay(day);days++;if(p)accumulate(delta,p);else missing++;if(days%30===0)console.log(`days=${days} races=${delta.races} rows=${delta.boat_rows} missing=${missing}`)}
  const minRaces=Number(args['min-races']??1),minRows=Number(args['min-rows']??1);if(delta.races<minRaces||delta.boat_rows<minRows)throw Error(`coverage too low: races=${delta.races} rows=${delta.boat_rows}`);
  const merged=merge(base,delta),tmp=output+'.tmp';fs.writeFileSync(tmp,JSON.stringify(merged));JSON.parse(fs.readFileSync(tmp,'utf8'));fs.renameSync(tmp,output);
  console.log(`wrote ${output}: ${start}-${end}, races_added=${delta.races}, rows_added=${delta.boat_rows}, missing_days=${missing}`)
}
await main();
