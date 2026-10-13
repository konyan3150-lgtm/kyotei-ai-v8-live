// update_cycle.sh against a local bare "origin" with stub data scripts (no network, no real production data).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'v8-cycle-')),origin=path.join(tmp,'origin.git'),work=path.join(tmp,'work'),other=path.join(tmp,'other'),bin=path.join(tmp,'bin');
const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}}).trim();
try{
  execFileSync('git',['init','-q','--bare','-b','main',origin]);
  fs.mkdirSync(path.join(work,'scripts'),{recursive:true});fs.mkdirSync(path.join(work,'dev'));fs.mkdirSync(bin);
  fs.copyFileSync(path.resolve(import.meta.dirname,'update_cycle.sh'),path.join(work,'scripts/update_cycle.sh'));
  // Stubs: each data step appends a line to dev/odds.json unless NO_CHANGE is set; a step can be told to fail.
  const stub=`if(process.env.FAIL_STEP===process.argv[1].split('/').pop())process.exit(9);if(!process.env.NO_CHANGE&&process.argv[1].endsWith('update_server_predictions.mjs')){require('fs').appendFileSync('dev/odds.json','x\\n')}`;
  for(const f of ['verify_prediction_history.mjs','fetch_official_results.mjs','fetch_official_previews.mjs','build_runtime_payloads.mjs','update_server_predictions.mjs','backfill_expert_history.mjs'])
    fs.writeFileSync(path.join(work,'scripts',f),stub.replace("require('fs')","(await import('node:fs'))"));
  fs.writeFileSync(path.join(bin,'php'),'#!/bin/sh\n[ "$FAIL_STEP" = "php" ] && exit 9\nexit 0\n');fs.chmodSync(path.join(bin,'php'),0o755);
  fs.writeFileSync(path.join(work,'dev/odds.json'),'start\n');fs.writeFileSync(path.join(work,'odds.json'),'{}\n');
  git(work,'init','-q','-b','main');git(work,'add','.');git(work,'commit','-qm','init');git(work,'remote','add','origin',origin);git(work,'push','-q','origin','main');
  const mark=path.join(tmp,'pushed');
  const cycle=(env={})=>spawnSync('bash',['scripts/update_cycle.sh'],{cwd:work,encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,RUNNER_TEMP:tmp,CYCLE_PUSHED_MARK:mark,...env}});
  const remoteLog=()=>git(origin,'log','--format=%s','main').split('\n');

  // 1) Changed data: committed and pushed to origin/main, mark written.
  let r=cycle();assert.equal(r.status,0,r.stderr);assert.ok(fs.existsSync(mark));
  assert.equal(remoteLog()[0],'chore: update live odds and predictions');assert.equal(git(origin,'show','main:dev/odds.json'),'start\nx');
  // 2) No change: exits 0, nothing pushed, no mark.
  const before=remoteLog().length;r=cycle({NO_CHANGE:'1'});assert.equal(r.status,0,r.stderr);assert.ok(!fs.existsSync(mark));assert.equal(remoteLog().length,before);
  // 3) Someone else pushed meanwhile: this cycle starts from their commit (not a stale copy) and pushes on top.
  execFileSync('git',['clone','-q',origin,other]);fs.writeFileSync(path.join(other,'odds.json'),'{"recovered":true}\n');git(other,'commit','-qam','Settle pending races');git(other,'push','-q','origin','main');
  r=cycle();assert.equal(r.status,0,r.stderr);assert.equal(git(origin,'show','main:odds.json'),'{"recovered":true}');assert.equal(remoteLog()[1],'Settle pending races');
  // 4) Push rejected (remote moved during the cycle): non-zero exit, nothing overwritten; the next cycle recovers from origin.
  const hook=path.join(origin,'hooks','pre-receive');fs.writeFileSync(hook,'#!/bin/sh\nexit 1\n');fs.chmodSync(hook,0o755);
  const headBefore=git(origin,'rev-parse','main');r=cycle();assert.notEqual(r.status,0);assert.ok(!fs.existsSync(mark));assert.equal(git(origin,'rev-parse','main'),headBefore);
  fs.rmSync(hook);r=cycle();assert.equal(r.status,0,r.stderr);assert.ok(fs.existsSync(mark));
  assert.equal(git(work,'rev-parse','HEAD'),git(origin,'rev-parse','main'));
  // 5) A failing step stops the cycle before any commit; a leftover dirty file is discarded by the next cycle.
  const head2=git(origin,'rev-parse','main');r=cycle({FAIL_STEP:'backfill_expert_history.mjs'});assert.notEqual(r.status,0);assert.equal(git(origin,'rev-parse','main'),head2);
  assert.notEqual(git(work,'status','--porcelain','--','dev/odds.json'),'');            // left dirty by the failed cycle
  r=cycle({NO_CHANGE:'1'});assert.equal(r.status,0,r.stderr);assert.equal(git(work,'status','--porcelain','--','dev/odds.json'),'');assert.equal(git(origin,'rev-parse','main'),head2);
  // 6) Official result/preview fetch failures are warnings (fresh odds still saved), odds fetch failure is not.
  r=cycle({FAIL_STEP:'fetch_official_results.mjs'});assert.equal(r.status,0,r.stderr);assert.ok(fs.existsSync(mark));
  r=cycle({FAIL_STEP:'php'});assert.notEqual(r.status,0);
  // 7) A new untracked file under a data path (e.g. new month archive) is committed.
  fs.mkdirSync(path.join(work,'dev/server-predictions-archive'),{recursive:true});
  const add=`if(!process.env.NO_CHANGE){const fs=await import('node:fs');fs.mkdirSync('dev/server-predictions-archive',{recursive:true});fs.writeFileSync('dev/server-predictions-archive/202611.json','{}')}`;
  fs.writeFileSync(path.join(work,'scripts/update_server_predictions.mjs'),add);git(work,'add','scripts/update_server_predictions.mjs');git(work,'commit','-qm','stub');git(work,'push','-q','origin','main');
  r=cycle();assert.equal(r.status,0,r.stderr);assert.equal(git(origin,'show','main:dev/server-predictions-archive/202611.json'),'{}');
  console.log('update cycle OK: pushes changes, skips no-ops, starts from latest origin, rejected push leaves origin untouched and next cycle recovers, failed steps never commit, official fetch failures are warnings, new archive files included');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
