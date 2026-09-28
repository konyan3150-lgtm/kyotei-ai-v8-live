import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('app2.js','utf8');
const helper=source.slice(source.indexOf('function savedRaceRecord('),source.indexOf('async function loadTideData('));
const draw=source.split('\n').find(line=>line.startsWith('function draw(){'));
assert.ok(helper.startsWith('function savedRaceRecord('));
assert.ok(draw);

const elements=new Map();
function element(id){
  if(!elements.has(id))elements.set(id,{
    children:[],classList:{values:new Set(),remove(...names){for(const name of names)this.values.delete(name)},add(name){this.values.add(name)}},
    appendChild(child){this.children.push(child)},set innerHTML(value){this.children=[]},set textContent(value){this.text=value}
  });
  return elements.get(id);
}
const record={value_model_version:4,recommendations:{hit:{level:'buy'}},base_recommendations:{hit:{level:'buy'}},
  value_modes:{hit:{picks:['1-3-5'],settled:true,hit:true}},modes:{hit:{picks:['1-3-5'],settled:true,hit:true}}};
const context={
  window:{v8GetServerPrediction:key=>key==='kyotei_v8_dev_result_20260928_13_04'?record:null},
  localStorage:{getItem:()=>null},day:()=> '20260928',sid:'13',rno:'4',autoRace:false,
  D:{programs:{stadiums:{13:{races:{4:{result:{payouts:{trifecta:[{combination:'1-3-5',amount:3170}]}}}}}}}},
  N:{13:'尼崎'},document:{getElementById:element,createElement:()=>({setAttribute(){}})},
  renderVenues(){},nextOpenRace:()=> '4',raceCloseMs:()=>0,hasOfficialResult:()=>true,isRaceCancelled:()=>false,
  time:()=> '11:52',race(){},Date,Number,Object,Array,String
};
vm.runInNewContext(`${helper}\n${draw}\ndraw()`,context);
assert.match(element('raceScroll').children[0].className,/race-hit/);
assert.match(element('raceScroll').children[0].innerHTML,/racebadge mini hit.*racebadge mini hit/);
assert.equal(element('selectedPayout').text,'¥3,170');
assert.ok(element('selectedPayout').classList.values.has('payout-hit'));
console.log('server-saved race round verdict self-test OK');
