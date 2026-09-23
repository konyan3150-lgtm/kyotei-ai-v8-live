(function(){
  const bar=document.querySelector('.bottomnav');
  if(!bar)return;

  function targetFor(name){
    if(name==='home')return document.getElementById('homeSection');
    if(name==='prediction')return document.getElementById('predictionSection');
    if(name==='bets')return document.getElementById('betSection');
    if(name==='results')return document.getElementById('historyPanel')||document.getElementById('modeStats')?.closest('.panel');
    if(name==='settings')return document.getElementById('settingsSection');
    return null;
  }

  function select(button){
    bar.querySelectorAll('button').forEach(x=>{
      const active=x===button;
      x.classList.toggle('active',active);
      x.setAttribute('aria-current',active?'page':'false');
    });
  }

  let refreshPromise=null,lastResumeRefresh=0;
  function refreshAll(){
    if(refreshPromise)return refreshPromise;
    refreshPromise=(async()=>{if(typeof load==='function')await load();if(typeof window.syncServerPredictions==='function')await window.syncServerPredictions()})().finally(()=>refreshPromise=null);
    return refreshPromise
  }
  function refreshOnResume(){
    if(document.visibilityState!=='visible'||Date.now()-lastResumeRefresh<30000)return;
    lastResumeRefresh=Date.now();refreshAll()
  }

  bar.addEventListener('click',async event=>{
    const button=event.target.closest('button[data-nav-target]');
    if(!button)return;
    if(button.dataset.navTarget==='refresh'){
      if(button.disabled)return;
      button.disabled=true;
      button.classList.add('refreshing');
      button.setAttribute('aria-label','更新中');
      try{await refreshAll()}finally{
        button.disabled=false;
        button.classList.remove('refreshing');
        button.setAttribute('aria-label','最新データに更新');
      }
      return;
    }
    const target=targetFor(button.dataset.navTarget);
    if(!target)return;
    select(button);
    target.scrollIntoView({behavior:'smooth',block:'start'});
  });
  document.addEventListener('visibilitychange',refreshOnResume);
  window.addEventListener('pageshow',refreshOnResume);
  window.addEventListener('focus',refreshOnResume);
})();
