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

  bar.addEventListener('click',event=>{
    const button=event.target.closest('button[data-nav-target]');
    if(!button)return;
    const target=targetFor(button.dataset.navTarget);
    if(!target)return;
    select(button);
    target.scrollIntoView({behavior:'smooth',block:'start'});
  });
})();
