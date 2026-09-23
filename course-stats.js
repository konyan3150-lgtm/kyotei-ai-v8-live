let courseStatsData=null;
let courseCorrectionActive=false;

function courseStatValue(value,suffix=''){
  if(value==null||value==='')return '--';
  const number=Number(value);
  return Number.isFinite(number)?`${number.toFixed(number%1?1:0)}${suffix}`:'--';
}

function currentCourse(r,k){
  const exhibition=typeof mergeOriginalEx==='function'?mergeOriginalEx(r,k):{};
  const course=Number(exhibition?.course_number);
  return course>=1&&course<=6?String(course):String(k);
}

function racerCourseStat(r,k,x){
  if(!courseStatsData?.racers)return null;
  return courseStatsData.racers?.[String(x.number)]?.courses?.[currentCourse(r,k)]||null;
}

function normalizedScore(values,value,invert=false){
  const usable=values.filter(v=>v!=null&&v!==''&&Number.isFinite(Number(v))).map(Number);
  if(value==null||value===''||!Number.isFinite(Number(value))||usable.length<3)return 0;
  const mean=usable.reduce((a,b)=>a+b,0)/usable.length;
  const sd=Math.sqrt(usable.reduce((a,b)=>a+(b-mean)**2,0)/usable.length);
  if(sd<1e-9)return 0;
  const z=(Number(value)-mean)/sd;
  return Math.max(-2,Math.min(2,invert?-z:z));
}

function courseFactors(r,k,x){
  const entries=Object.entries(r?.racers||{}),stat=racerCourseStat(r,k,x);
  if(!stat)return [1,1,1];
  const allStats=entries.map(([lane,racer])=>racerCourseStat(r,lane,racer));
  const startScore=normalizedScore(allStats.map(s=>s?.avgStart),stat.avgStart,true);
  return ['win1','win2','win3'].map(field=>{
    const rateScore=normalizedScore(allStats.map(s=>s?.[field]),stat[field]);
    return Math.max(.94,Math.min(1.06,Math.exp(.045*rateScore+.015*startScore)));
  });
}

const baseV8Probs=probs;
probs=function(r,k,x){
  const base=baseV8Probs(r,k,x),factors=courseFactors(r,k,x);
  if(factors.some(v=>Math.abs(v-1)>.0001))courseCorrectionActive=true;
  return base.map((value,index)=>value*factors[index]);
};

function renderCourseStats(r){
  const el=document.getElementById('courseStats');
  if(!el)return;
  const valid=!!courseStatsData?.racers;
  const rows=Object.entries(r?.racers||{}).sort((a,b)=>Number(a[0])-Number(b[0]));
  el.innerHTML=`<div class="coursenote">想定Cは展示進入を優先し、未発表時は枠番を使用｜補正幅は各着順±6%以内</div><table class="data"><thead><tr><th>枠</th><th>想定C</th><th>平均ST</th><th>1着率</th><th>2着率</th><th>3着率</th></tr></thead><tbody>${rows.map(([k,x])=>{const c=currentCourse(r,k),s=valid?courseStatsData.racers?.[String(x.number)]?.courses?.[c]:null;return `<tr><td><span class="lanechip l${k}">${k}</span></td><td class="coursecell">${c}C</td><td>${courseStatValue(s?.avgStart)}</td><td class="${Number(s?.win1)>=30?'coursegood':''}">${courseStatValue(s?.win1,'%')}</td><td>${courseStatValue(s?.win2,'%')}</td><td>${courseStatValue(s?.win3,'%')}</td></tr>`}).join('')}</tbody></table>`;
  const diag=document.getElementById('courseDiag');
  if(diag&&valid){const covered=rows.filter(([k,x])=>racerCourseStat(r,k,x)).length;diag.textContent=`✓ コース別成績取得OK｜${covered}/6艇｜V8コース補正${courseCorrectionActive?'適用中':'待機'}`}
}

async function loadCourseStats(){
  const diag=document.getElementById('courseDiag');
  try{
    if(diag)diag.textContent='コース別成績：公式データ取得中…';
    const cacheDay=typeof day==='function'?day():new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tokyo'}).replaceAll('-','');
    const res=await fetch(`course-stats.json?v=151&d=${cacheDay}`);
    if(!res.ok)throw new Error('HTTP '+res.status);
    const data=await res.json();
    if(data?.schema!=='kyotei-course-stats'||!data.racers)throw new Error('データ形式不一致');
    courseStatsData=data;
    const count=Object.keys(data.racers).length,target=data.targetCount||data.coverage?.reduce((n,v)=>n+(v.racers?.length||0),0)||count;
    if(diag){const stale=data.date!==day(),label=String(data.date||'').replace(/(....)(..)(..)/,'$1/$2/$3');diag.textContent=`✓ コース別成績取得OK｜${count}/${target}人｜${stale?'保存データ '+label+' を利用':'本日データ'}`;}
    if(D&&sid){if(typeof autoSaveAllPredictions==='function')autoSaveAllPredictions();draw()}
  }catch(e){
    courseStatsData=null;
    if(diag)diag.textContent='コース別成績：取得待ち｜'+e.message;
  }
}

const baseRaceRender=race;
race=function(r){courseCorrectionActive=false;baseRaceRender(r);renderCourseStats(r)};
loadCourseStats();
