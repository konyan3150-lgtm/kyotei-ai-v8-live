(function(){
  const yen=n=>'¥'+Math.round(Number(n)||0).toLocaleString('ja-JP');
  function fromSavedRecords(){
    const blank=label=>({label,saved:0,settled:0,value_modes:{hit:{races:0,invest:0,payout:0}}});
    const groups={live:blank('締切前保存'),reconstructed:{full:blank('過去復元・情報充足'),partial:blank('過去復元・一部欠損'),basic:blank('過去復元・基礎のみ')}};
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(!key?.startsWith('kyotei_v8_dev_result_'))continue;
      let rec;try{rec=JSON.parse(localStorage.getItem(key)||'null')}catch{continue}
      if(rec?.source!=='server'||!rec.expert_snapshot?.active)continue;
      const snap=rec.expert_snapshot,quality=['full','partial','basic'].includes(snap.reconstruction_quality)?snap.reconstruction_quality:'basic';
      const g=snap.reconstructed?groups.reconstructed[quality]:groups.live;g.saved++;
      if(!rec.expert_result)continue;g.settled++;
      const m=rec.expert_result.value_modes?.hit;if(!m||!Number(m.stake))continue;
      const row=g.value_modes.hit;row.races++;row.invest+=Number(m.stake||0);row.payout+=Number(m.payout||0);
    }
    return groups;
  }
  function render(data){
    const el=document.getElementById('expertHistory');if(!el)return;
    const s=data?.expert_summary,groups=s?.cohorts||fromSavedRecords();
    if(!groups){el.textContent='集計データ待ち';return}
    const rows=[groups.live,groups.reconstructed.full,groups.reconstructed.partial,groups.reconstructed.basic];
    el.innerHTML=rows.map(g=>{
      const m=g?.value_modes?.hit||{},roi=m.invest?`${(m.payout/m.invest*100).toFixed(1)}%`:'--';
      return `<div class="expert-history-row"><b>${g.label}</b><span>保存 ${g.saved}R / 確定 ${g.settled}R</span><span>期待値・的中重視 ${m.races||0}R / 回収率 ${roi}</span><small>投資 ${yen(m.invest)} / 払戻 ${yen(m.payout)}</small></div>`;
    }).join('');
  }
  window.addEventListener('v8-server-predictions',e=>render(e.detail));
  if(window.__v8ServerPredictionData)render(window.__v8ServerPredictionData);
})();
