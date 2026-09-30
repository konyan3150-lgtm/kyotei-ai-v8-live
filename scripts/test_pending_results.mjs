import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyResults,recover} from './settle_pending_results.mjs';
import {parseOfficialPayPage} from './fetch_official_results.mjs';
const rec={date:'20260930',stadium:'24',race:'12',saved_at:'2026-09-30T13:30:00Z',mode:'hit',picks:['1-2-6'],stake:100,
  value_model_version:3,expert_snapshot:{version:1,active:'inside',label:'イン逃げ',saved_at:'2026-09-30T13:30:00Z'},
  modes:{hit:{picks:['1-2-6'],stake:100}},value_modes:{hit:{picks:['1-2-6'],stake:300,items:[{combo:'1-2-6',stake:300,ev:1.9}]}},recommendations:{hit:{level:'buy'}}};
const saved=structuredClone(rec),records={key:rec};
const payload={date:'20260930',races:{24:{12:{combination:'1-2-6',amount:7540}}}};
assert.deepEqual(applyResults(records,{...payload,date:'20261001'}),{settled:0,cancelled:0});
assert.deepEqual(applyResults(records,{date:'20260930',races:{24:{12:{combination:'1-1-6',amount:7540}}}}),{settled:0,cancelled:0});
assert.deepEqual(applyResults(records,payload),{settled:1,cancelled:0});
for(const k of ['expert_snapshot','saved_at','recommendations','picks','stake','value_model_version'])assert.deepEqual(rec[k],saved[k]);
assert.deepEqual(rec.value_modes.hit.items,saved.value_modes.hit.items);assert.equal(rec.value_modes.hit.stake,300);
assert.equal(rec.value_modes.hit.payout,22620);assert.equal(rec.expert_result.value_modes.hit.payout,22620);
const once=JSON.stringify(rec);applyResults(records,payload);assert.equal(JSON.stringify(rec),once);
const html='<td data-href="/x?rno=12&amp;jcd=24&amp;hd=20260930"><span class="numberSet1_number is-type1"></span><span class="numberSet1_number is-type2"></span><span class="numberSet1_number is-type6"></span></td><td>¥7,540</td>';
assert.equal(parseOfficialPayPage(html,'20261001').result_count,0);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'v8-results-test-')),dir=path.join(root,'dev');fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir,'server-predictions.json'),JSON.stringify({records:{key:saved}}));fs.writeFileSync(path.join(dir,'server-predictions-index.json'),JSON.stringify({archives:[]}));
const out=await recover({root,now:new Date('2026-10-01T00:00:00Z'),fetchPage:async date=>{assert.equal(date,'20260930');return html}});
assert.equal(out.settled,1);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'server-predictions.json'))).expert_summary.settled,1);
const filesBefore=fs.readFileSync(path.join(dir,'server-predictions.json'),'utf8');await recover({root,fetchPage:()=>{throw Error('Should not refetch settled races')}});assert.equal(fs.readFileSync(path.join(dir,'server-predictions.json'),'utf8'),filesBefore);
fs.rmSync(root,{recursive:true});console.log('Pending historical result recovery, immutable predictions, date validation and idempotency OK');
