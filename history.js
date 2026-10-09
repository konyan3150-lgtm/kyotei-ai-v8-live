(function(){
  const PREFIX='kyotei_v8_dev_result_';
  const MODE_LABELS={hit:'的中重視',balance:'バランス',return:'回収重視'};
  const yen=n=>(Number(n||0)<0?'-¥':'¥')+Math.abs(Number(n||0)).toLocaleString();
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
  const dateLabel=v=>String(v||'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1/$2/$3');
  const dateValue=v=>{const m=String(v||'').match(/^(\d{4})(\d{2})(\d{2})$/);return m?Date.UTC(+m[1],+m[2]-1,+m[3]):0};

  let serverRecords=[];
  function acceptServerRecords(data){
    serverRecords=Object.values(data?.records||{}).filter(x=>x&&x.source==='server');
    render();
  }
  function records(){
    const map=new Map();
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(!key?.startsWith(PREFIX))continue;
      try{const x=JSON.parse(localStorage.getItem(key)||'null');if(x?.date&&x?.stadium&&x?.race)map.set(`${x.date}_${x.stadium}_${x.race}`,x)}catch(e){}
    }
    const latest=window.__v8ServerPredictionData?Object.values(window.v8GetSavedPredictions?.()||window.__v8ServerPredictionData.records||{}):serverRecords;
    for(const x of latest){const k=`${x.date}_${x.stadium}_${x.race}`,prev=map.get(k);if(!prev||Date.parse(x.settled_at||x.saved_at||0)>=Date.parse(prev.settled_at||prev.saved_at||0))map.set(k,x)}
    return [...map.values()].sort((a,b)=>dateValue(b.date)-dateValue(a.date)||Number(b.race||0)-Number(a.race||0)||Number(b.stadium||0)-Number(a.stadium||0));
  }

  function modeRecord(rec,mode,view){
    if(view==='base'){
      if(rec?.modes?.[mode])return rec.modes[mode];
      if((rec?.mode||'hit')===mode&&rec?.picks)return {picks:rec.picks,stake:rec.stake,settled:rec.settled,hit:rec.hit,payout:rec.payout,result:rec.result};
      return null
    }
    if(Number(rec?.value_model_version)>=3&&rec?.value_modes?.[mode])return rec.value_modes[mode];
    return null;
  }

  function selectedModes(rec,mode,view){
    if(mode!=='all'){const m=modeRecord(rec,mode,view);return m?[{mode,data:m}]:[]}
    return Object.keys(MODE_LABELS).map(k=>({mode:k,data:modeRecord(rec,k,view)})).filter(x=>x.data);
  }

  function ensurePanel(){
    if(document.getElementById('historyPanel'))return;
    const stats=document.getElementById('baseStats')?.closest('.panel');if(!stats)return;
    const panel=document.createElement('div');panel.className='panel';panel.id='historyPanel';
    panel.innerHTML='<div class="title" id="historyTitle">期待値 レース履歴・絞り込み成績</div><div class="history-filters"><label>期間<select id="historyPeriod"><option value="1">当日</option><option value="7">7日間</option><option value="30" selected>30日間</option><option value="all">全期間</option></select></label><label>会場<select id="historyVenue"><option value="all">全会場</option></select></label><label>モード<select id="historyMode"><option value="hit">的中重視</option><option value="balance">バランス</option><option value="return">回収重視</option><option value="all">全モード合計</option></select></label><label id="historyScopeLabel" hidden>集計対象<select id="historyScope"><option value="all">全V8予想（参考含む）</option><option value="recommended">購入推奨のみ</option></select></label></div><div class="history-summary" id="historySummary"></div><div class="history-list" id="historyList"></div>';
    stats.insertAdjacentElement('afterend',panel);
    ['historyPeriod','historyVenue','historyMode','historyScope'].forEach(id=>document.getElementById(id).addEventListener('change',render));
  }

  function render(){
    ensurePanel();
    const panel=document.getElementById('historyPanel');if(!panel)return;
    if(window.__v8HistoryStatus&&window.__v8HistoryStatus!=='ready'){
      document.getElementById('historySummary').textContent=window.__v8HistoryStatus==='loading'?'全期間の履歴を読み込み中…':'過去履歴は、この欄を開いた時に取得します。';
      document.getElementById('historyList').innerHTML=window.__v8HistoryStatus==='loading'?'':'<button type="button" data-load-history>履歴を読み込む</button>';
      return;
    }
    const view=document.querySelector('.prediction-type-tabs button.active')?.dataset.view==='base'?'base':'value';
    const title=document.getElementById('historyTitle');if(title)title.textContent=(view==='base'?'V8':'期待値')+' レース履歴・絞り込み成績';
    const scopeLabel=document.getElementById('historyScopeLabel');if(scopeLabel)scopeLabel.hidden=view!=='base';
    const all=records(),venue=document.getElementById('historyVenue'),oldVenue=venue.value;
    const period=document.getElementById('historyPeriod').value;
    const todayKey=typeof jstDate==='function'?jstDate(0):new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tokyo'}).replaceAll('-','');
    const todayValue=dateValue(todayKey);
    // Prefer today's program, including venues with no saved predictions yet.
    // When it is unavailable (or tomorrow is displayed), use today's records only.
    const program=typeof D!=='undefined'&&String(D?.date)===todayKey?D?.programs?.stadiums:null;
    const venueRows=period==='1'&&program
      ?Object.entries(program).filter(([,v])=>Object.keys(v?.races||{}).length).map(([id])=>[String(Number(id)),(typeof N!=='undefined'&&N[id])||id])
      :all.filter(x=>period!=='1'||dateValue(x.date)===todayValue).map(x=>[String(Number(x.stadium)||''),x.stadium_name||((typeof N!=='undefined'&&N[x.stadium])||x.stadium)]);
    const venues=[...new Map(venueRows.filter(x=>x[0])).entries()].sort((a,b)=>Number(a[0])-Number(b[0]));
    venue.innerHTML='<option value="all">全会場</option>'+venues.map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');
    if([...venue.options].some(x=>x.value===oldVenue))venue.value=oldVenue;
    const mode=document.getElementById('historyMode').value,venueId=venue.value,scope=view==='base'?document.getElementById('historyScope').value:'all';
    const minDate=period==='all'?0:todayValue-(Number(period)-1)*86400000;
    const filtered=all.filter(x=>(venueId==='all'||String(Number(x.stadium))===venueId)&&dateValue(x.date)>=minDate&&(period!=='1'||dateValue(x.date)===todayValue));
    let races=0,hits=0,invest=0,payout=0;
    for(const rec of filtered)for(const item of selectedModes(rec,mode,view)){if(rec.cancelled||!item.data?.settled||item.data.skipped||!Number(item.data.stake))continue;if(scope==='recommended'&&rec?.base_recommendations?.[item.mode]?.level!=='buy')continue;races++;if(item.data.hit)hits++;invest+=Number(item.data.stake||0);payout+=Number(item.data.payout||0)}
    const roi=invest?payout/invest*100:0,hitRate=races?hits/races*100:0,profit=payout-invest;
    document.getElementById('historySummary').innerHTML=`<div><small>集計</small><b>${races}R</b></div><div><small>的中率</small><b>${races?hitRate.toFixed(1)+'%':'--'}</b></div><div><small>回収率</small><b class="roi">${invest?roi.toFixed(1)+'%':'--'}</b></div><div><small>投資</small><b>${yen(invest)}</b></div><div><small>払戻</small><b>${yen(payout)}</b></div><div><small>収支</small><b class="${profit>=0?'plus':'minus'}">${yen(profit)}</b></div>`;
    const list=document.getElementById('historyList');
    if(!filtered.length){list.innerHTML='<div class="history-empty">条件に合う保存済みレースはありません。</div>';return}
    list.innerHTML=filtered.slice(0,60).map(rec=>{
      const items=selectedModes(rec,mode,view).filter(item=>scope!=='recommended'||rec?.base_recommendations?.[item.mode]?.level==='buy');if(!items.length)return'';
      const venueName=rec.stadium_name||((typeof N!=='undefined'&&N[rec.stadium])||rec.stadium||'--');
      const settled=items.some(x=>x.data?.settled),cancelled=!!rec.cancelled,result=rec.result||items.find(x=>x.data?.result)?.data?.result||'';
      const rows=items.map(({mode:m,data})=>{const stake=cancelled?0:Number(data.stake||0),pay=Number(data.payout||0),profit=pay-stake,isReference=view==='base'&&rec?.base_recommendations?.[m]?.level!=='buy';const state=cancelled?'中止':data.skipped?'見送り':!data.settled?'判定待ち':isReference?(data.hit?'参考的中':'参考不的中'):data.hit?'的中':'不的中',stateClass=cancelled||data.skipped||!data.settled?'wait':isReference?'ref':data.hit?'hit':'miss';return `<div class="history-mode-row"><span>${MODE_LABELS[m]}</span><b class="${stateClass}">${state}</b><em>投資 ${yen(stake)}</em><em>払戻 ${yen(pay)}</em><strong class="${profit>=0?'plus':'minus'}">${yen(profit)}</strong></div>`}).join('');
      const visiblePayout=items.reduce((sum,x)=>sum+Number(x.data?.settled&&!x.data?.skipped?x.data?.payout||0:0),0);
      const allReference=view==='base'&&items.every(x=>rec?.base_recommendations?.[x.mode]?.level!=='buy'),stateClass=cancelled?'wait':allReference?'ref':items.some(x=>x.data?.hit)?'hit':settled?'miss':'wait',stateText=cancelled?'中止':allReference?(items.some(x=>x.data?.hit)?'参考的中':settled?'参考不的中':'待機'):items.some(x=>x.data?.hit)?'的中':settled?'不的中':'待機';
      return `<details class="history-item"><summary><span><b>${esc(dateLabel(rec.date))}　${esc(venueName)} ${esc(rec.race)}R</b><small>${cancelled?'開催中止':settled?'結果 '+esc(result||'--'):'結果 未確定'}</small></span><span class="history-result-wrap"><span class="history-result ${stateClass}">${stateText}</span><small>払戻 ${cancelled?yen(0):settled?yen(visiblePayout):'--'}</small></span></summary><div class="history-detail">${rows}</div></details>`
    }).join('')||'<div class="history-empty">このモードの記録はありません。</div>';
  }

  ensurePanel();
  const baseRenderStats=typeof renderStats==='function'?renderStats:null;
  if(baseRenderStats)renderStats=function(){baseRenderStats();render()};
  window.renderPredictionHistory=render;
  render();
  // Server sync supplies recent data immediately; archives are requested on demand.
})();

