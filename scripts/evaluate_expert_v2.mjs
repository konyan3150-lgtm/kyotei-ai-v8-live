// Descriptive prospective evaluation; baseline returns do not measure Expert-driven bets.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const closeMs=r=>Date.parse(String(r.closed_at||'').replace(' ','T')+'+09:00');
export function evaluate(records){
  const saved=Object.values(records).filter(r=>r.version===2&&!r.reconstructed);
  const valid=saved.filter(r=>r.captured_before_close&&Number.isFinite(Date.parse(r.saved_at))&&Number.isFinite(closeMs(r))&&Date.parse(r.saved_at)<closeMs(r));
  const settled=valid.filter(r=>r.outcome?.result);
  function summarize(rs){
    const n=rs.length,wins=rs.filter(r=>r.outcome.inside_won).length,modes={};
    for(const r of rs)for(const [group,label] of [['baseline_modes','v8'],['baseline_value_modes','value']])for(const [mode,x] of Object.entries(r.outcome[group]||{})){
      if(!Number(x.stake))continue;const s=modes[label+'_'+mode]??={races:0,hits:0,stake:0,payout:0};s.races++;if(x.hit)s.hits++;s.stake+=Number(x.stake);s.payout+=Number(x.payout||0);
    }
    for(const s of Object.values(modes)){s.hit_rate=s.hits/s.races;s.return_rate=s.payout/s.stake}
    return{races:n,inside_wins:wins,inside_win_rate:n?wins/n:null,baseline_performance:modes};
  }
  const groups=field=>Object.fromEntries([...new Set(settled.map(r=>r[field]))].sort().map(k=>[k,summarize(settled.filter(r=>r[field]===k))]));
  return{version:2,saved:saved.length,valid_preclose:valid.length,excluded:saved.length-valid.length,settled:settled.length,
    pending:valid.length-settled.length,overall:summarize(settled),by_active:groups('active'),by_date:groups('date'),by_stadium:groups('stadium'),
    interpretation:'Expert classification only. Baseline returns are descriptive; no Expert-driven prediction improvement has been tested.'};
}
if(import.meta.url===`file://${process.argv[1]}`){
  const dir=process.argv[2]||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dev/expert-v2-archive');
  const records={};for(const f of fs.readdirSync(dir).filter(f=>/^\d{8}\.json$/.test(f)))Object.assign(records,JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')).records);
  console.log(JSON.stringify(evaluate(records),null,2));
}
