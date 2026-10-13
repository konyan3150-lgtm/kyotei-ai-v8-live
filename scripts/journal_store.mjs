// Durable storage of the pre-close purchase journal between runs: a dedicated git branch
// (refs/heads/ops/preclose-journal, one file preclose-journal.json). Workflow artifacts are not used: a re-run of a
// workflow run deletes the artifacts of its earlier attempts (checked on GitHub), and the dependency cache may be
// evicted. Git history keeps every saved state.
//  restore: reads the branch; "branch does not exist yet" is an empty journal, any other failure (fetch error,
//           missing or invalid file) is an error (exit 2), never "no purchases". Result is the union with any local file.
//  save:    writes the current journal as a new commit on the branch without touching the work tree, pushes it, and
//           reads it back from origin to confirm. Only one update run runs at a time (concurrency group).
//  Entries are closed only by confirm (origin/main holds the purchase) in the update cycle; saving the confirmed state
//  is safe because restore succeeded before any change was made.
import fs from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {readJournal,writeJournal,emptyJournal,SCHEMA} from './carry_preclose_saves.mjs';

export const BRANCH='ops/preclose-journal',FILE='preclose-journal.json';
const REF=`refs/heads/${BRANCH}`,LOCAL='refs/v8/preclose-journal';

export function mergeJournals(journals){
  const out=emptyJournal();
  for(const j of journals){
    if(j?.schema!==SCHEMA||j.version!==1||!j.entries||typeof j.entries!=='object'||Array.isArray(j.entries))throw Error('Invalid journal in merge');
    for(const part of ['entries','unrecoverable'])for(const [key,e] of Object.entries(j[part]||{})){
      const cur=out[part][key];
      if(!cur||String(e.captured_at||'')<String(cur.captured_at||''))out[part][key]=e;
    }
  }
  return out;
}
const validate=j=>{mergeJournals([j]);if(j.unrecoverable!==undefined&&(typeof j.unrecoverable!=='object'||Array.isArray(j.unrecoverable)))throw Error('Invalid journal');return {...j,unrecoverable:j.unrecoverable||{}};};

const git=(args,opts={})=>execFileSync('git',args,{encoding:'utf8',maxBuffer:1<<30,stdio:['pipe','pipe','pipe'],...opts});
// Returns the commit of the journal branch on origin, or null when the branch does not exist. Errors throw.
export function fetchBranch(cwd,remote='origin'){
  const r=spawnSync('git',['ls-remote','--exit-code',remote,REF],{cwd,encoding:'utf8'});
  if(r.status===2)return null;                          // no such ref: nothing saved yet
  if(r.status!==0)throw Error(`ls-remote failed: ${(r.stderr||'').trim()}`);
  git(['fetch','--quiet','--depth=1',remote,`+${REF}:${LOCAL}`],{cwd});
  return git(['rev-parse',LOCAL],{cwd}).trim();
}
export function readBranchJournal(cwd,commit){
  let text;try{text=git(['show',`${commit}:${FILE}`],{cwd});}catch{throw Error(`${FILE} missing on ${BRANCH}`);}
  let j;try{j=JSON.parse(text);}catch{throw Error(`${FILE} on ${BRANCH} is not valid JSON`);}
  if(j?.schema!==SCHEMA)throw Error(`${FILE} on ${BRANCH} has an invalid schema`);
  return validate(j);
}
export function restore(cwd,file,{remote='origin',attempts=3,sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}){
  let last;
  for(let i=0;i<attempts;i++){
    try{
      const commit=fetchBranch(cwd,remote),saved=commit?readBranchJournal(cwd,commit):emptyJournal();
      const local=fs.existsSync(file)?readJournal(file):emptyJournal();
      const merged=mergeJournals([saved,local]);writeJournal(file,merged);
      return {commit,journal:merged};
    }catch(e){last=e;if(i+1<attempts)sleep(2000*(i+1));}
  }
  throw Error(`journal restore failed: ${last?.message||last}`);
}
export function save(cwd,file,{remote='origin',attempts=3,message='pre-close purchase journal'}={}){
  const journal=readJournal(file),text=JSON.stringify(journal);let last;
  for(let i=0;i<attempts;i++){
    try{
      const parent=fetchBranch(cwd,remote);
      if(parent&&JSON.stringify(readBranchJournal(cwd,parent))===text)return {commit:parent,changed:false};
      const blob=git(['hash-object','-w','--stdin'],{cwd,input:text}).trim();
      const tree=git(['mktree'],{cwd,input:`100644 blob ${blob}\t${FILE}\n`}).trim();
      const env={...process.env,GIT_AUTHOR_NAME:'github-actions[bot]',GIT_AUTHOR_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com',GIT_COMMITTER_NAME:'github-actions[bot]',GIT_COMMITTER_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com'};
      const commit=git(['commit-tree',tree,...(parent?['-p',parent]:[]),'-m',message],{cwd,env}).trim();
      git(['push','--quiet',remote,`${commit}:${REF}`],{cwd});
      // Read back from origin to confirm what is stored.
      const stored=fetchBranch(cwd,remote);
      if(stored!==commit||JSON.stringify(readBranchJournal(cwd,stored))!==text)throw Error('saved journal could not be read back');
      return {commit,changed:true};
    }catch(e){last=e;}
  }
  throw Error(`journal save failed: ${last?.message||last}`);
}

function main(){
  const [mode,file]=process.argv.slice(2),cwd=process.cwd();
  if(mode==='restore'){
    const {commit,journal}=restore(cwd,file);
    console.log(JSON.stringify({journal_branch_commit:commit,journal_entries:Object.keys(journal.entries).length,journal_unrecoverable:Object.keys(journal.unrecoverable).length}));
  }else if(mode==='save'){
    const r=save(cwd,file),j=readJournal(file),u=Object.keys(j.unrecoverable).length;
    console.log(JSON.stringify({journal_saved:r.changed,journal_branch_commit:r.commit,journal_entries:Object.keys(j.entries).length,journal_unrecoverable:u}));
    if(u)console.log(`::error::${u} pre-close purchases could not be added to origin; see ${BRANCH}`);
  }else throw Error('Usage: journal_store.mjs restore|save JOURNAL_FILE');
}
if(import.meta.url===`file://${process.argv[1]}`){
  try{main();}catch(e){console.error(`::error::${e?.message||e}`);process.exit(2);}
}
