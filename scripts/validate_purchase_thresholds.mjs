import fs from 'node:fs';
import {normalizeModel,predictionRows,makeBets} from './update_server_predictions.mjs';
const ROOT=new URL('../',import.meta.url).pathname;
const aptitude=JSON.parse(fs.readFileSync(ROOT+'racer-aptitude.json','utf8'));
const model=normalizeModel(JSON.parse(fs.readFileSync(ROOT+'v8_model_aptitude.json','utf8')));
const start=process.argv[2]||'20260901',end=process.argv[3]||'20260923';
const ctx={models:model,aptitude,course:{},venue:{},technique:{}};
const cuts=[5,10,15,20,25,30,35,40,50];
const all=[];
const ymd=d=>d.toISOString().slice(0,10).replaceAll('-',''),dt=s=>new Date(s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T00:00:00Z');
for(let d=dt(start);d<=dt(end);d=new Date(d.getTime()+86400000)){
 const day=ymd(d),year=day.slice(0,4),[pr,rr]=await Promise.all([fetch(`https://boatraceopenapi.github.io/api/v1/${year}/${day}.json`),fetch(`https://boatraceopenapi.github.io/results/v3/${year}/${day}.json`)]);
 if(!pr.ok||!rr.ok)continue;const p=await pr.json(),rs=await rr.json(),rm=new Map((rs.results||[]).map(x=>[`${Number(x.stadium_number)}-${Number(x.number)}`,x]));
 for(const[sid,sv]of Object.entries(p?.programs?.stadiums||{}))for(const[rn,r]of Object.entries(sv?.races||{})){const res=rm.get(`${Number(sid)}-${Number(rn)}`),fin=(res?.boats||[]).filter(x=>Number(x.racer_place_number)>=1).sort((a,b)=>Number(a.racer_place_number)-Number(b.racer_place_number));if(fin.length<3)continue;const combo=fin.slice(0,3).map(x=>String(x.racer_course_number)).join('-'),rows=predictionRows(ctx,r,sid,rn,day);if(rows.length!==6)continue;const ranked=rows.map(x=>Number(x.p?.[0]||0)).sort((a,b)=>b-a),top=ranked[0]||0,gap=top-(ranked[1]||0),score=top*58+gap*85;const bets=makeBets(rows,6,'hit').map(x=>x.combo),pay=(res?.payouts?.trifecta||res?.payouts?.trifectas||res?.payouts?.trifecta_3||[]),po=Array.isArray(pay)?pay.find(x=>String(x.combination||x.combo||x.result||'').replaceAll(' ','')===combo):null,yen=Number(po?.amount??po?.payout??po?.payoff??0);all.push({score,hit:bets.includes(combo),yen,stake:bets.length*100})}}
all.sort((a,b)=>b.score-a.score);
const pct=(n,d)=>d?+(100*n/d).toFixed(2):0;
const results=cuts.map(rate=>{const n=Math.max(1,Math.round(all.length*rate/100)),xs=all.slice(0,n),hits=xs.filter(x=>x.hit).length,invest=xs.reduce((s,x)=>s+x.stake,0),ret=xs.reduce((s,x)=>s+(x.hit?x.yen:0),0);return{recommend_rate:rate,races:n,hits,hit_rate:pct(hits,n),invest,return:ret,profit:ret-invest,roi:pct(ret,invest)}})
fs.writeFileSync(ROOT+'purchase-threshold-result.json',JSON.stringify({period:{start,end},total_races:all.length,method:'Rank races by V8 hit-mode confidence (top*58 + gap*85), then test top N% as purchase recommendations. Six bets x 100 yen.',results},null,2));console.log(JSON.stringify(results,null,2));
