import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureCarry,applyCarry,confirmCarry,emptyJournal,readJournal,writeJournal,validPreClose,purchaseSnapshot,VALUE_FIELDS} from './carry_preclose_saves.mjs';
import {settle} from './settlement.mjs';

const K=r=>`kyotei_v8_dev_result_20261013_24_${String(r).padStart(2,'0')}`;
const rec=(race=9,o={})=>({date:'20261013',stadium:'24',race:String(race),saved_at:'2026-10-13T05:00:00.000Z',closed_at:'2026-10-13T07:00:00.000Z',provenance:'verified_at_save',
  modes:{hit:{picks:['1-2-3','1-2-4'],stake:200,settled:false,hit:false,payout:0}},picks:['1-2-3','1-2-4'],stake:200,settled:false,hit:false,payout:0,source:'server',...o});
const value={value_modes:{hit:{picks:['1-2-3'],stake:300,items:[{combo:'1-2-3',stake:300,ev:1.4}],settled:false,hit:false,payout:0}},value_saved_at:'2026-10-13T06:00:00.000Z',
  value_provenance:{saved_at:'2026-10-13T06:00:00.000Z',closed_at:'2026-10-13T07:00:00.000Z'},odds_snapshot_at:'2026-10-13T05:58:00Z',value_model_version:4,recommendations:{hit:{level:'buy'}}};
const hist=(records,archived=[])=>({hot:{records:structuredClone(records)},keys:new Set([...Object.keys(records),...archived])});
const result={combination:'1-2-3',amount:1200};

// Validity: key must match the record, saved and close times must be known, saved before close.
assert.ok(validPreClose(K(9),rec(),rec().saved_at));
assert.ok(!validPreClose(K(9),rec(9,{closed_at:undefined}),rec().saved_at));           // close unknown -> not a pre-close save
assert.ok(!validPreClose(K(9),rec(9,{closed_at:'bad'}),rec().saved_at));
assert.ok(!validPreClose(K(9),rec(),undefined));
assert.ok(!validPreClose(K(9),rec(9,{saved_at:'2026-10-13T07:00:00.000Z'}),'2026-10-13T07:00:00.000Z'));
assert.ok(!validPreClose(K(10),rec(9),rec().saved_at));                               // record does not belong to the key
assert.ok(validPreClose(K(9),rec(9,{closed_at:undefined,provenance:{closed_at:'2026-10-13T07:00:00.000Z'}}),rec().saved_at));

// capture: new pre-close records and first EV saves; not post-close, not unknown close, not cancelled.
{
  const base={[K(1)]:rec(1),[K(2)]:rec(2)};
  const cur={...structuredClone(base),[K(9)]:rec(9),[K(10)]:rec(10,{saved_at:'2026-10-13T07:30:00.000Z'}),[K(11)]:rec(11,{closed_at:undefined}),[K(12)]:rec(12,{cancelled:true})};
  Object.assign(cur[K(1)],value);
  const j=captureCarry(base,cur,emptyJournal(),'T');
  assert.deepEqual(Object.keys(j.entries).sort(),[K(1),K(9)].sort());
  assert.equal(j.entries[K(9)].type,'record');assert.deepEqual(j.entries[K(9)].snapshot,rec(9));
  assert.equal(j.entries[K(1)].type,'value');assert.ok(Object.keys(j.entries[K(1)].snapshot).every(f=>VALUE_FIELDS.includes(f)));
}
// (1) rejected -> apply -> settled in the work tree -> rejected again -> re-apply: the original purchase stays.
{
  let j=captureCarry({},{[K(9)]:rec(9)},emptyJournal(),'T1');
  const h=hist({});applyCarry(h,j);settle(h.hot.records[K(9)],result,{source:'official'});assert.ok(h.hot.records[K(9)].settled);
  j=captureCarry({},h.hot.records,j,'T2');                    // second rejection: capture must not drop or replace it
  assert.deepEqual(j.entries[K(9)].snapshot,rec(9));assert.equal(j.entries[K(9)].captured_at,'T1');
  const h2=hist({});applyCarry(h2,j);assert.deepEqual(h2.hot.records[K(9)],rec(9));
}
// (2) EV results are never journaled: a first EV save that is already settled in the work tree is stored unsettled.
{
  const base={[K(1)]:rec(1)},cur=structuredClone(base);Object.assign(cur[K(1)],structuredClone(value));settle(cur[K(1)],result,{source:'official'});
  assert.equal(cur[K(1)].value_modes.hit.payout,3600);
  // Even though the work tree already settled it, the purchase is kept, without the result.
  const settledSnap=captureCarry(base,cur).entries[K(1)].snapshot;
  assert.deepEqual(settledSnap.value_modes.hit,{picks:['1-2-3'],stake:300,items:[{combo:'1-2-3',stake:300,ev:1.4}],settled:false,hit:false,payout:0});
  // Same when only the EV mode carries result fields.
  const cur2=structuredClone(base);Object.assign(cur2[K(1)],structuredClone(value));Object.assign(cur2[K(1)].value_modes.hit,{settled:true,hit:true,payout:1200,result:'1-2-3'});
  const snap=captureCarry(base,cur2).entries[K(1)].snapshot;
  assert.deepEqual(snap.value_modes.hit,{picks:['1-2-3'],stake:300,items:[{combo:'1-2-3',stake:300,ev:1.4}],settled:false,hit:false,payout:0});
  const h=hist(base);applyCarry(h,{entries:{[K(1)]:{type:'value',snapshot:snap}}});
  assert.equal(h.hot.records[K(1)].settled,false);assert.equal(h.hot.records[K(1)].value_modes.hit.settled,false);assert.equal(h.hot.records[K(1)].value_modes.hit.payout,0);
}
// purchaseSnapshot keeps purchases exactly and removes results.
{const r=rec(9);Object.assign(r,structuredClone(value));settle(r,result,{source:'official'});
 const s=purchaseSnapshot(r);assert.equal(s.settled,false);assert.equal(s.payout,0);assert.equal(s.result,undefined);assert.equal(s.settled_at,undefined);
 assert.deepEqual(s.modes.hit.picks,rec().modes.hit.picks);assert.equal(s.modes.hit.payout,0);assert.equal(s.value_modes.hit.stake,300);assert.equal(s.saved_at,rec().saved_at);}
// apply never overwrites origin; confirm removes only what origin holds (or origin's different purchase wins).
{
  const j={...emptyJournal(),entries:{[K(9)]:{type:'record',snapshot:rec(9)},[K(1)]:{type:'value',snapshot:value}}};
  const other=rec(9,{saved_at:'2026-10-13T04:00:00.000Z',modes:{hit:{picks:['2-1-3'],stake:100}}});
  const h=hist({[K(9)]:other,[K(1)]:rec(1)});const a=applyCarry(h,j);
  assert.deepEqual(h.hot.records[K(9)],other);assert.deepEqual(a.applied,[[K(1),'value']]);
  // Origin with the same purchase, already settled: confirmed. Origin with a different purchase: closed with conflict.
  const settledSame=rec(9);settle(settledSame,result,{source:'official'});
  let c=confirmCarry({[K(9)]:settledSame},j);assert.deepEqual(c.confirmed,[K(9)]);assert.deepEqual(Object.keys(c.journal.entries),[K(1)]);
  c=confirmCarry({[K(9)]:other},j);assert.deepEqual(c.conflicts,[K(9)]);
  // EV not in origin yet: kept. EV in origin: confirmed.
  c=confirmCarry({[K(1)]:rec(1)},j);assert.ok(c.journal.entries[K(1)]);
  c=confirmCarry({[K(1)]:{...rec(1),...structuredClone(value)}},j);assert.deepEqual(c.confirmed,[K(1)]);
  // Not in origin at all: kept.
  assert.ok(confirmCarry({},j).journal.entries[K(9)]);
  // Invalid snapshot is not applied; archived key is not re-added to hot.
  const bad={entries:{[K(9)]:{type:'record',snapshot:rec(9,{closed_at:undefined})}}};assert.deepEqual(applyCarry(hist({}),bad).skipped,[[K(9),'invalid_snapshot']]);
  const ha=hist({},[K(9)]);applyCarry(ha,j);assert.equal(ha.hot.records[K(9)],undefined);
}
// Journal file: atomic write, validated read, missing file is an empty journal.
{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v8-journal-')),f=path.join(dir,'j','journal.json');
 assert.deepEqual(readJournal(f),emptyJournal());const j=captureCarry({},{[K(9)]:rec(9)});writeJournal(f,j);assert.deepEqual(readJournal(f),j);
 assert.deepEqual(fs.readdirSync(path.dirname(f)),['journal.json']);
 fs.writeFileSync(f,'{"schema":"other"}');assert.throws(()=>readJournal(f),/Invalid pre-close journal/);fs.rmSync(dir,{recursive:true});}
console.log('pre-close journal OK: valid pre-close only, append-only snapshots without results, survives settle + repeated rejection, never overwrites origin, removed only when origin holds it, atomic file');
