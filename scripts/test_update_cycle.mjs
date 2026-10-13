// update_cycle.sh against a local bare "origin": real history store / verification / carry-over scripts,
// stub network and model steps. No network and no real production data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const here=import.meta.dirname,tmp=fs.mkdtempSync(path.join(os.tmpdir(),'v8-cycle-')),origin=path.join(tmp,'origin.git'),work=path.join(tmp,'work'),other=path.join(tmp,'other'),bin=path.join(tmp,'bin');
const gitEnv={...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'};
const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',env:gitEnv,stdio:['ignore','pipe','ignore']}).trim();
const HOT='dev/server-predictions.json',IDX='dev/server-predictions-index.json';
const readOrigin=f=>JSON.parse(git(origin,'show',`main:${f}`));
try{
  execFileSync('git',['init','-q','--bare','-b','main',origin]);
  fs.mkdirSync(path.join(work,'scripts'),{recursive:true});fs.mkdirSync(path.join(work,'dev'));fs.mkdirSync(bin);
  for(const f of ['update_cycle.sh','carry_preclose_saves.mjs','history_store.mjs','verify_prediction_history.mjs','settlement.mjs'])fs.copyFileSync(path.join(here,f),path.join(work,'scripts',f));
  // Stub model step. PRECLOSE_KEY: save a new pre-close prediction record (only possible before close).
  // NEW_ARCHIVE: write a new month archive file (index not updated yet). Otherwise: change dev/odds.json.
  fs.writeFileSync(path.join(work,'scripts/update_server_predictions.mjs'),`
const fs=await import('node:fs');const env=process.env;
if(env.FAIL_STEP==='update_server_predictions.mjs')process.exit(9);
if(env.NEW_ARCHIVE){fs.mkdirSync('dev/server-predictions-archive',{recursive:true});fs.writeFileSync('dev/server-predictions-archive/202611.json',JSON.stringify({schema:'kyotei-v8-server-predictions-archive',version:1,month:'202611',records:{}}));}
else if(env.PRECLOSE_KEY){const hot=JSON.parse(fs.readFileSync('${HOT}','utf8'));hot.records[env.PRECLOSE_KEY]=JSON.parse(env.PRECLOSE_RECORD);hot.record_count=Object.keys(hot.records).length;fs.writeFileSync('${HOT}',JSON.stringify(hot));}
else if(!env.NO_CHANGE)fs.appendFileSync('dev/odds.json','x\\n');`);
  const stub=name=>`if(process.env.FAIL_STEP==='${name}')process.exit(9);`;
  for(const f of ['fetch_official_results.mjs','fetch_official_previews.mjs','build_runtime_payloads.mjs','backfill_expert_history.mjs'])fs.writeFileSync(path.join(work,'scripts',f),stub(f));
  fs.writeFileSync(path.join(bin,'php'),'#!/bin/sh\n[ "$FAIL_STEP" = "php" ] && exit 9\nexit 0\n');fs.chmodSync(path.join(bin,'php'),0o755);
  fs.writeFileSync(path.join(work,'dev/odds.json'),'start\n');fs.writeFileSync(path.join(work,'odds.json'),'{}\n');
  fs.writeFileSync(path.join(work,HOT),JSON.stringify({schema:'kyotei-v8-server-predictions',version:1,record_count:0,records:{}}));
  fs.writeFileSync(path.join(work,IDX),JSON.stringify({schema:'kyotei-v8-server-predictions-index',version:1,archives:[]}));
  fs.mkdirSync(path.join(work,'scripts/vendor'));fs.writeFileSync(path.join(work,'scripts/vendor/keep.txt'),'composer cache');   // untracked, must survive
  git(work,'init','-q','-b','main');git(work,'add','--','.',':!scripts/vendor');git(work,'commit','-qm','init');git(work,'remote','add','origin',origin);git(work,'push','-q','origin','main');
  execFileSync('git',['clone','-q',origin,other],{stdio:'ignore'});
  const mark=path.join(tmp,'pushed'),carry=path.join(tmp,'journal','preclose-journal.json');
  const pending=()=>fs.existsSync(carry)?Object.keys(JSON.parse(fs.readFileSync(carry,'utf8')).entries).length:0;
  const cycle=(env={})=>spawnSync('bash',['scripts/update_cycle.sh'],{cwd:work,encoding:'utf8',env:{...gitEnv,PATH:`${bin}:${process.env.PATH}`,RUNNER_TEMP:tmp,CYCLE_PUSHED_MARK:mark,CYCLE_CARRY_FILE:carry,...env}});
  const otherPush=(file,content,msg)=>{git(other,'pull','-q','origin','main');fs.writeFileSync(path.join(other,file),content);git(other,'commit','-qam',msg);git(other,'push','-q','origin','main');};
  const hook=path.join(origin,'hooks','pre-receive'),reject=on=>on?(fs.writeFileSync(hook,'#!/bin/sh\nexit 1\n'),fs.chmodSync(hook,0o755)):fs.rmSync(hook,{force:true});
  const log=()=>git(origin,'log','--format=%s','main').split('\n');

  // 1) Changed data: pushed, mark written.  2) No change: nothing pushed.
  let r=cycle();assert.equal(r.status,0,r.stderr);assert.ok(fs.existsSync(mark));assert.equal(log()[0],'chore: update live odds and predictions');
  const n=log().length;r=cycle({NO_CHANGE:'1'});assert.equal(r.status,0,r.stderr);assert.ok(!fs.existsSync(mark));assert.equal(log().length,n);
  // 3) Another workflow pushed meanwhile: the cycle starts from it and pushes on top.
  otherPush('odds.json','{"recovered":true}\n','Settle pending races');
  r=cycle();assert.equal(r.status,0,r.stderr);assert.equal(git(origin,'show','main:odds.json'),'{"recovered":true}');

  // 4) Pre-close save, push rejected, race closes, origin moved meanwhile: the save is not lost.
  const saved={date:'20261013',stadium:'24',race:'9',saved_at:'2026-10-13T05:00:00.000Z',closed_at:'2026-10-13T07:00:00.000Z',provenance:'verified_at_save',
    modes:{hit:{picks:['1-2-3','1-3-2'],stake:200,settled:false,hit:false,payout:0}},picks:['1-2-3','1-3-2'],stake:200,settled:false,source:'server'};
  const KEY='kyotei_v8_dev_result_20261013_24_09';
  reject(true);const head=git(origin,'rev-parse','main');
  r=cycle({PRECLOSE_KEY:KEY,PRECLOSE_RECORD:JSON.stringify(saved)});assert.equal(r.status,75,r.stderr);assert.equal(git(origin,'rev-parse','main'),head);assert.equal(pending(),1);
  reject(false);otherPush('odds.json','{"recovered":2}\n','Settle pending races again');
  r=cycle({NO_CHANGE:'1'});                     // after close: the model step can no longer create it
  assert.equal(r.status,0,r.stderr);assert.ok(fs.existsSync(mark));assert.equal(pending(),0);
  assert.deepEqual(readOrigin(HOT).records[KEY],saved);assert.equal(readOrigin(HOT).record_count,1);
  assert.equal(git(origin,'show','main:odds.json'),'{"recovered":2}');   // the other workflow's change is kept too

  // 5) Same key already in origin with a different save: origin is kept, carry dropped.
  const KEY2='kyotei_v8_dev_result_20261013_24_10',mine={...saved,race:'10'},theirs={...saved,race:'10',saved_at:'2026-10-13T04:00:00.000Z',modes:{hit:{picks:['2-1-3'],stake:100}}};
  reject(true);r=cycle({PRECLOSE_KEY:KEY2,PRECLOSE_RECORD:JSON.stringify(mine)});assert.equal(r.status,75);reject(false);
  git(other,'pull','-q','origin','main');{const h=JSON.parse(fs.readFileSync(path.join(other,HOT),'utf8'));h.records[KEY2]=theirs;h.record_count=Object.keys(h.records).length;fs.writeFileSync(path.join(other,HOT),JSON.stringify(h));}
  git(other,'commit','-qam','other save');git(other,'push','-q','origin','main');
  r=cycle({NO_CHANGE:'1'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout+r.stderr,/origin kept/);assert.equal(pending(),0);
  assert.deepEqual(readOrigin(HOT).records[KEY2],theirs);assert.deepEqual(readOrigin(HOT).records[KEY],saved);

  // 6) A failed cycle leaves an untracked new month archive: the next cycle removes it and the real history check passes.
  r=cycle({NEW_ARCHIVE:'1',FAIL_STEP:'backfill_expert_history.mjs'});assert.notEqual(r.status,0);
  assert.ok(fs.existsSync(path.join(work,'dev/server-predictions-archive/202611.json')));
  r=cycle({NO_CHANGE:'1'});assert.equal(r.status,0,r.stderr);assert.ok(!fs.existsSync(path.join(work,'dev/server-predictions-archive/202611.json')));
  assert.ok(fs.existsSync(path.join(work,'scripts/vendor/keep.txt')));   // dependencies/caches are not cleaned
  // 7) Other step failures: never commit; official result fetch failure is only a warning; odds fetch failure stops the cycle.
  const h2=git(origin,'rev-parse','main');r=cycle({FAIL_STEP:'update_server_predictions.mjs'});assert.notEqual(r.status,0);assert.equal(git(origin,'rev-parse','main'),h2);
  r=cycle({FAIL_STEP:'fetch_official_results.mjs'});assert.equal(r.status,0,r.stderr);assert.ok(fs.existsSync(mark));
  r=cycle({FAIL_STEP:'php'});assert.notEqual(r.status,0);

  // 8) Rejected on the last cycle of a runner: the next runner (fresh checkout, journal restored from the cache) re-adds it.
  const KEY3='kyotei_v8_dev_result_20261013_24_11',saved3={...saved,race:'11'};
  reject(true);r=cycle({PRECLOSE_KEY:KEY3,PRECLOSE_RECORD:JSON.stringify(saved3)});assert.equal(r.status,75);reject(false);assert.equal(pending(),1);
  const runner2=path.join(tmp,'runner2');execFileSync('git',['clone','-q','--depth=1',`file://${origin}`,runner2],{stdio:'ignore'});
  for(const f of fs.readdirSync(path.join(work,'scripts')))if(f!=='vendor')fs.copyFileSync(path.join(work,'scripts',f),path.join(runner2,'scripts',f));
  const restored=path.join(tmp,'runner2-journal','preclose-journal.json');fs.mkdirSync(path.dirname(restored));fs.copyFileSync(carry,restored);   // actions/cache restore
  r=spawnSync('bash',['scripts/update_cycle.sh'],{cwd:runner2,encoding:'utf8',env:{...gitEnv,PATH:`${bin}:${process.env.PATH}`,RUNNER_TEMP:tmp,CYCLE_PUSHED_MARK:mark,CYCLE_CARRY_FILE:restored,NO_CHANGE:'1'}});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(readOrigin(HOT).records[KEY3],saved3);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(restored,'utf8')).entries),[]);
  console.log('update cycle OK: pushes changes, skips no-ops, starts from latest origin, rejected pre-close save survives a close and is re-added exactly, origin wins on conflict, failed-cycle archive leftovers cleaned (vendor kept), failed steps never commit, journal restored on a new runner');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
