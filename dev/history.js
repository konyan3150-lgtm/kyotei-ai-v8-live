(function(){
  const PREFIX='kyotei_v8_dev_result_';
  const MODE_LABELS={hit:'的中重視',balance:'バランス',return:'回収重視'};
  const yen=n=>(Number(n||0)<0?'-¥':'¥')+Math.abs(Number(n||0)).toLocaleString();
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
  const dateLabel=v=>String(v||'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1/$2/$3');
  const dateValue=v=>{const m=String(v||'').match(/^(\d{4})(\d{2})(\d{2})$/);return m?Date.UTC(+m[1],+m[2]-1,+m[3]):0};

  function records(){
    const out=[];
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(!key?.startsWith(PREFIX))continue;
      try{const x=JSON.parse(localStorage.getItem(key)||'null');if(x)out.push(x)}catch(e){}
    }
    return out.sort((a,b)=>dateValue(b.date)-dateValue(a.date)||Number(b.race||0)-Number(a.race||0)||Number(b.stadium||0)-Number(a.stadium||0));
  }

  function modeRecord(rec,mode){
    if(rec?.value_modes?.[mode])return rec.value_modes[mode];
    if(rec?.modes?.[mode])return rec.modes[mode];
    if((rec?.mode||'hit')===mode)return {picks:rec.picks,stake:rec.stake,settled:rec.settled,hit:rec.hit,payout:rec.payout,result:rec.result};
    return null;
  }

  function selectedModes(rec,mode){
    if(mode!=='all'){const m=modeRecord(rec,mode);return m?[{mode,data:m}]:[]}
    return Object.keys(MODE_LABELS).map(k=>({mode:k,data:modeRecord(rec,k)})).filter(x=>x.data);
  }

  function ensurePanel(){
    if(document.getElementById('historyPanel'))return;
    const stats=document.getElementById('modeStats')?.closest('.panel');if(!stats)return;
    const panel=document.createElement('div');panel.className='panel';panel.id='historyPanel';
    panel.innerHTML='<div class="title">レース履歴・絞り込み成績</div><div class="history-filters"><label>期間<select id="historyPeriod"><option value="7">7日間</option><option value="30" selected>30日間</option><option value="all">全期間</option></select></label><label>会場<select id="historyVenue"><option value="all">全会場</option></select></label><label>モード<select id="historyMode"><option value="hit">的中重視</option><option value="balance">バランス</option><option value="return">回収重視</option><option value="all">全モード合計</option></select></label></div><div class="history-summary" id="historySummary"></div><div class="history-list" id="historyList"></div>';
    stats.insertAdjacentElement('afterend',panel);
    ['historyPeriod','historyVenue','historyMode'].forEach(id=>document.getElementById(id).addEventListener('change',render));
  }

  function render(){
    ensurePanel();
    const panel=document.getElementById('historyPanel');if(!panel)return;
    const all=records(),venue=document.getElementById('historyVenue'),oldVenue=venue.value;
    const venues=[...new Map(all.map(x=>[String(x.stadium||''),x.stadium_name||((typeof N!=='undefined'&&N[x.stadium])||x.stadium)]).filter(x=>x[0])).entries()].sort((a,b)=>Number(a[0])-Number(b[0]));
    venue.innerHTML='<option value="all">全会場</option>'+venues.map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');
    if([...venue.options].some(x=>x.value===oldVenue))venue.value=oldVenue;
    const period=document.getElementById('historyPeriod').value,mode=document.getElementById('historyMode').value,venueId=venue.value;
    const todayValue=dateValue(typeof day==='function'?day():new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tokyo'}).replaceAll('-',''));
    const minDate=period==='all'?0:todayValue-(Number(period)-1)*86400000;
    const filtered=all.filter(x=>(venueId==='all'||String(x.stadium)===venueId)&&dateValue(x.date)>=minDate);
    let races=0,hits=0,invest=0,payout=0;
    for(const rec of filtered)for(const item of selectedModes(rec,mode)){if(!item.data?.settled||item.data.skipped||!Number(item.data.stake))continue;races++;if(item.data.hit)hits++;invest+=Number(item.data.stake||0);payout+=Number(item.data.payout||0)}
    const roi=invest?payout/invest*100:0,hitRate=races?hits/races*100:0,profit=payout-invest;
    document.getElementById('historySummary').innerHTML=`<div><small>集計</small><b>${races}R</b></div><div><small>的中率</small><b>${races?hitRate.toFixed(1)+'%':'--'}</b></div><div><small>回収率</small><b class="roi">${invest?roi.toFixed(1)+'%':'--'}</b></div><div><small>投資</small><b>${yen(invest)}</b></div><div><small>払戻</small><b>${yen(payout)}</b></div><div><small>収支</small><b class="${profit>=0?'plus':'minus'}">${yen(profit)}</b></div>`;
    const list=document.getElementById('historyList');
    if(!filtered.length){list.innerHTML='<div class="history-empty">条件に合う保存済みレースはありません。</div>';return}
    list.innerHTML=filtered.slice(0,60).map(rec=>{
      const items=selectedModes(rec,mode);if(!items.length)return'';
      const venueName=rec.stadium_name||((typeof N!=='undefined'&&N[rec.stadium])||rec.stadium||'--');
      const settled=items.some(x=>x.data?.settled),result=rec.result||items.find(x=>x.data?.result)?.data?.result||'';
      const rows=items.map(({mode:m,data})=>{const stake=Number(data.stake||0),pay=Number(data.payout||0),profit=pay-stake;const state=data.skipped?'見送り':!data.settled?'判定待ち':data.hit?'的中':'不的中';return `<div class="history-mode-row"><span>${MODE_LABELS[m]}</span><b class="${data.skipped||!data.settled?'wait':data.hit?'hit':'miss'}">${state}</b><em>投資 ${yen(stake)}</em><em>払戻 ${yen(pay)}</em><strong class="${profit>=0?'plus':'minus'}">${yen(profit)}</strong></div>`}).join('');
      return `<details class="history-item"><summary><span><b>${esc(dateLabel(rec.date))}　${esc(venueName)} ${esc(rec.race)}R</b><small>${settled?'結果 '+esc(result||'--'):'結果 未確定'}</small></span><span class="history-result ${items.some(x=>x.data?.hit)?'hit':settled?'miss':'wait'}">${items.some(x=>x.data?.hit)?'的中':settled?'不的中':'待機'}</span></summary><div class="history-detail">${rows}</div></details>`
    }).join('')||'<div class="history-empty">このモードの記録はありません。</div>';
  }

  ensurePanel();
  const baseRenderStats=typeof renderStats==='function'?renderStats:null;
  if(baseRenderStats)renderStats=function(){baseRenderStats();render()};
  render();
})();
