(function(root){
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const num=v=>v==null||v===''?NaN:Number.isFinite(Number(v))?Number(v):NaN;
  const labels={normal:'通常',inside:'イン逃げ',upset:'イン崩れ・穴',exhibition:'展示変化',water:'水面'};
  // Fixed prospective rules. These thresholds were not fitted to historical returns.
  function classify(scores,signals={}){
    const inside=num(scores.inside),ex=num(scores.exhibition),water=num(scores.water);
    const raw={normal:50,inside:Number.isFinite(inside)?clamp((inside-50)*2,0,100):0,
      upset:Number.isFinite(inside)?clamp((50-inside)*2,0,100):0,
      exhibition:Number.isFinite(ex)?clamp((ex-50)*2,0,100):0,
      water:Number.isFinite(water)?clamp((water-50)*2,0,100):0};
    const active=Object.entries(raw).sort((a,b)=>b[1]-a[1])[0][0],sum=Object.values(raw).reduce((a,b)=>a+b,0);
    return{version:2,policy:'neutral50-specialist-evidence-v2',active,label:labels[active],
      weights:Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,v/sum])),scores:{...scores},signals:{...signals},used_in_prediction:false};
  }
  function exhibitionScores(r){
    const rows=Object.keys(r.racers||{}),out=Object.fromEntries(rows.map(k=>[k,0]));
    for(const [f,w] of [['exhibition_time',30],['start_timing',25],['lap_time',20],['turn_time',15],['straight_time',10]]){
      const vals=rows.map(k=>[k,num(r.preview?.racers?.[k]?.[f])]).filter(([,v])=>Number.isFinite(v)&&v>=0);
      if(vals.length<2)continue;const min=Math.min(...vals.map(x=>x[1])),max=Math.max(...vals.map(x=>x[1]));
      for(const [k,v] of vals)out[k]+=(max===min?.5:(max-v)/(max-min))*w;
    }
    return out;
  }
  function assess(r,rows,exOverride){
    const one=rows.find(z=>String(z.k)==='1'),others=rows.filter(z=>String(z.k)!=='1');
    const diff=(field,scale=1)=>{const a=num(one?.x?.[field]),xs=others.map(z=>num(z.x?.[field])).filter(Number.isFinite);return Number.isFinite(a)&&xs.length?(a-xs.reduce((s,v)=>s+v,0)/xs.length)*scale:0};
    const winDiff=diff('national_win_rate'),localDiff=diff('local_win_rate'),startEdge=diff('average_start_timing',-10),motorDiff=diff('motor_top_2_percent',.1);
    const inside=clamp(50+winDiff*10+localDiff*5+startEdge*4+motorDiff*4,0,100);
    const ex=exOverride||exhibitionScores(r),vals=Object.values(ex).filter(Number.isFinite),exhibition=vals.length>=2?clamp((Math.max(...vals)-Math.min(...vals))*1.4,0,100):0;
    const wind=num(r.preview?.wind_speed),wave=num(r.preview?.wave_height),water=clamp((Number.isFinite(wind)?wind*12:0)+(Number.isFinite(wave)?wave*3:0),0,100);
    return classify({inside,exhibition,water},{winDiff,localDiff,startEdge,motorDiff,wind:Number.isFinite(wind)?wind:null,wave:Number.isFinite(wave)?wave:null});
  }
  const api={classify,assess};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.v8ExpertClassifierV2=api;
})(globalThis);
