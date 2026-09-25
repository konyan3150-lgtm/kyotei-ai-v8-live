(function(){
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),num=v=>Number.isFinite(Number(v))?Number(v):NaN;
function norm(ws){const s=Object.values(ws).reduce((a,b)=>a+b,0)||1;for(const k of Object.keys(ws))ws[k]=ws[k]/s;return ws}
function score(r,rows){
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
})();
