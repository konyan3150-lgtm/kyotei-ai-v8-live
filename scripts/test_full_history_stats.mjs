import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const key=n=>'kyotei_v8_dev_result_20260930_24_'+String(n).padStart(2,'0');
const record=(race,stake,payout)=>({date:'20260930',stadium:'24',race:String(race),source:'server',value_model_version:4,settled:true,
  settled_at:'2026-09-30T14:00:00Z',value_modes:{hit:{settled:true,picks:['1-2-3'],stake,payout,hit:payout>0}},recommendations:{hit:{level:'buy'}}});
const hot={schema:'kyotei-v8-server-predictions',version:1,records:{[key(12)]:record(12,300,900)},total_record_count:2};
let version='1',archive={schema:'kyotei-v8-server-predictions-archive',version:1,records:{[key(11)]:record(11,200,0)}},fail=false,archiveFetches=0;
const stats=Array.from({length:6},()=>({textContent:''}));const el={textContent:''},events=[];
const c={window:{dispatchEvent:e=>events.push(e)},document:{getElementById:()=>el,querySelectorAll:s=>s==='#valueStats .stat b'?stats:[]},
  localStorage:{length:0,key:()=>null,getItem:()=>null,setItem:()=>{throw Error('QuotaExceededError')}},setTimeout:()=>{},setInterval:()=>{},Date,
  CustomEvent:class{constructor(type,o){this.type=type;this.detail=o.detail}},fetch:async url=>{
    if(url.includes('index.json'))return{ok:true,json:async()=>({schema:'kyotei-v8-server-predictions-index',version:1,total_record_count:2,archives:[{file:'server-predictions-archive/202609.json',updated_at:version}]})};
    if(url.includes('archive/')){archiveFetches++;return{ok:!fail,status:503,json:async()=>structuredClone(archive)}}
    return{ok:true,json:async()=>structuredClone(hot)};
  },structuredClone};
vm.createContext(c);vm.runInContext(fs.readFileSync(new URL('../app1.js',import.meta.url),'utf8'),c);
vm.runInContext('renderModeStats=()=>{};renderBaseStats=()=>{}',c);
vm.runInContext(fs.readFileSync(new URL('../server-sync.js',import.meta.url),'utf8'),c);
await c.window.syncServerPredictions();assert.equal(Object.keys(c.window.__v8ServerPredictionData.records).length,2);
assert.equal(stats[2].textContent,'2R');assert.equal(stats[3].textContent,'¥500');assert.equal(stats[4].textContent,'¥900');
assert.equal(c.window.v8GetServerPrediction(key(11)).value_modes.hit.stake,200);
assert.equal(Object.keys(c.window.v8GetSavedPredictions()).length,2);
await c.window.syncServerPredictions();assert.equal(archiveFetches,1); // unchanged archive is cached
version='2';archive.records[key(11)].value_modes.hit.payout=600;archive.records[key(11)].value_modes.hit.hit=true;
fail=true;await c.window.syncServerPredictions();assert.match(el.textContent,/同期待ち/);assert.equal(stats[2].textContent,'2R');assert.equal(stats[4].textContent,'¥900');
fail=false;await c.window.syncServerPredictions();assert.equal(archiveFetches,3);assert.equal(stats[4].textContent,'¥1,500');
hot.records[key(11)]=record(11,200,600);await c.window.syncServerPredictions();assert.equal(stats[2].textContent,'2R'); // overlap never doubles money
assert.equal(stats[3].textContent,'¥500');assert.equal(events.at(-1).detail.records[key(11)].value_modes.hit.payout,600);
const stale=record(11,1000,3000);stale.value_modes.hit.items=[{combo:'1-2-3',stake:1000}];
c.localStorage.length=1;c.localStorage.key=()=>key(11);c.localStorage.getItem=k=>k===key(11)?JSON.stringify(stale):null;
await c.window.syncServerPredictions();assert.equal(stats[3].textContent,'¥500');assert.equal(stats[4].textContent,'¥1,500');
assert.equal(c.window.v8GetSavedPredictions()[key(11)].value_modes.hit.stake,200); // canonical settled money, independent of device cache
console.log('Full-storage history aggregation, exact monetary totals, archive caching/retry and deduplication OK');
