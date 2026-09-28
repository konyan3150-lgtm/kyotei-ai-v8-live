import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('recommendation.js','utf8');
function declaration(name){
  const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,name);
  const opening=source.indexOf('{',start);let depth=0;
  for(let i=opening;i<source.length;i++){
    if(source[i]==='{')depth++;
    if(source[i]==='}'&&!--depth)return source.slice(start,i+1);
  }
  throw Error(`Unclosed ${name}`);
}
const record={settled:true,recommendations:{hit:{level:'buy'},balance:{level:'buy'},return:{level:'caution'}},base_recommendations:{hit:{level:'buy'}}};
const context={window:{v8GetServerPrediction:()=>record},resultStoreKey:()=> 'race',localStorage:{getItem:()=>null},
  MODES:['hit','balance','return'],LABELS:{hit:'的中重視',balance:'バランス',return:'回収重視'},
  LEVELS:{buy:'購入推奨',caution:'注意',skip:'見送り',none:'判定なし'}};
vm.runInNewContext([declaration('savedDecision'),declaration('storedAssessments'),declaration('boxHtml')].join('\n'),context);
assert.equal(vm.runInNewContext('storedAssessments().hit.level',context),'buy');
const html=vm.runInNewContext('boxHtml("購入判断",storedAssessments(),"hit",{races:0})',context);
assert.match(html,/購入推奨/);assert.match(html,/判定指数 <b>--<\/b>/);
assert.doesNotMatch(html,/判定指数 <b>0<\/b>/);
console.log('missing-score recommendation display self-test OK');
