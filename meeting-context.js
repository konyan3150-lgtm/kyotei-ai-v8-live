(function(){
  const SOURCE='https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-dev/main/dev/meeting-context.json';
  let data=null,busy=false,error='';
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=(x,d=2)=>x==null||!Number.isFinite(Number(x))?'--':Number(x).toFixed(d);
  function host(){
    let el=document.getElementById('meetingContext');if(el)return el;
    const anchor=document.getElementById('v8summary')?.closest('.panel');if(!anchor)return null;
    const panel=document.createElement('section');panel.className='panel';
    panel.innerHTML='<div class="title">今節成績・勝負がけ（検証用）</div><div id="meetingContext"></div><div class="foot">予想への加点は未実施。必要得点は公式目安で、ボーダーは変動します。</div>';
    anchor.before(panel);return document.getElementById('meetingContext');
  }
  function render(){
    const el=host();if(!el)return;
    if(typeof D==='undefined'||!D||typeof sid==='undefined'||!sid){el.textContent='レースデータ待ち';return}
    const date=day(),key=`${date}_${Number(sid)}_${Number(rno)}`,r=D.programs?.stadiums?.[sid]?.races?.[rno];
    if(!data||data.date!==date){el.textContent=error?'今節データ取得待ち：'+error:'今節データ取得待ち';return}
    const close=raceCloseMs(r),ended=Number.isFinite(close)&&close<=Date.now();
    const saved=data.snapshots?.[key],record=ended?saved||data.latest?.[key]:data.latest?.[key]||saved;
    if(!record){el.textContent=ended?'締切前の今節記録なし（後から復元しません）':'会場ごとの次レースを順次取得中';return}
    const observed=Date.parse(record.observed_at),preClose=!!saved&&record===saved;
    const when=new Date(observed).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'});
    const status=ended?(preClose?'締切前保存':'参考：締切後取得・検証対象外'):'現在の取得データ';
    const stale=!ended&&Date.now()-observed>10*60000?'｜更新待ち':'';
    const rows=Object.entries(record.racers||{}).filter(([lane,x])=>{
      const racer=r?.racers?.[lane],id=racer?.number||racer?.registration_number;
      return id&&String(id)===String(x.registration_number);
    });
    if(!rows.length){el.textContent='出走選手との照合待ち（別選手のデータは表示しません）';return}
    el.innerHTML=`<div class="foot">${esc(record.race_stage||'競走区分未取得')}｜${esc(status)} ${esc(when)}${esc(stale)}</div><div class="foot">${esc(record.point_chart_as_of||'得点率早見の基準時点は未提供')}</div>`+
      '<div style="overflow-x:auto"><table class="bettable" style="min-width:330px"><thead><tr><th>艇</th><th>今節着順</th><th>平均ST</th><th>得点率</th><th>順位</th><th>必要得点</th></tr></thead><tbody>'+
      rows.map(([lane,x])=>`<tr><td>${esc(lane)}</td><td>${esc((x.series_results||[]).map(z=>z.finish).join(' / ')||'出走記録なし')}</td><td>${fmt(x.average_st)}</td><td>${fmt(x.point_rate)}</td><td>${x.rank==null?'--':esc(x.rank)}</td><td>${x.required_points==null?'--':esc(x.required_points)}</td></tr>`).join('')+'</tbody></table></div>'+
      (record.point_chart_provided?'<details style="margin-top:8px"><summary>各着順になった場合の得点率（公式目安）</summary><div class="foot">今回の1～6着の順。これだけでは予選通過を断定しません。</div>'+rows.map(([lane,x])=>`<div class="foot">${esc(lane)}号艇：${(x.projected_point_rates||[]).map(v=>fmt(v)).join(' / ')}</div>`).join('')+'</details>':'<div class="foot">得点率・必要得点：公式データ未提供（推測しません）</div>');
  }
  async function refresh(){
    if(busy)return;busy=true;
    try{const res=await fetch(`${SOURCE}?x=${Date.now()}`,{cache:'no-store'});if(!res.ok)throw Error('HTTP '+res.status);const payload=await res.json();if(payload.schema!=='kyotei-v8-meeting-context'||payload.version!==1)throw Error('形式不一致');data=payload;error=''}
    catch(e){error=e.message}finally{busy=false;render()}
  }
  if(typeof draw==='function'){const original=draw;draw=function(){const result=original.apply(this,arguments);render();return result}}
  window.refreshMeetingContext=refresh;
  setTimeout(refresh,1200);setInterval(refresh,180000);
})();
