// DEV: split the long page into tabs (ホーム / 予想 / 買い目 / 結果 / 設定) using the existing bottom bar.
// Display only: every panel stays in the page and keeps loading and saving as before; panels for
// other tabs are just hidden. The value/V8 mode switch keeps using its own `hidden` attribute.
(function(){
  const bar=document.querySelector('.bottomnav');
  if(!bar)return;
  const PAGES=['home','prediction','bets','results','settings'];
  const has=(el,sel)=>!!el.querySelector(sel);
  function pageFor(el){
    if(el.id==='homeSection')return 'home';
    if(el.id==='betSection')return 'home bets results'; // 期待値/V8 switch also on 買い目 and 結果
    if(el.classList.contains('pickerpanel'))return 'home prediction bets';
    if(el.id==='historyPanel')return 'results';
    if(el.id==='settingsSection'||has(el,'#serverDiag,#exportDataBtn'))return 'settings';
    if(has(el,'#valueSavedAudit,#baseSavedAudit,#valueStats,#baseStats,#modeStats,#baseModeStats'))return 'bets';
    if(el.id==='betSection'||has(el,'#bets,#baseBets,.value-modes,.base-modes,.prediction-type-tabs'))return 'home';
    return 'prediction';
  }
  function assign(){
    for(const el of document.querySelectorAll('.wrap #homeSection,.wrap .pickerpanel,.wrap .panel')){
      if(el.dataset.page)continue;
      if(el.parentElement?.closest('.panel'))continue; // nested panels follow their parent
      el.dataset.page=pageFor(el);
    }
  }
  function show(page,{scroll=true}={}){
    if(!PAGES.includes(page))page='home';
    assign();
    document.body.dataset.page=page;
    bar.querySelectorAll('button[data-nav-target]').forEach(b=>{
      const on=b.dataset.navTarget===page;
      b.classList.toggle('active',on);b.setAttribute('aria-current',on?'page':'false');
    });
    try{history.replaceState(null,'',page==='home'?location.pathname+location.search:'#'+page)}catch(e){}
    if(page==='results'||page==='bets')window.v8LoadFullHistory?.();
    if(scroll)window.scrollTo({top:0,behavior:'instant'});
  }
  // Runs before the existing bar handler and replaces its scroll-to-section behavior for page tabs.
  bar.addEventListener('click',event=>{
    const b=event.target.closest('button[data-nav-target]');
    if(!b||!PAGES.includes(b.dataset.navTarget))return;
    event.stopPropagation();event.preventDefault();
    show(b.dataset.navTarget);
  },true);
  let queued=false;
  new MutationObserver(()=>{if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;assign()})}}).observe(document.querySelector('.wrap')||document.body,{childList:true,subtree:true});
  const initial=(location.hash||'').slice(1);
  show(PAGES.includes(initial)?initial:'home',{scroll:false});
})();
