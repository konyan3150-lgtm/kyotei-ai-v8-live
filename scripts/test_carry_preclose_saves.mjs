import assert from 'node:assert/strict';
import {captureCarry,applyCarry,VALUE_FIELDS} from './carry_preclose_saves.mjs';

const rec=(o={})=>({date:'20261013',stadium:'24',race:'9',saved_at:'2026-10-13T05:00:00.000Z',closed_at:'2026-10-13T07:00:00.000Z',provenance:'verified_at_save',
  modes:{hit:{picks:['1-2-3','1-2-4'],stake:200,settled:false,hit:false,payout:0}},picks:['1-2-3','1-2-4'],stake:200,settled:false,hit:false,payout:0,source:'server',...o});
const value={value_modes:{hit:{picks:['1-2-3'],stake:300,items:[{combo:'1-2-3',stake:300,ev:1.4}]}},value_saved_at:'2026-10-13T06:00:00.000Z',value_provenance:{saved_at:'2026-10-13T06:00:00.000Z',closed_at:'2026-10-13T07:00:00.000Z'},odds_snapshot_at:'2026-10-13T05:58:00Z',value_model_version:4,recommendations:{hit:{level:'buy'}}};
const hist=(records,archived=[])=>({hot:{records:structuredClone(records)},keys:new Set([...Object.keys(records),...archived])});

// capture: new pre-close record, first EV save on an existing record; not results, not post-close saves, not closed records.
{
  const base={a:rec({race:'1',value_modes:{}}),b:rec({race:'2'}),c:rec({race:'3',settled:true})};
  const cur={...structuredClone(base),n:rec(),late:rec({race:'10',saved_at:'2026-10-13T07:30:00.000Z'})};
  Object.assign(cur.a,value);cur.b.settled=true;cur.b.payout=1000;Object.assign(cur.c,value);
  const c=captureCarry(base,cur);
  assert.deepEqual(Object.keys(c).sort(),['a','n']);
  assert.equal(c.n.type,'record');assert.deepEqual(c.n.record,cur.n);
  assert.equal(c.a.type,'value');assert.deepEqual(Object.keys(c.a.fields).sort(),Object.keys(value).sort());assert.ok(Object.keys(c.a.fields).every(f=>VALUE_FIELDS.includes(f)));
}
// apply: adds what origin lacks exactly as saved; never overwrites origin.
{
  const carry={n:{type:'record',record:rec()},a:{type:'value',fields:value}};
  const h=hist({a:rec({race:'1'})});const out=applyCarry(h,carry);
  assert.deepEqual(out.applied,[['n','record'],['a','value']]);assert.deepEqual(h.hot.records.n,rec());
  assert.deepEqual(h.hot.records.a.value_modes,value.value_modes);assert.equal(h.hot.records.a.value_saved_at,value.value_saved_at);assert.deepEqual(h.hot.records.a.modes,rec().modes);
  // Same record already in origin: dropped as already saved.
  const h2=hist({n:rec()});assert.deepEqual(applyCarry(h2,carry).dropped[0],['n','already_saved']);
  // Different record under the same key in origin: origin kept untouched.
  const other=rec({saved_at:'2026-10-13T04:00:00.000Z',modes:{hit:{picks:['2-1-3'],stake:100}}});
  const h3=hist({n:other});const o3=applyCarry(h3,{n:carry.n});assert.deepEqual(o3.dropped,[['n','conflict_kept_origin']]);assert.deepEqual(h3.hot.records.n,other);
  // EV already saved differently in origin, or record already settled / missing / archived: nothing changes.
  const withValue=rec({race:'1',value_modes:{hit:{picks:['3-2-1'],stake:100}}});const h4=hist({a:withValue});
  assert.deepEqual(applyCarry(h4,{a:carry.a}).dropped,[['a','conflict_kept_origin']]);assert.deepEqual(h4.hot.records.a,withValue);
  const settled=rec({race:'1',settled:true});const h5=hist({a:settled});assert.deepEqual(applyCarry(h5,{a:carry.a}).dropped,[['a','record_already_closed']]);assert.deepEqual(h5.hot.records.a,settled);
  assert.deepEqual(applyCarry(hist({}),{a:carry.a}).dropped,[['a','record_missing']]);
  const h6=hist({},['n']);assert.deepEqual(applyCarry(h6,{n:carry.n}).dropped,[['n','already_archived']]);assert.equal(h6.hot.records.n,undefined);
}
console.log('carry pre-close saves OK: captures new pre-close records and first EV saves only, re-adds them exactly, never overwrites origin');
