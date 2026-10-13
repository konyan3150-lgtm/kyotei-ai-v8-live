// Pre-close purchase journal.
// A cycle may create new prediction records or first EV saves before close. If its push is rejected (another
// workflow pushed first), the race may close before the next successful push and those purchases could never be
// made again. This journal keeps the purchase snapshots (as saved, without any result) until origin is confirmed
// to hold them. It is not a cache of results: results are always fetched again.
// Rules:
//  - capture only adds entries; an existing entry is never replaced (the first snapshot is the purchase)
//  - snapshots never contain results (settlement fields are removed); cancelled/excluded records are not captured
//  - only entries with a valid key, saved time and close time, saved before close, are accepted
//  - apply only adds what origin lacks; it never overwrites origin
//  - an entry is removed only when origin holds the same purchase (or origin holds a different purchase for that
//    key: origin wins, with a warning)
//  - the journal file is written atomically (temp file + rename)
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadHistory,readJson,writeJsonBatch} from './history_store.mjs';

export const SCHEMA='kyotei-v8-preclose-journal';
export const VALUE_FIELDS=['value_modes','value_saved_at','value_provenance','odds_snapshot_at','value_model_version','recommendations','recommendation_version'];
const RESULT_FIELDS=['result','settled_at','expert_result'];
const MODE_RESULT_FIELDS=['result'];
const hasValue=rec=>!!rec&&Object.keys(rec.value_modes||{}).length>0;
const closedRec=rec=>!!(rec?.settled||rec?.excluded||rec?.cancelled);
// entries: purchases origin does not hold yet. unrecoverable: purchases that can no longer be added to origin
// (e.g. its record was settled before the EV save arrived); they are kept and reported as errors, never dropped.
export const emptyJournal=()=>({schema:SCHEMA,version:1,entries:{},unrecoverable:{}});

export function keyOf(rec){
  const p=n=>String(Number(n)).padStart(2,'0');
  return /^\d{8}$/.test(String(rec?.date))&&Number(rec?.stadium)>0&&Number(rec?.race)>0?`kyotei_v8_dev_result_${rec.date}_${p(rec.stadium)}_${p(rec.race)}`:null;
}
const closeMs=rec=>{for(const c of [rec?.closed_at,rec?.provenance?.closed_at,rec?.value_provenance?.closed_at]){const t=Date.parse(c||'');if(Number.isFinite(t))return t;}return NaN;};
// Valid pre-close save: record belongs to the key, saved time and close time are known, saved before close.
export function validPreClose(key,rec,savedAt){
  const s=Date.parse(savedAt||''),c=closeMs(rec);
  return keyOf(rec)===key&&Number.isFinite(s)&&Number.isFinite(c)&&s<c;
}
// Remove anything a settlement adds, keep the purchase exactly.
function unsettledModes(modes){
  return Object.fromEntries(Object.entries(modes||{}).map(([name,m])=>{const c={...m};for(const f of MODE_RESULT_FIELDS)delete c[f];if('settled' in c)c.settled=false;if('hit' in c)c.hit=false;if('payout' in c)c.payout=0;return [name,c];}));
}
export function purchaseSnapshot(rec){
  const c=structuredClone(rec);for(const f of RESULT_FIELDS)delete c[f];
  if('settled' in c)c.settled=false;if('hit' in c)c.hit=false;if('payout' in c)c.payout=0;
  if(c.modes)c.modes=unsettledModes(c.modes);if(c.value_modes)c.value_modes=unsettledModes(c.value_modes);
  return c;
}
export function valueSnapshot(rec){
  const f=Object.fromEntries(VALUE_FIELDS.filter(x=>rec[x]!==undefined).map(x=>[x,structuredClone(rec[x])]));
  if(f.value_modes)f.value_modes=unsettledModes(f.value_modes);
  return f;
}
// What identifies a purchase (same idea as verify_prediction_history.mjs).
const purchase=group=>JSON.stringify(Object.fromEntries(Object.entries(group||{}).sort(([a],[b])=>a.localeCompare(b)).map(([n,m])=>[n,{picks:m.picks||[],stake:m.stake,items:(m.items||[]).map(x=>({combo:x.combo,stake:x.stake}))}])));
const sameRecord=(a,b)=>a.saved_at===b.saved_at&&purchase(a.modes)===purchase(b.modes)&&purchase(a.value_modes)===purchase(b.value_modes);

export function captureCarry(baseRecords,currentRecords,journal=emptyJournal(),now=new Date().toISOString()){
  const out={...journal,schema:SCHEMA,version:1,entries:{...(journal?.entries||{})}};
  for(const [key,rec] of Object.entries(currentRecords||{})){
    if(out.entries[key]||rec?.cancelled||rec?.excluded)continue;   // first snapshot wins; never capture cancelled/excluded
    const base=baseRecords?.[key];
    if(!base){
      if(validPreClose(key,rec,rec?.saved_at))out.entries[key]={type:'record',snapshot:purchaseSnapshot(rec),captured_at:now};
    }else if(!hasValue(base)&&hasValue(rec)&&!closedRec(base)&&validPreClose(key,rec,rec.value_saved_at)){
      out.entries[key]={type:'value',snapshot:valueSnapshot(rec),captured_at:now};
    }
  }
  return out;
}

export function applyCarry(history,journal){
  const hot=history.hot,applied=[],skipped=[];
  for(const [key,e] of Object.entries(journal?.entries||{})){
    const snap=e.snapshot,current=hot.records[key];
    if(e.type==='record'){
      if(!validPreClose(key,snap,snap?.saved_at)){skipped.push([key,'invalid_snapshot']);continue;}
      if(!current&&!history.keys.has(key)){hot.records[key]=structuredClone(snap);applied.push([key,'record']);continue;}
      skipped.push([key,'present_in_origin']);
    }else if(e.type==='value'){
      if(!current){skipped.push([key,'record_not_in_hot']);continue;}
      if(!validPreClose(key,{...current,...snap},snap?.value_saved_at)){skipped.push([key,'invalid_snapshot']);continue;}
      if(hasValue(current)){skipped.push([key,'present_in_origin']);continue;}
      if(closedRec(current)){skipped.push([key,'record_already_closed']);continue;}
      Object.assign(current,structuredClone(snap));applied.push([key,'value']);
    }else skipped.push([key,'unknown_type']);
  }
  return {applied,skipped};
}

// Remove entries origin now holds. records: all history records (hot + archives) of origin.
export function confirmCarry(records,journal){
  const out={...journal,entries:{...(journal?.entries||{})},unrecoverable:{...(journal?.unrecoverable||{})}},confirmed=[],conflicts=[],unrecoverable=[];
  const lose=(key,e,reason)=>{out.unrecoverable[key]={...e,reason};delete out.entries[key];unrecoverable.push([key,reason]);};
  for(const [key,e] of Object.entries(out.entries)){
    const rec=records[key];
    if(e.type==='record'&&!validPreClose(key,e.snapshot,e.snapshot?.saved_at)){lose(key,e,'invalid_snapshot');continue;}
    if(!rec){if(e.type==='value')lose(key,e,'record_missing');continue;}
    if(e.type==='record'){
      if(sameRecord(rec,e.snapshot))confirmed.push(key);else conflicts.push(key);
      delete out.entries[key];
    }else if(e.type==='value'){
      if(!hasValue(rec)){if(closedRec(rec))lose(key,e,'record_closed_before_value_saved');continue;}   // open: keep
      if(purchase(rec.value_modes)===purchase(e.snapshot.value_modes)&&rec.value_saved_at===e.snapshot.value_saved_at)confirmed.push(key);else conflicts.push(key);
      delete out.entries[key];
    }
  }
  return {journal:out,confirmed,conflicts,unrecoverable};
}

export function readJournal(file){
  if(!fs.existsSync(file))return emptyJournal();
  const j=readJson(file);
  if(j?.schema!==SCHEMA||j.version!==1||!j.entries||typeof j.entries!=='object'||Array.isArray(j.entries))throw Error(`Invalid pre-close journal: ${file}`);
  if(j.unrecoverable!==undefined&&(typeof j.unrecoverable!=='object'||Array.isArray(j.unrecoverable)))throw Error(`Invalid pre-close journal: ${file}`);
  return {...j,unrecoverable:j.unrecoverable||{}};
}
export function writeJournal(file,journal){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.tmp-${process.pid}`;const fd=fs.openSync(tmp,'w');
  try{fs.writeFileSync(fd,JSON.stringify(journal));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  JSON.parse(fs.readFileSync(tmp,'utf8'));fs.renameSync(tmp,file);
}
const allRecords=h=>({...h.hot.records,...Object.fromEntries([...h.archives.values()].flatMap(x=>Object.entries(x.records)))});

// Exit codes: 0 ok (for "pending": entries are pending), 1 "pending": journal is empty, 2 error (unreadable,
// invalid or any failure). Callers must never treat 2 as "no purchases".
function main(){
  const [mode,dataDir,file,baseRef]=process.argv.slice(2);
  const hotFile=path.join(dataDir,'server-predictions.json'),indexFile=path.join(dataDir,'server-predictions-index.json'),archiveDir=path.join(dataDir,'server-predictions-archive');
  const journal=readJournal(file);
  if(mode==='capture'){
    const base=JSON.parse(execFileSync('git',['show',`${baseRef}:${hotFile}`],{encoding:'utf8',maxBuffer:1<<30})).records||{};
    const next=captureCarry(base,readJson(hotFile).records||{},journal);
    writeJournal(file,next);
    console.log(JSON.stringify({journal_entries:Object.keys(next.entries).length,journal_added:Object.keys(next.entries).length-Object.keys(journal.entries).length}));
  }else if(mode==='apply'){
    const history=loadHistory(hotFile,archiveDir,indexFile),before=history.keys.size;
    const {applied,skipped}=applyCarry(history,journal);
    if(applied.length){
      const total=before+applied.filter(([,t])=>t==='record').length;
      history.hot.record_count=Object.keys(history.hot.records).length;
      if(history.hot.total_record_count!==undefined)history.hot.total_record_count=total;
      if(history.index.total_record_count!==undefined)history.index.total_record_count=total;
      writeJsonBatch([[hotFile,history.hot],[indexFile,history.index]]);
      loadHistory(hotFile,archiveDir,indexFile);
    }
    console.log(JSON.stringify({journal_entries:Object.keys(journal.entries).length,journal_applied:applied,journal_skipped:skipped}));
  }else if(mode==='confirm'){
    const {journal:next,confirmed,conflicts,unrecoverable}=confirmCarry(allRecords(loadHistory(hotFile,archiveDir,indexFile)),journal);
    for(const key of conflicts)console.log(`::warning::origin holds a different purchase for ${key}; origin kept and journal entry closed`);
    for(const [key,why] of unrecoverable)console.log(`::error::pre-close purchase ${key} can no longer be added to origin (${why}); kept in the journal as unrecoverable`);
    writeJournal(file,next);
    console.log(JSON.stringify({journal_confirmed:confirmed.length,journal_conflicts:conflicts.length,journal_remaining:Object.keys(next.entries).length,journal_unrecoverable:Object.keys(next.unrecoverable).length}));
  }else if(mode==='pending'){
    process.exit(Object.keys(journal.entries).length?0:1);
  }else throw Error('Usage: carry_preclose_saves.mjs capture|apply|confirm|pending DATA_DIR JOURNAL_FILE [BASE_REF]');
}
if(import.meta.url===`file://${process.argv[1]}`){
  try{main();}catch(e){console.error(`::error::pre-close journal: ${e?.message||e}`);process.exit(2);}
}
