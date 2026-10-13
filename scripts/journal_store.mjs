// Durable storage of the pre-close purchase journal between runs, using workflow artifacts (kept 7 days),
// not the dependency cache (which may be evicted). Each run uploads its journal when it still has entries;
// the next run restores the union of every unexpired journal artifact. Merging never drops an entry:
// entries are closed only by confirm (origin holds the purchase) in the update cycle.
// A failed listing/download/parse is an error (exit 2), never "no purchases".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readJournal,writeJournal,emptyJournal,SCHEMA} from './carry_preclose_saves.mjs';

export const ARTIFACT='preclose-journal';

// Union of journals; for the same key the earliest captured snapshot (the purchase) is kept.
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

export async function restore({listArtifacts,downloadJournal,attempts=3,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
  let last;
  for(let i=0;i<attempts;i++){
    try{
      const list=(await listArtifacts()).filter(a=>a.name===ARTIFACT&&!a.expired);
      const journals=[];
      for(const a of list)journals.push(await downloadJournal(a));
      return {journal:mergeJournals(journals),artifacts:list.length};
    }catch(e){last=e;if(i+1<attempts)await wait(2000*(i+1));}
  }
  throw Error(`journal restore failed: ${last?.message||last}`);
}

function gh(args){return execFileSync('gh',args,{encoding:'utf8',maxBuffer:1<<30});}
async function main(){
  const [mode,file]=process.argv.slice(2),repo=process.env.GITHUB_REPOSITORY;
  if(mode==='restore'){
    const local=fs.existsSync(file)?readJournal(file):emptyJournal();
    const {journal,artifacts}=await restore({
      listArtifacts:async()=>{const out=[];for(let page=1;page<=10;page++){const r=JSON.parse(gh(['api',`repos/${repo}/actions/artifacts?name=${ARTIFACT}&per_page=100&page=${page}`]));out.push(...r.artifacts);if(r.artifacts.length<100)break;}return out;},
      downloadJournal:async a=>{
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journal-'));const zip=path.join(dir,'a.zip');
        fs.writeFileSync(zip,execFileSync('gh',['api',a.archive_download_url],{maxBuffer:1<<30}));
        execFileSync('unzip',['-q','-o',zip,'-d',dir]);
        const j=readJournal(path.join(dir,'preclose-journal.json'));fs.rmSync(dir,{recursive:true,force:true});return j;
      }
    });
    const merged=mergeJournals([local,journal]);writeJournal(file,merged);
    console.log(JSON.stringify({journal_restored_from_artifacts:artifacts,journal_entries:Object.keys(merged.entries).length}));
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`entries=${Object.keys(merged.entries).length}\n`);
  }else if(mode==='status'){
    // For the upload step: "pending" when entries remain; errors are failures.
    const n=Object.keys(readJournal(file).entries).length;
    const u=Object.keys(readJournal(file).unrecoverable).length;
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`entries=${n}\nunrecoverable=${u}\nkeep=${n+u>0?'true':'false'}\n`);
    console.log(JSON.stringify({journal_entries:n,journal_unrecoverable:u}));
    if(u)console.log(`::error::${u} pre-close purchases could not be added to origin; see the journal artifact`);
  }else throw Error('Usage: journal_store.mjs restore|status JOURNAL_FILE');
}
if(import.meta.url===`file://${process.argv[1]}`){
  try{await main();}catch(e){console.error(`::error::${e?.message||e}`);process.exit(2);}
}
