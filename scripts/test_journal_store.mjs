import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {mergeJournals,BRANCH} from './journal_store.mjs';
import {execFileSync} from 'node:child_process';
import {emptyJournal,writeJournal,readJournal,SCHEMA} from './carry_preclose_saves.mjs';

const e=(at,picks=['1-2-3'])=>({type:'record',snapshot:{picks},captured_at:at});
const J=(entries,unrecoverable={})=>({schema:SCHEMA,version:1,entries,unrecoverable});

// merge: union, the earliest captured snapshot wins, unrecoverable kept too.
{const m=mergeJournals([J({a:e('T2',['2-1-3'])}),J({a:e('T1'),b:e('T3')},{c:{...e('T0'),reason:'x'}}),emptyJournal()]);
 assert.deepEqual(m.entries,{a:e('T1'),b:e('T3')});assert.equal(m.unrecoverable.c.reason,'x');
 assert.throws(()=>mergeJournals([{schema:'other'}]),/Invalid journal/);}
// Git branch storage, against a local bare origin (fresh clones play the next runners).
{const d=fs.mkdtempSync(path.join(os.tmpdir(),'v8-jb-')),origin=path.join(d,'origin.git'),A=path.join(d,'a'),B=path.join(d,'b');
 const env={...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'};
 const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',env,stdio:['ignore','pipe','ignore']}).trim();
 execFileSync('git',['init','-q','--bare','-b','main',origin]);execFileSync('git',['clone','-q',origin,A],{stdio:'ignore'});
 fs.writeFileSync(path.join(A,'x.txt'),'main');git(A,'add','.');git(A,'commit','-qm','main');git(A,'push','-q','origin','main');
 execFileSync('git',['clone','-q','--depth=1',`file://${origin}`,B],{stdio:'ignore'});
 const cli=(cwd,mode,file,extra={})=>spawnSync('node',[path.join(import.meta.dirname,'journal_store.mjs'),mode,file],{cwd,encoding:'utf8',env:{...env,...extra}});
 const fa=path.join(d,'ja.json'),fb=path.join(d,'jb.json');
 // Nothing saved yet: restore gives an empty journal (exit 0).
 let r=cli(A,'restore',fa);assert.equal(r.status,0,r.stderr);assert.deepEqual(readJournal(fa).entries,{});
 // Save: a commit on the journal branch; main, HEAD and the work tree are untouched.
 const head=git(A,'rev-parse','HEAD');writeJournal(fa,J({a:e('T1')}));r=cli(A,'save',fa);assert.equal(r.status,0,r.stderr);
 assert.equal(git(A,'rev-parse','HEAD'),head);assert.equal(git(A,'status','--porcelain'),'');assert.equal(git(origin,'rev-parse','main'),head);
 assert.deepEqual(JSON.parse(git(origin,'show',`${BRANCH}:preclose-journal.json`)).entries,{a:e('T1')});
 // Next runner (fresh shallow clone): restored; union with an existing local file; earliest snapshot wins.
 writeJournal(fb,J({a:e('T0',['9-9-9']),b:e('T2')}));r=cli(B,'restore',fb);assert.equal(r.status,0,r.stderr);
 assert.deepEqual(readJournal(fb).entries,{a:e('T0',['9-9-9']),b:e('T2')});
 // Save again (confirmed entries removed): history keeps the old state; unchanged save makes no commit.
 writeJournal(fb,J({b:e('T2')}));r=cli(B,'save',fb);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/"journal_saved":true/);
 r=cli(B,'save',fb);assert.match(r.stdout,/"journal_saved":false/);
 assert.equal(git(origin,'rev-list','--count',BRANCH),'2');
 // Errors are never "empty": missing file on the branch, invalid JSON, invalid schema, unreachable origin.
 const put=content=>{const blob=execFileSync('git',['hash-object','-w','--stdin'],{cwd:A,input:content,encoding:'utf8'}).trim();
   const tree=execFileSync('git',['mktree'],{cwd:A,input:content===null?'':`100644 blob ${blob}\t${content==='README'?'README.txt':'preclose-journal.json'}\n`,encoding:'utf8'}).trim();
   const c=execFileSync('git',['commit-tree',tree,'-m','x'],{cwd:A,encoding:'utf8',env}).trim();git(A,'push','-q','-f','origin',`${c}:refs/heads/${BRANCH}`);};
 for(const [content,msg] of [['README',/missing on/],['{not json',/not valid JSON/],[JSON.stringify({schema:'other'}),/invalid schema/]]){
   put(content);fs.rmSync(fa,{force:true});r=cli(A,'restore',fa,{});assert.equal(r.status,2,content);assert.match(r.stderr,msg);assert.ok(!fs.existsSync(fa));}
 git(A,'remote','set-url','origin',path.join(d,'missing.git'));fs.rmSync(fa,{force:true});r=cli(A,'restore',fa);assert.equal(r.status,2);assert.match(r.stderr,/journal restore failed/);assert.ok(!fs.existsSync(fa));
 r=cli(A,'save',fb);assert.equal(r.status,2);
 fs.rmSync(d,{recursive:true,force:true});}
// CLI exit codes: pending 0 = entries pending, 1 = empty, 2 = error (corrupt JSON, invalid schema, bad mode). Never "empty" on error.
{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v8-js-')),f=path.join(dir,'j.json');
 const pend=()=>spawnSync('node',[path.join(import.meta.dirname,'carry_preclose_saves.mjs'),'pending','dev',f],{encoding:'utf8'}).status;
 assert.equal(pend(),1);                                         // no journal yet: empty
 writeJournal(f,emptyJournal());assert.equal(pend(),1);
 writeJournal(f,J({a:e('T1')}));assert.equal(pend(),0);
 writeJournal(f,J({},{a:{...e('T1'),reason:'record_missing'}}));assert.equal(pend(),1);   // unrecoverable only: reported, not "pending"
 fs.writeFileSync(f,'{not json');assert.equal(pend(),2);
 fs.writeFileSync(f,JSON.stringify({schema:'other',version:1,entries:{}}));assert.equal(pend(),2);
 fs.writeFileSync(f,JSON.stringify({schema:SCHEMA,version:1,entries:[]}));assert.equal(pend(),2);
 assert.equal(spawnSync('node',[path.join(import.meta.dirname,'carry_preclose_saves.mjs'),'nope','dev',f]).status,2);
 fs.rmSync(dir,{recursive:true});}
console.log('journal store OK: git branch storage (save without touching main/work tree, read back, next runner restores, union, history kept), missing/invalid/unreachable is an error, pending exit codes 0/1/2');
