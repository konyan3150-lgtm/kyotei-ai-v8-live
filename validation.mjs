import {GROUP_LABELS} from './selection-analysis.mjs';
export const SOURCES={repaired:'https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-dev/main/dev/expert-shadow-repaired-evaluation.json',legacy:'https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-dev/main/dev/expert-shadow-evaluation.json'};
export const SOURCE=SOURCES.repaired;
const names={normal:'通常',inside:'イン逃げ',upset:'イン崩れ・穴',exhibition:'展示変化',water:'水面'};
const venues=['','桐生','戸田','江戸川','平和島','多摩川','浜名湖','蒲郡','常滑','津','三国','びわこ','住之江','尼崎','鳴門','丸亀','児島','宮島','徳山','下関','若松','芦屋','福岡','唐津','大村'];
export const percentage=v=>Number.isFinite(v)?(v*100).toFixed(1)+'%':'—';
export const money=v=>Number.isFinite(v)?'¥'+v.toLocaleString('ja-JP'):'—';
export function hitRate(arm,value=false){const n=value?arm?.bought_races:arm?.races;return n>0?arm.hits/n:null}
export function status(d,now=Date.now()){
  const checked=Date.parse(d.health?.checked_at),age=(now-checked)/60000;
  if(!Number.isFinite(checked)||age< -1)return {text:'収集時刻を確認してください',kind:'warn'};
  if((d.invalid||0)>0||d.health?.status==='needs_attention')return {text:'確認が必要',kind:'warn'};
  if(Number.isFinite(age)&&age>20)return {text:'更新が遅れています',kind:'warn'};
  return {text:'収集中・比較は検証段階',kind:'good'};
}
export function validate(d){if(!d||typeof d!=='object'||!d.arms?.baseline||!d.arms?.candidate||!Number.isInteger(d.saved)||d.saved<0)throw Error('集計データの形式を確認できません');return d}
function element(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n}
function row(body,values){const tr=element('tr');for(const v of values)tr.append(element('td',v));body.append(tr)}
let data=null,valueMode=false,busy=false;
function render(){
  const d=data,s=status(d),connection=document.getElementById('connection');connection.textContent=s.text;connection.className='pill '+s.kind;
  document.getElementById('cohortNote').textContent=document.getElementById('cohort').value==='legacy'?'修復前の入力で保存した参考記録です。改善の判断には使いません。':`修復済み公式履歴：${d.input_provenance?.history_through||'確認中'}まで。以前の検証とは別集計。`;
  const time=d.health?.checked_at;document.getElementById('updated').textContent=time?'収集確認：'+new Date(time).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'収集時刻は未確認';
  const counts=document.getElementById('counts');counts.replaceChildren();for(const [label,n] of [['保存',d.saved],['確定',d.settled],['結果待ち',d.pending],['中止',d.cancelled||0],['記録エラー',d.invalid||0],['変更履歴',d.realtime?.preserved_previous_snapshots||0]]){const c=element('div',null,'count');c.append(element('span',label),element('strong',String(n??0)));counts.append(c)}
  document.getElementById('six').setAttribute('aria-pressed',String(!valueMode));document.getElementById('ev').setAttribute('aria-pressed',String(valueMode));
  const arms=valueMode?d.value_arms:d.arms,a=arms?.baseline||{},b=arms?.candidate||{},body=document.getElementById('comparison');body.replaceChildren();
  row(body,['購入対象',String((valueMode?a.bought_races:a.races)??0)+'R',String((valueMode?b.bought_races:b.races)??0)+'R']);
  row(body,['的中率',percentage(hitRate(a,valueMode)),percentage(hitRate(b,valueMode))]);row(body,['回収率',percentage(a.roi),percentage(b.roi)]);
  row(body,['仮想投資',money(a.investment),money(b.investment)]);row(body,['仮想払戻',money(a.payout),money(b.payout)]);
  if(!valueMode)row(body,['確率誤差',Number.isFinite(a.brier)?a.brier.toFixed(4):'—',Number.isFinite(b.brier)?b.brier.toFixed(4):'—']);
  document.getElementById('sample').textContent=(d.settled||0)+'R確定';document.getElementById('comparisonNote').textContent=valueMode?'仮想購入・最大4点×100円。確率は未校正の推定値。古い・欠けたオッズは除外。':'仮想購入・両方式6点×100円。本番実績とは別集計。確率誤差は小さい方が良い値です。';
  const health=document.getElementById('health');health.replaceChildren();
  const info=(title,detail)=>{const li=element('li');li.append(element('strong',title),element('span',detail));health.append(li)};
  info('締切前の保存',`${d.health?.captured_preclose_races??0} / ${d.health?.eligible_preclose_races??0}R（現在の収集対象）`);
  const missing=d.health?.missing_preclose_records?.length||0,stale=d.health?.stale_preclose_records?.length||0;info('更新漏れ・遅れ',missing||stale?`保存漏れ ${missing}R・更新遅れ ${stale}R`:'今回の確認で検出なし');
  info('結果反映',d.health?.overdue_results?.length?`締切から30分以上の結果待ち ${d.health.overdue_results.length}R`:'30分以上の反映待ちは検出なし');
  const orig=d.health?.original_exhibition_status;info('周回・回り足・直線展示',orig==='captured_preclose'?'締切前の追加展示を取得':orig==='no_preclose_values'?'今回の対象に追加値なし':orig==='fetch_or_parse_error'?'取得または読み取りに失敗':orig?.startsWith('HTTP_')?'取得元からデータを受信できません':'未確認');
  const ready=document.getElementById('readiness');ready.replaceChildren();
  const item=(title,detail)=>{const n=element('div');n.append(element('strong',title),element('span',detail));ready.append(n)};
  const cal=d.calibration;if(cal)item('期待値用の確率校正',cal.status==='shadow_evaluation_only'?'後の期間で校正の効果を比較中。本番には未反映。':`準備中：学習 ${cal.train_dates?.length||0}/20日・${cal.train_races||0}/500R、評価 ${cal.test_dates?.length||0}/5日・${cal.test_races||0}/150R`);
  const oc=d.odds_calibration;if(oc){
    item('オッズを使う確率補正',oc.model_fitted_at?`補正を固定済み。固定後の検証 ${oc.test_dates?.length||0}/5日・${oc.test_races||0}/150R。${oc.ready_for_review?'比較を確認できる段階。':'まだ改善の判断は保留。'}`:`準備中：過去 ${oc.train_dates?.length||0}/20日・締切前オッズあり ${oc.train_races||0}/500R。終了済みレースに補正買い目を追加しません。`);
    if(oc.arms)item('固定後の期待値方式の仮想比較',`補正前 ${oc.arms.raw.bought_races}R・回収率 ${percentage(oc.arms.raw.roi)}／補正後 ${oc.arms.calibrated.bought_races}R・回収率 ${percentage(oc.arms.calibrated.roi)}。本番には未反映。`);
    const re=oc.robust_ev;if(re){
      item('確率・オッズ下落を見込む購入条件',`補正後の既存判定に、確率10%減・オッズ10%減を追加した固定条件を比較。誤差の保証ではなく仮定の検証です。1R最大400円。${re.status==='waiting_for_calibration'?'補正モデル確定待ち。':`同じ対象 ${re.test_races}R・${re.test_dates.length}/5日（150R必要）。${re.ready_for_review?'比較確認可能。':'判断保留。'}`}`);
      if(re.test_races)for(const [key,label] of [['reference','補正後の既存条件'],['conservative','下落を見込む条件']]){const a=re.arms[key];item(label,`購入 ${a.bought_races}R・見送り ${a.skipped_races}R／的中率 ${percentage(a.hit_rate)}・回収率 ${percentage(a.roi)}／仮想収支 ${money(a.profit)}・投資 ${money(a.investment)}・払戻 ${money(a.payout)}／最大下落 ${money(a.risk.max_drawdown)}・最大連続不的中 ${a.risk.max_consecutive_misses}R`);}
    }
  }
  const p=d.diagnostics?.paired_intervals,dr=d.drift;item('改善の判断',p?.status==='descriptive_interval'?'差のばらつきを集計中。将来期間での確認が必要。':`データ不足：確定 ${p?.races??0}/100R・${p?.dates??0}/5日`);
  item('傾向変化の検知',dr?.status==='distribution_change_detected'?'データの分布変化を検知。内容確認が必要。':dr?.status==='stable'?'今回の基準では大きな変化なし':`基準 ${dr?.reference_races??0}/200R・比較 ${dr?.recent_races??0}/50R`);
  renderVariants();renderGroups();renderDaily();renderShadowSelection();renderOdds();
}
function renderOdds(){
 const panel=document.getElementById('oddsPanel');panel.hidden=document.getElementById('cohort').value==='legacy';
 const d=data?.odds_diagnostics,body=document.getElementById('oddsRows'),scope=document.getElementById('oddsScope').value,axis=document.getElementById('oddsAxis').value;body.replaceChildren();
 const s=d?.scopes?.[scope],c=d?.counts;
 document.getElementById('oddsNote').textContent=d?`締切前の全120点オッズがそろう ${c.eligible_races}R。時刻不良・古いオッズ ${c.odds_missing_stale_or_postclose}R／オッズ欠け ${c.odds_incomplete}Rを除外。選択中：${s?.summary.races||0}R・${s?.summary.tickets||0}点・${s?.summary.dates||0}日。`:'オッズ診断は次の収集更新後に表示します。';
 for(const g of s?.[axis]||[]){
  const label=axis==='by_odds'?`${g.lower}倍〜${g.upper==null?'上限なし':g.upper+'倍未満'}`:`${percentage(g.lower)}〜${percentage(g.upper)}${g.upper===1?'以下':'未満'}`;
  row(body,[label,`${g.tickets}点 / ${g.races}R / ${g.dates}日`,percentage(g.predicted_probability),percentage(g.observed_ticket_hit_rate),percentage(g.estimated_roi),percentage(g.roi),money(g.profit)]);
 }
 if(!body.children.length){const tr=element('tr'),td=element('td','対象の確定記録はまだありません','empty');td.colSpan=7;tr.append(td);body.append(tr);}
}
function renderShadowSelection(){
 const d=data?.selection_diagnostics,body=document.getElementById('shadowSelectionRows'),axis=document.getElementById('shadowSelectionGroup').value;body.replaceChildren();
 document.getElementById('shadowSelectionNote').textContent=d?`仮想通常V8 ${d.summary.races}R・${d.summary.dates}日を集計。件数・観測日数・払戻の偏りを確認してください。`:'条件別診断は次の収集更新後に表示します。';
 for(const g of d?.axes?.[axis]||[])row(body,[axis==='venue'?(venues[Number(g.key)]||g.key):(GROUP_LABELS[g.key]||g.key),`${g.races}R / ${g.dates}日`,percentage(g.hit_rate),percentage(g.roi),money(g.profit),percentage(g.max_payout_share)]);
 if(!body.children.length){const tr=element('tr'),td=element('td','条件別の確定記録はまだありません','empty');td.colSpan=6;tr.append(td);body.append(tr);}
}
function renderDaily(){
 const body=document.getElementById('dailyCollection');body.replaceChildren();const report=data?.collection_daily;
 document.getElementById('dailyNote').textContent=report?'収集ジョブが確認した日別集計。未記録は番組との照合、結果待ちは保存済み記録の集計です。':'日別診断は次の収集更新後に表示します。以前の集計だけでは保存漏れを判定できません。';
 for(const [date,g] of Object.entries(report?.days||{}).sort(([a],[b])=>b.localeCompare(a)))row(body,[date.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1/$2/$3'),`${g.preclose_saved}/${g.saved}R`,`${g.settled}R`,`${g.pending}R`,`${g.overdue}R`,g.unrecorded_closed_races==null?'未確認':`${g.unrecorded_closed_races}R`]);
 const labels={not_observed_unknown:'観測履歴なし・原因未確認',invalid_model_rows:'予測入力の艇数不足',snapshot_rejected:'保存条件外',revision_rejected:'更新の識別不一致',observed_without_capture:'観測あり・保存未確認'},gaps=data?.collection_gaps;
 document.getElementById('gapNote').textContent=gaps?'未記録の内訳：'+(Object.entries(gaps.reasons||{}).filter(([,n])=>n>0).map(([k,n])=>`${labels[k]||k} ${n}R`).join('／')||'今回の照合で未記録なし'):'未記録の原因は、診断開始後の観測履歴で照合します。';
}
function renderVariants(){
 const v=data?.variants,legacy=document.getElementById('cohort').value==='legacy',body=document.getElementById('variantsTable');body.replaceChildren();document.getElementById('variantsPanel').hidden=legacy;
 if(legacy)return;
 document.getElementById('variantsNote').textContent=v?`保存 ${v.captured}R・確定 ${v.settled}R。展示ST比較対象 ${v.st_eligible}R・欠け/対象外 ${v.st_missing}R。`:'新しく保存する予測から比較を始めます。';
 const st=data?.st_diagnostics?.counts;document.getElementById('stDiagnosticsNote').textContent=st?`展示STの内訳：6艇有効 ${st.eligible}R／負のST（展示F等） ${st.negative_st}R／範囲外 ${st.out_of_range}R／欠け・読取不能 ${st.missing_or_unparseable}R。欠けの過去記録だけでは発表前と取得失敗を区別できません。`:'展示STの原因別集計は次の収集更新後に表示します。';
 const labels={st_0:'展示ST：重みなし',st_12_5:'展示ST：弱め',st_25:'展示ST：標準',st_50:'展示ST：強め',six_equal:'6点・各100円',three_equal:'3点・各200円',two_equal:'2点・各300円',confident_three_weighted:'自信度が高い時に厚張り'};
 for(const group of ['st','budget'])for(const [k,a] of Object.entries(v?.arms?.[group]||{}))row(body,[labels[k]||k,a.races+'R',percentage(a.hit_rate),percentage(a.roi),money(Number(a.payout)-Number(a.investment)),a.risk?`${a.risk.max_consecutive_misses}R`:'—',money(a.risk?.max_drawdown)]);
 if(!body.children.length){const tr=element('tr'),td=element('td','新しい予測の結果が確定すると表示します','empty');td.colSpan=7;tr.append(td);body.append(tr);}
 const daily=document.getElementById('variantDaily');daily.replaceChildren();for(const [date,d] of Object.entries(v?.daily||{}).sort(([a],[b])=>b.localeCompare(a)))row(daily,[date.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1/$2/$3'),...['six_equal','three_equal','two_equal','confident_three_weighted'].map(k=>d.budget?.[k]?money(d.budget[k].payout-d.budget[k].investment):'—')]);
}
function renderGroups(){
  const field=document.getElementById('group').value,body=document.getElementById('groups');body.replaceChildren();
  const groups=data?.diagnostics?.[field]||{};
  if(!Object.keys(groups).length){const tr=element('tr'),td=element('td','確定結果が溜まると表示します','empty');td.colSpan=4;tr.append(td);body.append(tr);return}
  for(const [k,g] of Object.entries(groups)){const label=field==='by_expert'?names[k]||k:field==='by_stadium'?venues[Number(k)]||k:k;row(body,[label,g.races+'R',percentage(g.arms?.baseline?.hit_rate),percentage(g.arms?.candidate?.hit_rate)])}
}
async function refresh(){
  if(busy)return;busy=true;const button=document.getElementById('refresh');button.disabled=true;const selector=document.getElementById('cohort');selector.disabled=true;const source=SOURCES[selector.value];const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{const response=await fetch(source+'?t='+Date.now(),{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('データを取得できませんでした');data=validate(await response.json());render();document.getElementById('error').hidden=true}
  catch(e){const error=document.getElementById('error');error.hidden=false;error.textContent=(data?'更新に失敗しました。前回のデータを表示しています。':'データを取得できません。時間を置いて「更新」を押してください。');const connection=document.getElementById('connection');connection.textContent='接続を確認してください';connection.className='pill warn'}
  finally{clearTimeout(timer);busy=false;button.disabled=false;selector.disabled=false}
}
if(typeof document!=='undefined'){
  document.getElementById('refresh').addEventListener('click',refresh);document.getElementById('six').addEventListener('click',()=>{valueMode=false;if(data)render()});document.getElementById('ev').addEventListener('click',()=>{valueMode=true;if(data)render()});document.getElementById('group').addEventListener('change',renderGroups);
  document.getElementById('shadowSelectionGroup').addEventListener('change',renderShadowSelection);
  document.getElementById('oddsScope').addEventListener('change',renderOdds);document.getElementById('oddsAxis').addEventListener('change',renderOdds);
  document.getElementById('cohort').addEventListener('change',()=>{data=null;for(const id of ['counts','comparison','groups','health','readiness','variantsTable'])document.getElementById(id).replaceChildren();document.getElementById('connection').textContent='データを取得中…';document.getElementById('updated').textContent='収集時刻を確認中';document.getElementById('sample').textContent='結果待ち';document.getElementById('cohortNote').textContent=document.getElementById('cohort').value==='legacy'?'修復前の参考記録を読み込み中。':'修復済み履歴の検証を読み込み中。';refresh();});
  refresh();setInterval(refresh,180000);setInterval(()=>{if(data&&document.getElementById('error').hidden){const s=status(data);const el=document.getElementById('connection');el.textContent=s.text;el.className='pill '+s.kind;}},30000);
}

