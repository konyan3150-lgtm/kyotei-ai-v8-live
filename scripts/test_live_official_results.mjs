import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('app2.js','utf8');
const merge=source.split('\n').find(line=>line.startsWith('async function mergeOfficialResults('));
assert.ok(merge);
const fetched=[];
const data={programs:{stadiums:{9:{races:{10:{}}}}}};
const context={dateOffset:0,Date,Number,String,Object,
  fetch:async url=>{
    fetched.push(url);
    if(url.includes('results/v3/'))return {ok:false};
    if(url.includes('raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-live/main/dev/official-results.json'))
      return {ok:true,json:async()=>({date:'20260928',races:{9:{10:{combination:'1-2-5',amount:2080}}}})};
    throw Error(`Unexpected result source: ${url}`);
  }};
vm.runInNewContext(`${merge}\nmergeOfficialResults(data,'20260928')`,{...context,data}).then(count=>{
  assert.equal(count,1);
  assert.equal(data.programs.stadiums[9].races[10].result.payouts.trifecta[0].combination,'1-2-5');
  assert.ok(fetched.some(url=>url.includes('/main/dev/official-results.json')));
  console.log('live official results self-test OK');
});
