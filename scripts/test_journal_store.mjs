import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {mergeJournals,restore,ARTIFACT} from './journal_store.mjs';
import {emptyJournal,writeJournal,SCHEMA} from './carry_preclose_saves.mjs';

const e=(at,picks=['1-2-3'])=>({type:'record',snapshot:{picks},captured_at:at});
const J=(entries,unrecoverable={})=>({schema:SCHEMA,version:1,entries,unrecoverable});

// merge: union, the earliest captured snapshot wins, unrecoverable kept too.
{const m=mergeJournals([J({a:e('T2',['2-1-3'])}),J({a:e('T1'),b:e('T3')},{c:{...e('T0'),reason:'x'}}),emptyJournal()]);
 assert.deepEqual(m.entries,{a:e('T1'),b:e('T3')});assert.equal(m.unrecoverable.c.reason,'x');
 assert.throws(()=>mergeJournals([{schema:'other'}]),/Invalid journal/);}
// restore: union of every unexpired journal artifact; retries; failure is an error, never "empty".
{const arts=[{name:ARTIFACT,id:1},{name:ARTIFACT,id:2,expired:true},{name:'other',id:3},{name:ARTIFACT,id:4}];
 const got=[];const r=await restore({listArtifacts:async()=>arts,downloadJournal:async a=>{got.push(a.id);return a.id===1?J({a:e('T1')}):J({b:e('T2')});},wait:async()=>{}});
 assert.deepEqual(got,[1,4]);assert.deepEqual(Object.keys(r.journal.entries).sort(),['a','b']);assert.equal(r.artifacts,2);
 let n=0;const r2=await restore({listArtifacts:async()=>{if(++n<3)throw Error('API 502');return [];},downloadJournal:async()=>J({}),wait:async()=>{}});assert.equal(n,3);assert.deepEqual(r2.journal.entries,{});
 await assert.rejects(restore({listArtifacts:async()=>{throw Error('API down')},downloadJournal:async()=>J({}),wait:async()=>{}}),/journal restore failed: API down/);
 await assert.rejects(restore({listArtifacts:async()=>[{name:ARTIFACT,id:1}],downloadJournal:async()=>({schema:'broken'}),wait:async()=>{}}),/journal restore failed/);
 await assert.rejects(restore({listArtifacts:async()=>[{name:ARTIFACT,id:1}],downloadJournal:async()=>{throw Error('zip corrupt')},wait:async()=>{}}),/zip corrupt/);}
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
 // status for the upload step: keep=true when entries or unrecoverable remain; error exit on a broken file.
 const status=()=>{const out=path.join(dir,'out');fs.writeFileSync(out,'');const r=spawnSync('node',[path.join(import.meta.dirname,'journal_store.mjs'),'status',f],{encoding:'utf8',env:{...process.env,GITHUB_OUTPUT:out}});return [r.status,fs.readFileSync(out,'utf8')];};
 writeJournal(f,J({a:e('T1')}));assert.match(status()[1],/keep=true/);
 writeJournal(f,emptyJournal());assert.match(status()[1],/keep=false/);
 writeJournal(f,J({},{a:{...e('T1'),reason:'x'}}));assert.match(status()[1],/keep=true/);
 fs.writeFileSync(f,'{not json');assert.equal(status()[0],2);
 fs.rmSync(dir,{recursive:true});}
console.log('journal store OK: union restore from artifacts (earliest snapshot wins), retries, any listing/download/parse failure is an error, pending exit codes 0/1/2, upload decision');
