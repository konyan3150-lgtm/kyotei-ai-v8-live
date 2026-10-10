// DEV design "C 計器盤風": display-only helpers. Shows trifecta combinations as boat-color
// chips and adds a small meter under the decision score. Reads the page, never the data;
// no prediction, saving or money logic is touched.
(function(){
  const COMBO=/^([1-6])-([1-6])-([1-6])$/;
  function chips(el){
    const text=(el.textContent||'').trim(),m=text.match(COMBO);
    el.dataset.lanes='1';
    if(!m||el.children.length||new Set(m.slice(1)).size!==3)return;
    const wrap=document.createElement('span');wrap.className='lanecombo';wrap.setAttribute('role','img');wrap.setAttribute('aria-label',text);
    for(const n of m.slice(1)){const s=document.createElement('span');s.className='lanechip l'+n;s.setAttribute('aria-hidden','true');s.textContent=n;wrap.appendChild(s)}
    el.textContent='';el.appendChild(wrap);el.classList.add('has-lanes');
  }
  function meters(){
    for(const box of document.querySelectorAll('.recommend-score')){
      if(box.nextElementSibling?.classList.contains('dash-meter'))continue;
      const v=Number(box.querySelector('b')?.textContent);if(!Number.isFinite(v))continue;
      const bar=document.createElement('div');bar.className='dash-meter';bar.setAttribute('role','img');bar.setAttribute('aria-label',`判定指数 ${v} / 100`);
      const fill=document.createElement('i');fill.style.width=Math.max(0,Math.min(100,v))+'%';bar.appendChild(fill);box.after(bar);
    }
  }
  // Score breakdown cells (0-100): tint by strength so the strongest factors stand out.
  function heat(){
    for(const td of document.querySelectorAll('.breakdown td:not([data-heat])')){
      td.dataset.heat='1';const t=(td.textContent||'').trim();if(!/^\d{1,3}$/.test(t)||td.querySelector('.lanechip'))continue;
      const v=Math.max(0,Math.min(100,Number(t)));td.classList.add('heat');if(v>=100)td.classList.add('top');
      td.style.background=`rgba(127,167,201,${(v/100*0.32).toFixed(3)})`;
    }
  }
  const EMOJI=/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?\s*/gu;
  function noEmoji(){
    for(const el of document.querySelectorAll('.stat small,.ev-race-alert,.ev-stake-badge')){
      for(const n of el.childNodes)if(n.nodeType===3&&EMOJI.test(n.nodeValue)){EMOJI.lastIndex=0;n.nodeValue=n.nodeValue.replace(EMOJI,'')}
      EMOJI.lastIndex=0;
    }
  }
  let queued=false;
  function scan(){
    queued=false;
    for(const el of document.querySelectorAll('.bettable td:not([data-lanes]),.audit-picks span:not([data-lanes]),.history-detail td:not([data-lanes])'))chips(el);
    meters();heat();noEmoji();
  }
  function schedule(){if(!queued){queued=true;requestAnimationFrame(scan)}}
  new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true,characterData:true});
  schedule();
})();
