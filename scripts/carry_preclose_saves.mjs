// Keep pre-close saves across a rejected push.
// A cycle may create new prediction records or first EV saves before close. If its push is rejected
// (another workflow pushed first), the next cycle starts from the new origin/main; by then the race may
// have closed and those saves can never be made again. This keeps them aside and puts them back.
// Rules: never overwrite what origin already has; only re-add what origin lacks, exactly as saved
// (picks, stakes, saved times, provenance); results are not carried (they are fetched again).
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadHistory,readJson,writeJsonBatch} from './history_store.mjs';

export const VALUE_FIELDS=['value_modes','value_saved_at','value_provenance','odds_snapshot_at','value_model_version','recommendations','recommendation_version'];
const hasValue=rec=>!!rec&&Object.keys(rec.value_modes||{}).length>0;
const closed=rec=>!!(rec?.settled||rec?.excluded||rec?.cancelled);
const closeTime=rec=>Date.parse(rec?.closed_at||rec?.value_provenance?.closed_at||'');
const preClose=(savedAt,rec)=>{const s=Date.parse(savedAt||''),c=closeTime(rec);return Number.isFinite(s)&&(!Number.isFinite(c)||s<c);};

// Entries the working copy has and the cycle's starting point (base) did not.
export function captureCarry(baseRecords,currentRecords){
  const carry={};
  for(const [key,rec] of Object.entries(currentRecords||{})){
    const base=baseRecords?.[key];
    if(!base){
      if(rec?.saved_at&&!closed(rec)&&preClose(rec.saved_at,rec))carry[key]={type:'record',record:rec};
    }else if(!hasValue(base)&&hasValue(rec)&&!closed(base)&&preClose(rec.value_saved_at,rec)){
      carry[key]={type:'value',fields:Object.fromEntries(VALUE_FIELDS.filter(f=>rec[f]!==undefined).map(f=>[f,rec[f]]))};
    }
  }
  return carry;
}

// Put carried saves into the latest history. Returns what was applied and what was dropped and why.
export function applyCarry(history,carry){
  const hot=history.hot,applied=[],dropped=[];
  for(const [key,entry] of Object.entries(carry||{})){
    const current=hot.records[key],elsewhere=!current&&history.keys.has(key);
    if(entry.type==='record'){
      if(elsewhere){dropped.push([key,'already_archived']);continue;}
      if(!current){hot.records[key]=entry.record;applied.push([key,'record']);continue;}
      const same=current.saved_at===entry.record.saved_at&&JSON.stringify(current.modes)===JSON.stringify(entry.record.modes);
      dropped.push([key,same?'already_saved':'conflict_kept_origin']);
    }else if(entry.type==='value'){
      if(!current){dropped.push([key,'record_missing']);continue;}
      if(hasValue(current)){dropped.push([key,JSON.stringify(current.value_modes)===JSON.stringify(entry.fields.value_modes)?'already_saved':'conflict_kept_origin']);continue;}
      if(closed(current)){dropped.push([key,'record_already_closed']);continue;}
      Object.assign(current,entry.fields);applied.push([key,'value']);
    }
  }
  return {applied,dropped};
}

function main(){
  const [mode,dataDir,carryFile,baseRef]=process.argv.slice(2);
  const hotFile=path.join(dataDir,'server-predictions.json'),indexFile=path.join(dataDir,'server-predictions-index.json'),archiveDir=path.join(dataDir,'server-predictions-archive');
  if(mode==='capture'){
    const base=JSON.parse(execFileSync('git',['show',`${baseRef}:${hotFile}`],{encoding:'utf8',maxBuffer:1<<30})).records||{};
    const carry=captureCarry(base,readJson(hotFile).records||{});
    fs.writeFileSync(carryFile,JSON.stringify(carry));
    console.log(JSON.stringify({carry_captured:Object.keys(carry).length}));
  }else if(mode==='apply'){
    if(!fs.existsSync(carryFile)){console.log(JSON.stringify({carry_applied:0}));return;}
    const history=loadHistory(hotFile,archiveDir,indexFile),before=history.keys.size;
    const {applied,dropped}=applyCarry(history,readJson(carryFile));
    for(const [key,why] of dropped)if(why==='conflict_kept_origin')console.log(`::warning::carried pre-close save for ${key} differs from origin; origin kept`);
    if(applied.length){
      const added=applied.filter(([,t])=>t==='record').length,total=before+added;
      history.hot.record_count=Object.keys(history.hot.records).length;
      if(history.hot.total_record_count!==undefined)history.hot.total_record_count=total;
      if(history.index.total_record_count!==undefined)history.index.total_record_count=total;
      writeJsonBatch([[hotFile,history.hot],[indexFile,history.index]]);
      loadHistory(hotFile,archiveDir,indexFile);   // must still be a valid history
    }
    console.log(JSON.stringify({carry_applied:applied.length,carry_dropped:dropped.length,applied,dropped}));
  }else throw Error('Usage: carry_preclose_saves.mjs capture|apply DATA_DIR CARRY_FILE [BASE_REF]');
}
if(import.meta.url===`file://${process.argv[1]}`)main();
