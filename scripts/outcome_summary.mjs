import path from 'node:path';
import {loadHistory} from './history_store.mjs';
export function summarizeOutcomeGroups(records){
  const modes=()=>Object.fromEntries(['modes','value_modes'].map(group=>[group,Object.fromEntries(['hit','balance','return'].map(mode=>[mode,{races:0,saved_investment:0,payout:0}]))]));
  const out={ordinary:modes(),excluded:{records:0,by_kind:{},saved_purchases:modes()},pending:0,cancelled:0};
  for(const rec of Object.values(records)){
    if(rec.excluded){out.excluded.records++;const kind=rec.excluded.kind||'unknown';out.excluded.by_kind[kind]=(out.excluded.by_kind[kind]||0)+1;}
    else if(rec.cancelled){out.cancelled++;continue;}
    else if(!rec.settled){out.pending++;continue;}
    for(const group of ['modes','value_modes'])for(const mode of ['hit','balance','return']){
      const m=rec[group]?.[mode];if(!m?.picks?.length||!(Number(m.stake)>0))continue;
      if(!rec.excluded&&(m.excluded||m.cancelled||m.skipped||!m.settled))continue;
      const row=(rec.excluded?out.excluded.saved_purchases:out.ordinary)[group][mode];row.races++;row.saved_investment+=Number(m.stake);if(!rec.excluded)row.payout+=Number(m.payout||0);
    }
  }
  for(const group of Object.values(out.ordinary))for(const row of Object.values(group))row.roi=row.saved_investment?row.payout/row.saved_investment*100:null;
  // Excluded saved purchases are evidence, not an inferred refund/cash balance.
  return out;
}
if(import.meta.url===`file://${process.argv[1]}`){
  const dir=process.argv[2];if(!dir)throw Error('Usage: node outcome_summary.mjs DATA_DIR');
  const history=loadHistory(path.join(dir,'server-predictions.json'),path.join(dir,'server-predictions-archive'),path.join(dir,'server-predictions-index.json'));
  console.log(JSON.stringify(summarizeOutcomeGroups({...history.hot.records,...Object.fromEntries([...history.archives.values()].flatMap(a=>Object.entries(a.records)))}),null,2));
}
