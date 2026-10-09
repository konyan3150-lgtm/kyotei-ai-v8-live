// Descriptive diagnostics of saved decisions. Never changes a prediction or purchase rule.
const numeric=v=>v==null||v===''||!Number.isFinite(Number(v))?null:Number(v);
const deadline=r=>{const s=String(r.closed_at||'');return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)?s.replace(' ','T')+'+09:00':s);};
const beforeClose=(r,at=r.saved_at)=>Number.isFinite(Date.parse(at))&&Number.isFinite(deadline(r))&&Date.parse(at)<deadline(r);
const band=(v,edges,labels)=>{const n=numeric(v);if(n===null)return 'unknown';return labels[edges.findIndex(e=>n<e)];};
const bounded=(v,max=Infinity)=>{const n=numeric(v);return n!==null&&n>=0&&n<=max?n:null;};
function stBand(exhibition){
  const values=Array.from({length:6},(_,i)=>numeric(exhibition?.[String(i+1)]?.start_timing));
  if(values.some(v=>v!==null&&v<0))return 'negative';
  if(values.some(v=>v!==null&&v>2))return 'out_of_range';
  return values.some(v=>v===null)?'incomplete':'six_values';
}
export const SELECTION_AXES={decision:'保存時の推奨判定',venue:'会場',top:'1着最上位スコア',gap:'1着スコアの差',coverage:'情報充足度',wind:'保存時の風速',st:'保存時の展示ST',timing:'保存・判定時刻の確認'};
export const GROUP_LABELS={buy:'購入推奨',caution:'注意',skip:'見送り',none:'判定なし',unknown:'未記録・未確認',confidence_yes:'厚張りの自信度条件あり',confidence_no:'厚張りの自信度条件なし',top_low:'48%未満',top_mid:'48〜62%未満',top_high:'62〜80%未満',top_very_high:'80%以上',gap_low:'14%未満',gap_mid:'14〜25%未満',gap_high:'25%以上',coverage_low:'70%未満',coverage_mid:'70〜82%未満',coverage_high:'82%以上',wind_low:'3m/s未満',wind_mid:'3〜6m/s未満',wind_high:'6m/s以上',negative:'負のSTを含む',out_of_range:'ST範囲外',incomplete:'STの欠け・読取不能',six_values:'6艇のSTあり',preclose:'締切前を確認',unverified:'時刻情報が不足',invalid:'保存・判定が締切後または不正'};
function features(r,decision={},timing='preclose'){
  const usable=timing==='preclose';return {decision:timing==='invalid'?'unknown':decision.level||'unknown',venue:String(r.stadium||'unknown'),
    top:band(usable?bounded(decision.top,1):null,[.48,.62,.8,Infinity],['top_low','top_mid','top_high','top_very_high']),
    gap:band(usable?bounded(decision.gap,1):null,[.14,.25,Infinity],['gap_low','gap_mid','gap_high']),
    coverage:band(usable?bounded(decision.coverage,100):null,[70,82,Infinity],['coverage_low','coverage_mid','coverage_high']),
    wind:band(usable?bounded(r.input_state?.water?.wind_speed):null,[3,6,Infinity],['wind_low','wind_mid','wind_high']),
    st:usable&&r.input_state?.exhibition?stBand(r.input_state.exhibition):'unknown',timing};
}
function summarize(events){
  const investment=events.reduce((s,e)=>s+e.investment,0),payout=events.reduce((s,e)=>s+e.payout,0),hits=events.filter(e=>e.hit).length;
  return {races:events.length,dates:new Set(events.map(e=>e.date)).size,hits,investment,payout,profit:payout-investment,hit_rate:events.length?hits/events.length:null,roi:investment?payout/investment:null,max_payout_share:payout?events.reduce((n,e)=>Math.max(n,e.payout),0)/payout:null,interpretation:'descriptive_only'};
}
function aggregate(events,skipped,kind){
  const axes=Object.fromEntries(Object.keys(SELECTION_AXES).map(axis=>{const keys=[...new Set(events.map(e=>e.features[axis]||'unknown'))].sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));return [axis,keys.map(key=>({key,...summarize(events.filter(e=>(e.features[axis]||'unknown')===key))}))];}));
  return {kind,summary:summarize(events),axes,excluded:skipped,limitation:'Fixed descriptive bins overlap across axes. Unknown saved inputs are not reconstructed. No filter fitting, rule changes, or production promotion; future chronological validation is required.'};
}
export function analyzeSavedSelections(records,{view='base',mode='hit'}={}){
  const events=[],skipped={no_mode:0,pending:0,cancelled:0,skipped:0,invalid_money:0};
  for(const r of Object.values(records||{})){
    const m=view==='value'?(Number(r.value_model_version)>=3?r.value_modes?.[mode]:null):(r.modes?.[mode]||((r.mode||'hit')===mode&&r.picks?r:null));
    if(!m){skipped.no_mode++;continue;}if(r.cancelled||m.cancelled){skipped.cancelled++;continue;}
    if(m.skipped||!m.picks?.length||Number(m.stake)===0){skipped.skipped++;continue;}if(!(m.settled||r.settled)){skipped.pending++;continue;}
    const investment=numeric(m.stake),payout=numeric(m.payout);if(investment===null||investment<=0||payout===null||payout<0){skipped.invalid_money++;continue;}
    const decision=(view==='value'?r.recommendations:r.base_recommendations)?.[mode]||{},close=deadline(r);
    const timing=!Number.isFinite(close)||!r.saved_at?'unverified':!beforeClose(r)||decision.created_at&&!beforeClose(r,decision.created_at)?'invalid':'preclose';
    events.push({date:r.date,investment,payout,hit:m.hit===true,features:features(r,decision,timing)});
  }
  return aggregate(events,skipped,'actual_saved_decisions');
}
export function analyzeShadowSelections(records){
  const events=[],skipped={invalid_capture:0,pending:0,excluded:0,invalid_money:0};
  for(const r of Object.values(records||{})){
    if(!beforeClose(r)){skipped.invalid_capture++;continue;}if(r.cancelled||r.excluded){skipped.excluded++;continue;}
    const m=r.outcome?.metrics?.baseline;if(!m){skipped.pending++;continue;}
    const investment=numeric(m.investment),payout=numeric(m.payout);if(investment===null||investment<=0||payout===null||payout<0){skipped.invalid_money++;continue;}
    const b=r.variants?.budget,decision={top:b?.top_score,gap:b?.score_gap,level:typeof b?.confident==='boolean'?(b.confident?'confidence_yes':'confidence_no'):'unknown'};
    events.push({date:r.date,investment,payout,hit:m.hit===true,features:features(r,decision)});
  }
  return aggregate(events,skipped,'shadow_baseline_confidence_conditions');
}
