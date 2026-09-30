import assert from 'node:assert/strict';import {createRequire} from 'node:module';import vm from 'node:vm';import fs from 'node:fs';
import {capture,attachOutcome} from './collect_expert_v2.mjs';
import {evaluate} from './evaluate_expert_v2.mjs';
const {classify,assess}=createRequire(import.meta.url)('../expert-classifier-v2.js');
for(const [scores,want] of [[{inside:50,exhibition:0,water:0},'normal'],[{inside:90,exhibition:0,water:0},'inside'],[{inside:10,exhibition:0,water:0},'upset'],[{inside:50,exhibition:90,water:0},'exhibition'],[{inside:50,exhibition:0,water:90},'water']]){
  const a=classify(scores);assert.equal(a.active,want);assert.equal(a.version,2);assert.equal(a.used_in_prediction,false);assert.ok(Math.abs(Object.values(a.weights).reduce((s,v)=>s+v,0)-1)<1e-12);
}
assert.equal(classify({inside:null,exhibition:null,water:null}).active,'normal');
const r={date:'2026-10-01',closed_at:'2026-10-01 12:00:00',racers:Object.fromEntries([1,2,3,4,5,6].map(k=>[k,{national_win_rate:5,local_win_rate:5,average_start_timing:.15,motor_top_2_percent:30}]))},rows=Object.entries(r.racers).map(([k,x])=>({k,x}));
assert.equal(assess(r,rows).active,'normal');
const browser={};vm.createContext(browser);vm.runInContext(fs.readFileSync(new URL('../expert-classifier-v2.js',import.meta.url),'utf8'),browser);assert.equal(JSON.stringify(browser.v8ExpertClassifierV2.assess(r,rows)),JSON.stringify(assess(r,rows)));
const records={},o={date:'20261001',stadium:1,race:1,now:new Date('2026-10-01T02:50:00Z')};assert.ok(capture(records,'key',r,o));const original=structuredClone(records.key);
assert.equal(capture(records,'key',r,{...o,now:new Date('2026-10-01T03:00:00Z')}),false);assert.equal(capture(records,'other',r,{...o,now:new Date('2026-10-01T02:00:00Z')}),false);
assert.ok(attachOutcome(records.key,{settled:true,result:'1-2-3',settled_at:'2026-10-01T03:10:00Z'}));for(const k of Object.keys(original))assert.deepEqual(records.key[k],original[k]);assert.equal(attachOutcome(records.key,{settled:true,result:'6-2-3'}),false);
console.log('All five v2 classes, missing values, browser/collector parity, cutoff freeze and outcome-only updates OK');
const late={...records.key,saved_at:'2026-10-01T03:00:00Z'};
const report=evaluate({good:records.key,late,old:{...records.key,version:1}});
assert.equal(report.saved,2);assert.equal(report.valid_preclose,1);assert.equal(report.excluded,1);assert.equal(report.settled,1);assert.equal(report.by_date['20261001'].inside_win_rate,1);
console.log('Version-separated, strict pre-close, date and venue evaluation OK');
