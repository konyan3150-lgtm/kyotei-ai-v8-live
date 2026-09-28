import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const record={date:'20260928',stadium:'14',race:'6',source:'server',value_model_version:4,
  settled:true,result:'3-1-4',value_mode:'hit',value_modes:{hit:{picks:['4-3-5'],items:[{combo:'4-3-5',stake:300}],stake:300,settled:true,hit:false,payout:0}}};
const key='kyotei_v8_dev_result_20260928_14_06';
function declaration(source,name){
  const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,name);
  const opening=source.indexOf('{',start);let depth=0;
  for(let i=opening;i<source.length;i++){
    if(source[i]==='{')depth++;
    if(source[i]==='}'&&!--depth)return source.slice(start,i+1);
  }
  throw Error(`Unclosed ${name}`);
}

const app=fs.readFileSync('app1.js','utf8');
let displayed,selected;
const context={window:{__v8ServerPredictionData:{records:{[key]:record}}},localStorage:{length:0},statsCache:null,statsCacheAt:0,
  fillStatsBox:(_,stats)=>{displayed=stats},renderModeStats:records=>{selected=records},renderBaseStats:()=>{}};
vm.runInNewContext(`${declaration(app,'renderStats')}; renderStats()`,context);
assert.equal(displayed.races,1);assert.equal(displayed.invest,300);
assert.equal(selected[0].result,'3-1-4');
assert.match(app,/Number\(selected\?\.value_model_version\)>=3/);

const odds=fs.readFileSync('odds-value.js','utf8');
const saved=vm.runInNewContext(`${declaration(odds,'savedValueMode')};savedValueMode()`,{
  valuePredictionMode:'hit',resultStoreKey:()=>key,
  window:{v8GetServerPrediction:()=>record},localStorage:{getItem:()=>null}
});
assert.equal(saved.picks[0],'4-3-5');

const sync=fs.readFileSync('server-sync.js','utf8');
let drawCount=0,releaseArchive;
const archivePending=new Promise(resolve=>{releaseArchive=resolve});
const storage=new Map();
const syncContext={window:{dispatchEvent:()=>{}},document:{getElementById:()=>({textContent:''})},Date,CustomEvent:class{},setTimeout:()=>{},setInterval:()=>{},
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
  fetch:async url=>url.includes('index.json')?archivePending:{ok:true,json:async()=>({schema:'kyotei-v8-server-predictions',version:1,records:{[key]:record}})},
  D:{},sid:'14',draw:()=>{drawCount++},renderStats:()=>{}};
vm.runInNewContext(sync,syncContext);
const pending=syncContext.window.syncServerPredictions();
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(drawCount,1,'Today\'s record must render before archive finishes');
releaseArchive({ok:false,status:404});await pending;
assert.equal(syncContext.window.v8GetServerPrediction(key)?.result,'3-1-4');
console.log('dev v4 display and early sync self-test OK');
