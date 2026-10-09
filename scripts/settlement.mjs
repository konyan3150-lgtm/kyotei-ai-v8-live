// Both update paths use this contract. Saved purchases are never reconstructed.
const groups=['modes','value_modes'];
export function isValidTrifecta(result){
  const combo=result?.combination,amount=result?.amount;
  return result?.official_special!==true&&result?.refund!==true&&typeof combo==='string'&&/^[1-6]-[1-6]-[1-6]$/.test(combo)&&new Set(combo.split('-')).size===3&&
    (typeof amount==='number'||typeof amount==='string'&&amount.trim()!=='')&&Number.isSafeInteger(Number(amount))&&Number(amount)>0;
}
export function cancel(rec,{source='inferred',reason='race_cancelled'}={}){
  if(!rec||rec.settled||rec.excluded)return rec;
  if(!['official','inferred'].includes(source))throw Error('Invalid cancellation source');
  if(rec.cancelled&&rec.cancellation_source!=='inferred')return rec;
  if(!rec.cancelled)rec.cancellation_mode_state=Object.fromEntries(groups.map(group=>[group,Object.fromEntries(Object.entries(rec[group]||{}).map(([name,m])=>[name,{skipped:m.skipped}]))]));
  rec.cancelled=true;rec.cancellation_source=source;rec.cancellation_reason=reason;rec.cancelled_at=new Date().toISOString();rec.hit=false;rec.payout=0;
  for(const group of groups)for(const m of Object.values(rec[group]||{})){m.cancelled=true;m.skipped=true;m.settled=false;m.hit=false;m.payout=0;}
  return rec;
}
export function settle(rec,result,{source='feed'}={}){
  if(!rec||rec.settled||rec.excluded||!isValidTrifecta(result))return rec;
  if(rec.cancelled&&(rec.cancellation_source!=='inferred'||source!=='official'))return rec;
  const combo=result.combination,amount=Number(result.amount);
  // Ambiguous historical EV purchases stay pending; do not invent a 100-yen unit.
  for(const m of Object.values(rec.value_modes||{}))if(m.picks?.includes(combo)){
    const item=m.items?.find(x=>x.combo===combo);
    if(!Number.isSafeInteger(item?.stake)||item.stake<=0||item.stake%100!==0)return rec;
  }
  if(rec.cancelled){
    rec.cancellation_review={source:'official',previous_cancelled_at:rec.cancelled_at,previous_reason:rec.cancellation_reason,reviewed_at:new Date().toISOString()};
    for(const group of groups)for(const [name,m]of Object.entries(rec[group]||{})){
      const previous=rec.cancellation_mode_state?.[group]?.[name];
      delete m.cancelled;if(previous?.skipped===undefined)delete m.skipped;else m.skipped=previous.skipped;
    }
    delete rec.cancelled;delete rec.cancelled_at;delete rec.cancellation_source;delete rec.cancellation_reason;delete rec.cancellation_mode_state;
  }
  for(const group of groups)for(const m of Object.values(rec[group]||{})){
    m.settled=true;m.result=combo;m.hit=Array.isArray(m.picks)&&m.picks.includes(combo);
    const item=group==='value_modes'?m.items?.find(x=>x.combo===combo):null;
    m.payout=m.hit?amount*(group==='value_modes'?item.stake/100:1):0;
  }
  const selected=rec.modes?.[rec.mode||'hit'];rec.settled=true;rec.result=combo;rec.hit=!!selected?.hit;rec.payout=Number(selected?.payout||0);rec.settled_at=new Date().toISOString();
  if(rec.expert_snapshot)rec.expert_result={active:rec.expert_snapshot.active,label:rec.expert_snapshot.label,result:combo,winner:combo[0],inside_won:combo[0]==='1',modes:modeResult(rec.modes),value_modes:modeResult(rec.value_modes),settled_at:rec.settled_at};
  return rec;
}
function modeResult(group){return Object.fromEntries(Object.entries(group||{}).map(([name,m])=>[name,{hit:!!m.hit,stake:Number(m.stake||0),payout:Number(m.payout||0)}]));}
export function applyResults(records,payload){
  let settled=0,cancelled=0,excluded=0;
  for(const rec of Object.values(records||{})){
    if(rec.settled||rec.excluded||rec.date!==payload.date)continue;
    const result=payload.races?.[String(Number(rec.stadium))]?.[String(Number(rec.race))];if(!result)continue;
    if(result.excluded){exclude(rec,result);if(rec.excluded)excluded++;continue;}
    if(result.cancelled){if(!rec.cancelled||rec.cancellation_source==='inferred'){cancel(rec,{source:'official'});cancelled++;}continue;}
    settle(rec,result,{source:'official'});if(rec.settled)settled++;
  }
  return {settled,cancelled,excluded};
}

export function exclude(rec,result){
  const proof=result?.verification;
  if(!rec||rec.settled||rec.excluded||rec.cancelled&&rec.cancellation_source!=='inferred')return rec;
  if(!result?.excluded?.confirmed||!proof||!/^[0-9a-f]{64}$/.test(proof.html_sha256||'')||String(proof.request?.date)!==String(rec.date)||Number(proof.request?.stadium)!==Number(rec.stadium)||Number(proof.request?.race)!==Number(rec.race))throw Error('Unverified special result');
  rec.excluded={...result.excluded,verification:proof};rec.excluded_at=new Date().toISOString();
  if(rec.cancelled){rec.cancellation_review={source:'official',previous_cancelled_at:rec.cancelled_at,previous_reason:rec.cancellation_reason,reviewed_at:rec.excluded_at};delete rec.cancelled;}
  for(const group of groups)for(const m of Object.values(rec[group]||{})){m.excluded=true;m.settled=false;delete m.cancelled;}
  return rec;
}
