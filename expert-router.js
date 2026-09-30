(function(){
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),num=v=>Number.isFinite(Number(v))?Number(v):NaN;
function norm(ws){const s=Object.values(ws).reduce((a,b)=>a+b,0)||1;for(const k of Object.keys(ws))ws[k]=ws[k]/s;return ws}
function score(r,rows){
 if(window.v8ExpertClassifierV2)return window.v8ExpertClassifierV2.assess(r,rows,typeof exhibitionScores==='function'?exhibitionScores(r):undefined);
 const one=rows.find(z=>String(z.k)==='1'),others=rows.filter(z=>String(z.k)!=='1');
 const win=x=>num(x?.x?.national_win_rate),local=x=>num(x?.x?.local_win_rate),st=x=>num(x?.x?.average_start_timing),motor=x=>num(x?.x?.motor_top_2_percent);
 const avg=(arr,f)=>{const a=arr.map(f).filter(Number.isFinite);return a.length?a.reduce((s,v)=>s+v,0)/a.length:NaN};
 const diff=(f,sign=1)=>{const a=f(one),b=avg(others,f);return Number.isFinite(a)&&Number.isFinite(b)?(a-b)*sign:0};
 const dWin=diff(win),dLocal=diff(local),dSt=diff(st,-1)*10,dMotor=diff(motor)/10;
 const inner=clamp(50+dWin*10+dLocal*5+dSt*4+dMotor*4,0,100);
 const ex=typeof exhibitionScores==='function'?exhibitionScores(r):{},vals=Object.values(ex).map(Number).filter(Number.isFinite);
 const exSpread=vals.length>=2?Math.max(...vals)-Math.min(...vals):0, exhibition=clamp(exSpread*1.4,0,100);
 const p=r?.preview||{},wind=num(p.wind_speed),wave=num(p.wave_height),water=clamp((Number.isFinite(wind)?wind*12:0)+(Number.isFinite(wave)?wave*3:0),0,100);
 const upset=clamp(100-inner*.78+Math.max(0,exhibition-45)*.28+Math.max(0,water-45)*.25,0,100);
 let w={normal:30,inside:inner,upset:upset*.8,exhibition:exhibition*.65,water:water*.7};norm(w);
 const labels={normal:'通常',inside:'イン逃げ',upset:'イン崩れ・穴',exhibition:'展示変化',water:'水面'};
 const active=Object.entries(w).sort((a,b)=>b[1]-a[1]);
 return{version:1,active:active[0][0],label:labels[active[0][0]],weights:w,scores:{inside:inner,upset,exhibition,water},signals:{winDiff:dWin,localDiff:dLocal,startEdge:dSt,motorDiff:dMotor,wind:Number.isFinite(wind)?wind:null,wave:Number.isFinite(wave)?wave:null}};
}
window.v8ExpertAssessment=score;
window.v8ExpertSummary=function(r,rows){const x=score(r,rows),L={normal:'通常',inside:'イン逃げ',upset:'イン崩れ・穴',exhibition:'展示',water:'水面'};return Object.entries(x.weights).sort((a,b)=>b[1]-a[1]).map(([k,v])=>L[k]+' '+Math.round(v*100)+'%').join(' / ')};
function renderExpertAccum(data){const s=data?.expert_summary,host=document.getElementById('expertDiag');if(!host||!s)return;let el=document.getElementById('expertAccum');if(!el){el=document.createElement('div');el.id='expertAccum';el.style.cssText='margin-top:10px;color:#8fa6b8;font-size:12px';host.insertAdjacentElement('afterend',el)}const groups=Object.values(s.by_active||{}).filter(x=>Number(x.saved)).sort((a,b)=>Number(b.saved)-Number(a.saved)).slice(0,3).map(x=>x.label+' '+x.saved+'R').join('・');el.textContent='Expert v1蓄積：'+Number(s.saved||0)+'R（結果 '+Number(s.settled||0)+'R）｜完全保存 '+Number(s.live||0)+'R・過去復元 '+Number(s.reconstructed||0)+'R'+(groups?'｜'+groups:'')}
window.addEventListener('v8-server-predictions',e=>renderExpertAccum(e.detail));if(window.__v8ServerPredictionData)setTimeout(()=>renderExpertAccum(window.__v8ServerPredictionData),0);
async function refreshV2Accum(){
 try{const r=await fetch('https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-dev/main/dev/expert-v2.json?x='+Date.now(),{cache:'no-store'});if(!r.ok)return;const d=await r.json();if(d.version!==2)return;const host=document.getElementById('expertDiag');if(!host)return;let el=document.getElementById('expertV2Accum');if(!el){el=document.createElement('div');el.id='expertV2Accum';el.className='foot';host.insertAdjacentElement('afterend',el)}el.textContent='Expert v2締切前保存：'+Number(d.summary?.saved||0)+'R（結果 '+Number(d.summary?.settled||0)+'R）｜v1とは別集計'}catch(e){}
}
setTimeout(refreshV2Accum,1800);setInterval(refreshV2Accum,180000);
})();
