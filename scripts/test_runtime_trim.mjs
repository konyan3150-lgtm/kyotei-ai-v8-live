import assert from 'node:assert/strict';
import {venuesByRacer,trimAptitude,verifySame} from './runtime_trim.mjs';
const full={schema:'kyotei-v8-racer-aptitude',global_course:{1:[1]},runtime:{date:'20261011'},racers:{
 '1001':{o:[1],c:{1:[2]},v:{'4':[3],'平和島':[4],'11':[5]},x:{'平和島:1':[6],'平和島:6':[7],'びわこ:1':[8]}},
 '1002':{o:[9],c:{},v:{},x:{'大村:3':[10]}}}};
const program={programs:{stadiums:{'4':{races:{1:{racers:{1:{number:1001}}}}},'24':{races:{3:{racers:{2:{registration_number:'1002'},3:{number:9999}}}}}}}};
const venues=venuesByRacer(program);
assert.deepEqual([...venues.get('1001')],['平和島','4']);
const lite=trimAptitude(full,venues);
assert.deepEqual(lite.racers['1001'].v,{'4':[3],'平和島':[4]});
assert.deepEqual(lite.racers['1001'].x,{'平和島:1':[6],'平和島:6':[7]});
assert.deepEqual(lite.racers['1002'].x,{'大村:3':[10]});
assert.equal(lite.racers['9999'],undefined);
assert.ok(verifySame(full,lite,venues)>0);
const bad=structuredClone(lite);bad.racers['1001'].x['平和島:1']=[0];assert.throws(()=>verifySame(full,bad,venues));
const bad2=structuredClone(lite);delete bad2.racers['1001'].v['平和島'];assert.throws(()=>verifySame(full,bad2,venues));
assert.throws(()=>venuesByRacer({programs:{stadiums:{'99':{races:{}}}}}));
console.log('runtime-lite passed: keeps only today-venue lookups, identical values, unknown venues rejected');
