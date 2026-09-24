import fs from 'node:fs';
import {normalizeModel,predictionRows,makeBets} from './update_server_predictions.mjs';

const ROOT=new URL('../',import.meta.url).pathname;
const baseline=JSON.parse(fs.readFileSync(process.argv[2]||ROOT+'racer-aptitude.old.json','utf8'));
const model=normalizeModel(JSON.parse(fs.readFileSync(ROOT+'v8_model_aptitude.json','utf8')));
const start=process.argv[3]||'20260901',end=process.argv[4]||'20260923';
const blank=()=>[0,0,0,0,0,0,0,0,0],clone=x=>JSON.parse(JSON.stringify(x));
const add=(a,place,st)=>{a=a||blank();a[0]++;if(Number.isFinite(place)&&place>=1&&place<=6){a[1]++;if(place===1)a[2]++;if(place<=2)a[3]++;if(place<=3)a[4]++;a[5]+=place}if(Number.isFinite(st)){a[6]++;a[7]+=st;a[8]+=st*st}return a};
function ingest(data,payload){data.racers=data.racers||{};data.global_course=data.global_course||{};for(const race of payload?.results||[]){const venue=String(Number(race.stadium_number||0));for(const b of race.boats||[]){const id=String(Number(b.racer_number||0)),course=String(Number(b.racer_course_number||0)),place=Number(b.racer_place_number),st=Number(b.racer_start_timing);if(!id||id==='0'||!['1','2','3','4','5','6'].includes(course))continue;const r=data.racers[id]??={o:blank(),c:{},v:{},x:{}};r.o=add(r.o,place,st);r.c[course]=add(r.c[course],place,st);r.v[venue]=add(r.v[venue],place,st);r.x[venue+':'+course]=add(r.x[venue+':'+course],place,st);data.global_course[course]=add(data.global_course[course],place,st)}}}
const ymd=d=>d.toISOString().slice(0,10).replaceAll('-',''),dt=s=>new Date(s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T00:00:00Z'),addDay=(d,n)=>new Date(d.getTime()+n*86400000);
const empty={},ctx=a=>({models:model,aptitude:a,course:empty,venue:empty,technique:empty}),stats=()=>({races:0,top1:0,hit6:0});
const staticCtx=ctx(baseline),rolling=clone(baseline),sa=stats(),sb=stats();let changedTop=0,changedBets=0,days=0,investA=0,investB=0,returnA=0,returnB=0;
const buyStats=()=>({races:0,hits:0,invest:0,return:0}),buyA=buyStats(),buyB=buyStats();
const isBuy=(rows,mode='hit')=>{const ranked=rows.map(x=>Number(x.p?.[0]||0)).sort((a,b)=>b-a),top=ranked[0]||0,gap=top-(ranked[1]||0);return top>=.62&&gap>=.25};
for(let d=dt(start);d<=dt(end);d=addDay(d,1)){
 const day=ymd(d),year=day.slice(0,4),[pr,rr]=await Promise.all([fetch(`https://boatraceopenapi.github.io/api/v1/${year}/${day}.json`),fetch(`https://boatraceopenapi.github.io/results/v3/${year}/${day}.json`)]);
 if(!pr.ok||!rr.ok){console.log('skip',day);continue}const program=await pr.json(),results=await rr.json(),rm=new Map((results.results||[]).map(x=>[`${Number(x.stadium_number)}-${Number(x.number)}`,x])),rollingCtx=ctx(rolling);days++;
 for(const[sid,sv]of Object.entries(program?.programs?.stadiums||{}))for(const[rn,r]of Object.entries(sv?.races||{})){const res=rm.get(`${Number(sid)}-${Number(rn)}`),finish=(res?.boats||[]).filter(x=>Number(x.racer_place_number)>=1).slice().sort((x,y)=>Number(x.racer_place_number)-Number(y.racer_place_number));if(finish.length<3)continue;const lane=x=>String(x.racer_course_number||''),winner=lane(finish[0]),combo=finish.slice(0,3).map(lane).join('-'),ra=predictionRows(staticCtx,r,sid,rn,day),rb=predictionRows(rollingCtx,r,sid,rn,day);if(ra.length!==6||rb.length!==6)continue;const top=x=>x.slice().sort((u,v)=>v.p[0]-u.p[0])[0]?.k,ta=top(ra),tb=top(rb),ba=makeBets(ra,6,'hit').map(x=>x.combo),bb=makeBets(rb,6,'hit').map(x=>x.combo);sa.races++;sb.races++;if(ta===winner)sa.top1++;if(tb===winner)sb.top1++;if(ba.includes(combo))sa.hit6++;if(bb.includes(combo))sb.hit6++;if(ta!==tb)changedTop++;if(JSON.stringify(ba)!==JSON.stringify(bb))changedBets++;
 const payoutRows=res?.payouts?.trifecta||res?.payouts?.trifectas||res?.payouts?.trifecta_3||[];
 const payout=Array.isArray(payoutRows)?payoutRows.find(x=>String(x.combination||x.combo||x.result||'').replaceAll(' ','')===combo):null;
 const yen=Number(payout?.amount??payout?.payout??payout?.payoff??0);
 investA+=ba.length*100;investB+=bb.length*100;if(ba.includes(combo)&&yen>0)returnA+=yen;if(bb.includes(combo)&&yen>0)returnB+=yen;
 if(isBuy(ra)){buyA.races++;buyA.invest+=ba.length*100;if(ba.includes(combo)){buyA.hits++;if(yen>0)buyA.return+=yen}}
 if(isBuy(rb)){buyB.races++;buyB.invest+=bb.length*100;if(bb.includes(combo)){buyB.hits++;if(yen>0)buyB.return+=yen}}}
 ingest(rolling,results); console.log(day,sb.races);
}
if(!sb.races)throw Error('No races');
const pct=(n,d)=>+(100*n/d).toFixed(2),out={period:{start,end,days},method:'Leakage-safe walk-forward: each day uses aptitude data available only through the previous day. Other live corrections disabled to isolate aptitude.',baseline:{...sa,top1_rate:pct(sa.top1,sa.races),six_pick_hit_rate:pct(sa.hit6,sa.races)},walk_forward:{...sb,top1_rate:pct(sb.top1,sb.races),six_pick_hit_rate:pct(sb.hit6,sb.races)},delta_pp:{top1:+(pct(sb.top1,sb.races)-pct(sa.top1,sa.races)).toFixed(2),six_pick:+(pct(sb.hit6,sb.races)-pct(sa.hit6,sa.races)).toFixed(2)},prediction_change:{top1_count:changedTop,top1_rate:pct(changedTop,sb.races),six_pick_count:changedBets,six_pick_rate:pct(changedBets,sb.races)},money:{baseline:{invest:investA,return:returnA,profit:returnA-investA,roi:pct(returnA,investA)},walk_forward:{invest:investB,return:returnB,profit:returnB-investB,roi:pct(returnB,investB)}},purchase_recommended_hit_mode:{note:'Historical proxy for V8 hit-mode purchase recommendation using the same top>=0.62 and gap>=0.25 thresholds. Historical coverage is unavailable, so the live coverage>=82 gate cannot be reconstructed here.',baseline:{...buyA,hit_rate:pct(buyA.hits,buyA.races),profit:buyA.return-buyA.invest,roi:pct(buyA.return,buyA.invest)},walk_forward:{...buyB,hit_rate:pct(buyB.hits,buyB.races),profit:buyB.return-buyB.invest,roi:pct(buyB.return,buyB.invest)}}};
fs.writeFileSync(ROOT+'aptitude-walkforward-result.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
