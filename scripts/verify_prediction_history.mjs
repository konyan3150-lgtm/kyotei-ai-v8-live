import path from 'node:path';
import fs from 'node:fs';
import {loadHistory,readJson} from './history_store.mjs';

export function verifyHistory(root, baselineFile, save=false) {
  const snapshot=loadHistory(path.join(root,'server-predictions.json'),path.join(root,'server-predictions-archive'),path.join(root,'server-predictions-index.json'));
  const records={...snapshot.hot.records,...Object.fromEntries([...snapshot.archives.values()].flatMap(x=>Object.entries(x.records)))};
  const purchases=rec=>Object.fromEntries(['modes','value_modes'].map(group=>[group,Object.fromEntries(Object.entries(rec[group]||{}).map(([mode,m])=>[mode,{picks:m.picks||[],stake:m.stake,items:(m.items||[]).map(x=>({combo:x.combo,stake:x.stake}))}]))]));
  if(save) fs.writeFileSync(baselineFile,JSON.stringify({keys:[...snapshot.keys].sort(),purchases:Object.fromEntries(Object.entries(records).map(([key,rec])=>[key,purchases(rec)]))}));
  else {
    const baseline=readJson(baselineFile);
    if(!Array.isArray(baseline.keys))throw Error('Invalid preservation baseline');
    for(const key of baseline.keys)if(!snapshot.keys.has(key))throw Error(`History would lose record: ${key}`);
    for(const [key,groups]of Object.entries(baseline.purchases||{})){
      const current=purchases(records[key]);
      for(const [group,modes]of Object.entries(groups))for(const [mode,before]of Object.entries(modes))if(JSON.stringify(current[group]?.[mode])!==JSON.stringify(before))throw Error(`Saved purchase changed: ${key} ${group}.${mode}`);
    }
  }
  return {records:snapshot.keys.size,archives:snapshot.archives.size};
}
if(import.meta.url===`file://${process.argv[1]}`) {
  if(!process.argv[2]||!process.argv[3])throw Error('Usage: verify_prediction_history.mjs DATA_DIR BASELINE_FILE [--save-baseline]');
  console.log(JSON.stringify(verifyHistory(process.argv[2],process.argv[3],process.argv.includes('--save-baseline'))));
}
