import fs from 'node:fs';
import {normalizeModel,predictionRows,makeBets} from './update_server_predictions.mjs';

const ROOT=new URL('../',import.meta.url).pathname;
const old=JSON.parse(fs.readFileSync(process.argv[2]||ROOT+'racer-aptitude.old.json','utf8'));
const fresh=JSON.parse(fs.readFileSync(process.argv[3]||ROOT+'racer-aptitude.json','utf8'));
const model=normalizeModel(JSON.parse(fs.readFileSync(ROOT+'v8_model_aptitude.json','utf8')));
const empty={};
const ctx=a=>({models:model,aptitude:a,course:empty,venue:empty,technique:empty});
const A=ctx(old),B=ctx(fresh);
const start=process.argv[4]||'20260901',end=process.argv[5]||'20260923';
const ymd=d=>d.toISOString().slice(0,10).replaceAll('-','');
const date=s=>new Date(s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T00:00:00Z');
const add=(d,n)=>new Date(d.getTime()+n*86400000);
const stats=()=>({races:0,top1:0,hit6:0,changedTop1:0,changedBets:0});
const sa=stats(),sb=stats(); let compared=0,days=0;
for(let d=date(start);d<=date(end);d=add(d,1)){
  const day=ymd(d),year=day.slice(0,4);
  const [pr,rr]=await Promise.all([
    fetch(`https://boatraceopenapi.github.io/api/v1/${year}/${day}.json`),
    fetch(`https://boatraceopenapi.github.io/results/v3/${year}/${day}.json`)
  ]);
  if(!pr.ok||!rr.ok){console.log('skip',day,pr.status,rr.status);continue}
  const program=await pr.json(),results=await rr.json(),rm=new Map((results.results||[]).map(x=>[`${Number(x.stadium_number)}-${Number(x.number)}`,x]));
  days++;
  for(const[sid,sv]of Object.entries(program?.programs?.stadiums||{}))for(const[rn,r]of Object.entries(sv?.races||{})){
    const res=rm.get(`${Number(sid)}-${Number(rn)}`),finish=(res?.racers||[]).slice().sort((x,y)=>Number(x.place_number)-Number(y.place_number));
    if(finish.length<3||!Number.isFinite(Number(finish[0]?.place_number)))continue;
    const winner=String(finish[0].course_number||finish[0].boat_number||''),combo=finish.slice(0,3).map(x=>String(x.course_number||x.boat_number||'')).join('-');
    const ra=predictionRows(A,r,sid,rn,day),rb=predictionRows(B,r,sid,rn,day);if(ra.length!==6||rb.length!==6)continue;
    const top=x=>x.slice().sort((u,v)=>v.p[0]-u.p[0])[0]?.k,ta=top(ra),tb=top(rb),ba=makeBets(ra,6,'hit').map(x=>x.combo),bb=makeBets(rb,6,'hit').map(x=>x.combo);
    sa.races++;sb.races++;if(ta===winner)sa.top1++;if(tb===winner)sb.top1++;if(ba.includes(combo))sa.hit6++;if(bb.includes(combo))sb.hit6++;if(ta!==tb)sa.changedTop1++;if(JSON.stringify(ba)!==JSON.stringify(bb))sa.changedBets++;compared++;
  }
  console.log(day,'races',compared);
}
const pct=(n,d)=>d?+(n/d*100).toFixed(2):0;
const out={period:{start,end,days},note:'Isolated aptitude A/B: course/venue/technique/exhibition/live factors disabled. Fresh snapshot includes later history, so this measures sensitivity, not a leakage-free causal uplift.',old:{...sa,top1_rate:pct(sa.top1,sa.races),six_pick_hit_rate:pct(sa.hit6,sa.races)},fresh:{...sb,top1_rate:pct(sb.top1,sb.races),six_pick_hit_rate:pct(sb.hit6,sb.races)},delta_pp:{top1:+(pct(sb.top1,sb.races)-pct(sa.top1,sa.races)).toFixed(2),six_pick:+(pct(sb.hit6,sb.races)-pct(sa.hit6,sa.races)).toFixed(2)},prediction_change:{top1_rate:pct(sa.changedTop1,sa.races),six_pick_set_rate:pct(sa.changedBets,sa.races)}};
fs.writeFileSync(ROOT+'aptitude-ab-result.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
