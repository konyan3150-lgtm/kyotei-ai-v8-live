(function(){
  const readMode=(r,view,mode)=>view==='value'?(Number(r.value_model_version)>=3?r.value_modes?.[mode]:null):(r.modes?.[mode]||((r.mode||'hit')===mode&&r.picks?r:null));
  const money=(records,view,mode)=>Object.values(records).reduce((s,r)=>{
    const m=readMode(r,view,mode);if(!m||r.cancelled||m.cancelled||m.skipped||!m.picks?.length||!(m.settled||r.settled)||!(Number(m.stake)>0))return s;
    s.races++;s.investment+=Number(m.stake);s.payout+=Number(m.payout||0);return s;
  },{races:0,investment:0,payout:0});
  const finite=v=>Number.isFinite(Number(v))?Number(v):null;
  function canonical(records){return JSON.stringify(Object.entries(records).sort(([a],[b])=>a.localeCompare(b)).map(([key,r])=>[key,r.date,r.saved_at||null,r.settled_at||null,!!r.cancelled,['base','value'].map(view=>['hit','balance','return'].map(mode=>{const m=readMode(r,view,mode);return m?[m.picks||[],finite(m.stake),finite(m.payout||0),!!(m.settled||r.settled),!!m.skipped,!!m.cancelled,m.result||r.result||null,(m.items||[]).map(x=>[x.combo,finite(x.stake)])]:null;}))]));}
  function code(text){let hash=14695981039346656037n;for(const c of text){hash^=BigInt(c.codePointAt(0));hash=BigInt.asUintN(64,hash*1099511628211n);}return hash.toString(16).padStart(16,'0');}
  window.v8RecordAudit=({server={},displayed={},updatedAt=null,historyStatus='idle',filter=()=>true}={})=>{
    const select=records=>Object.fromEntries(Object.entries(records).filter(([,r])=>r&&filter(r))),a=select(server),b=select(displayed),shared=Object.keys(a).filter(k=>b[k]);
    const differences=shared.filter(k=>canonical({[k]:a[k]})!==canonical({[k]:b[k]}));
    return {updated_at:updatedAt,history_status:historyStatus,server_records:Object.keys(a).length,displayed_records:Object.keys(b).length,local_only:Object.keys(b).filter(k=>!a[k]).length,missing_from_display:Object.keys(a).filter(k=>!b[k]).length,differences,
      server_code:code(canonical(a)),displayed_code:code(canonical(b)),money:Object.fromEntries(['base','value'].map(view=>[view,Object.fromEntries(['hit','balance','return'].map(mode=>[mode,{server:money(a,view,mode),displayed:money(b,view,mode)}]))]))};
  };
})();
