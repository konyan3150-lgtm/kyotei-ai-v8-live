import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw new Error(`Cannot read valid JSON: ${file}`, {cause: error});
  }
}
function validateRecords(document, schema, file) {
  if(document?.schema !== schema || document.version !== 1 || !document.records ||
     typeof document.records !== 'object' || Array.isArray(document.records)) throw Error(`Invalid history schema: ${file}`);
  for(const [key, record] of Object.entries(document.records)) {
    if(!record || typeof record !== 'object' || Array.isArray(record)) throw Error(`Invalid record: ${file} ${key}`);
  }
  if(document.record_count !== undefined && document.record_count !== Object.keys(document.records).length) throw Error(`History count mismatch: ${file}`);
}
export function loadHistory(out, archiveDir, indexFile) {
  const hot=readJson(out,{schema:'kyotei-v8-server-predictions',version:1,records:{}});
  validateRecords(hot,'kyotei-v8-server-predictions',out);
  const index=readJson(indexFile,{schema:'kyotei-v8-server-predictions-index',version:1,archives:[]});
  if(index.schema !== 'kyotei-v8-server-predictions-index' || index.version !== 1 || !Array.isArray(index.archives)) throw Error(`Invalid history index: ${indexFile}`);
  const archives=new Map(), keys=new Set(Object.keys(hot.records));
  const names=fs.existsSync(archiveDir)?fs.readdirSync(archiveDir).filter(n=>/^\d{6}\.json$/.test(n)):[];
  for(const name of names) {
    const file=path.join(archiveDir,name), doc=readJson(file);
    validateRecords(doc,'kyotei-v8-server-predictions-archive',file);
    if(doc.month !== name.slice(0,6)) throw Error(`Archive month mismatch: ${file}`);
    archives.set(doc.month,doc);
    for(const key of Object.keys(doc.records)) {
      if(keys.has(key)) throw Error(`Duplicate history key: ${key}`);
      keys.add(key);
    }
  }
  const listed=new Set();
  for(const entry of index.archives) {
    if(!/^server-predictions-archive\/\d{6}\.json$/.test(entry.file)) throw Error('Unsafe archive index path');
    const month=entry.file.slice(-11,-5), doc=archives.get(month);
    if(listed.has(month) || !doc || entry.record_count !== Object.keys(doc.records).length) throw Error(`Archive index mismatch: ${entry.file}`);
    listed.add(month);
  }
  if(listed.size !== archives.size) throw Error('Unindexed archive file');
  if(index.total_record_count !== undefined && index.total_record_count !== keys.size) throw Error('History total count mismatch');
  if(hot.total_record_count !== undefined && hot.total_record_count !== keys.size) throw Error('Hot total count mismatch');
  return {hot,index,archives,keys};
}
export function assertRetained(before, hotRecords, archiveDocuments) {
  const after=new Set(Object.keys(hotRecords));
  for(const doc of archiveDocuments)for(const key of Object.keys(doc.records)) {
    if(after.has(key)) throw Error(`Duplicate resulting history key: ${key}`);
    after.add(key);
  }
  for(const key of before) if(!after.has(key)) throw Error(`History would lose record: ${key}`);
  return after.size;
}
// Stage and validate every output before replacing any original. Each rename is atomic;
// multiple files are not one filesystem transaction. Index is installed last by caller.
export function writeJsonBatch(entries, {beforeRename}={}) {
  const prepared=entries.map(([file,value])=>({file,text:JSON.stringify(value)+'\n'}));
  for(const item of prepared) JSON.parse(item.text);
  const staged=[];
  try {
    for(const item of prepared) {
      fs.mkdirSync(path.dirname(item.file),{recursive:true});
      const temp=item.file+'.tmp-'+randomUUID(); staged.push({...item,temp});
      const fd=fs.openSync(temp,'wx',0o644);
      try { fs.writeFileSync(fd,item.text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      JSON.parse(fs.readFileSync(temp,'utf8'));
    }
    beforeRename?.();
    for(const item of staged) fs.renameSync(item.temp,item.file);
  } finally {
    for(const item of staged) if(fs.existsSync(item.temp)) fs.unlinkSync(item.temp);
  }
}
