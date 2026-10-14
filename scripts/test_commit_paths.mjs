// commit_paths.sh against a local bare origin: retries a rejected push from the latest origin, keeps other commits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'v8-commit-')),origin=path.join(tmp,'o.git'),work=path.join(tmp,'w'),other=path.join(tmp,'x');
const env={...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'};
const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',env,stdio:['ignore','pipe','ignore']}).trim();
const run=()=>spawnSync('bash',[path.resolve(import.meta.dirname,'commit_paths.sh'),'chore: update next-day race program','dev/tomorrow.json','tomorrow.json','dev/tide.json'],{cwd:work,encoding:'utf8',env});
try{
  execFileSync('git',['init','-q','--bare','-b','main',origin]);execFileSync('git',['clone','-q',origin,work],{stdio:'ignore'});
  fs.mkdirSync(path.join(work,'dev'));for(const f of ['dev/tomorrow.json','tomorrow.json','dev/tide.json','odds.json'])fs.writeFileSync(path.join(work,f),'old');
  git(work,'add','.');git(work,'commit','-qm','init');git(work,'push','-q','origin','main');execFileSync('git',['clone','-q',origin,other],{stdio:'ignore'});
  // 1) No change: nothing pushed.
  const head=git(origin,'rev-parse','main');let r=run();assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/No changes/);assert.equal(git(origin,'rev-parse','main'),head);
  // 2) Another workflow pushed after our checkout: the first push is rejected, the retry starts from origin and keeps both.
  fs.writeFileSync(path.join(work,'dev/tomorrow.json'),'new program');fs.writeFileSync(path.join(work,'tomorrow.json'),'new program');fs.writeFileSync(path.join(work,'dev/tide.json'),'new tide');
  fs.writeFileSync(path.join(other,'odds.json'),'fresh odds');git(other,'commit','-qam','chore: update live odds and predictions');git(other,'push','-q','origin','main');
  r=run();assert.equal(r.status,0,r.stderr);assert.match(r.stdout+r.stderr,/push rejected \(attempt 1\)/);assert.match(r.stdout,/Pushed on attempt 2/);
  assert.equal(git(origin,'show','main:odds.json'),'fresh odds');assert.equal(git(origin,'show','main:dev/tomorrow.json'),'new program');assert.equal(git(origin,'show','main:dev/tide.json'),'new tide');
  assert.deepEqual(git(origin,'log','--format=%s','-2','main').split('\n'),['chore: update next-day race program','chore: update live odds and predictions']);
  // 3) Origin keeps rejecting: fails after 4 attempts, origin unchanged.
  const hook=path.join(origin,'hooks','pre-receive');fs.writeFileSync(hook,'#!/bin/sh\nexit 1\n');fs.chmodSync(hook,0o755);
  fs.writeFileSync(path.join(work,'dev/tide.json'),'newer tide');const h2=git(origin,'rev-parse','main');
  r=run();assert.equal(r.status,1);assert.match(r.stdout+r.stderr,/push failed after 4 attempts/);assert.equal(git(origin,'rev-parse','main'),h2);
  console.log('commit_paths OK: no-op, retry from latest origin keeps other workflows\' commits, bounded failure');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
