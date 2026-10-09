(function(){
  const PREFIX='kyotei_v8_dev_result_';
  const EPS=1e-6, MIN_SAMPLES=120, MAX_RACES=240;
  let cacheKey='', cache=null;
  const clamp=p=>Math.max(EPS,Math.min(1-EPS,Number(p)||EPS));
  const sigmoid=z=>z>=0?1/(1+Math.exp(-z)):Math.exp(z)/(1+Math.exp(z));

  function trainingRows(){
    const races=[];
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(!key||!key.startsWith(PREFIX))continue;
      let rec;try{rec=JSON.parse(localStorage.getItem(key)||'null')}catch(e){continue}
      const result=String(rec?.result||Object.values(rec?.modes||{}).find(x=>x?.result)?.result||'').trim();
      if(!rec?.probabilities||!/^[1-6]-[1-6]-[1-6]$/.test(result))continue;
      races.push(rec);
    }
    races.sort((a,b)=>String(a.saved_at||'').localeCompare(String(b.saved_at||'')));
    return races.slice(-MAX_RACES);
  }

  function fitBeta(samples){
    if(samples.length<MIN_SAMPLES)return null;
    let w=[1,1,0], lr=.035;
    for(let iter=0;iter<450;iter++){
      let g=[0,0,0];
      for(const s of samples){
        const p=clamp(s.p),x=[Math.log(p),-Math.log(1-p),1],q=sigmoid(w[0]*x[0]+w[1]*x[1]+w[2]),d=q-s.y;
        g[0]+=d*x[0];g[1]+=d*x[1];g[2]+=d;
      }
      const n=samples.length, ridge=.002;
      g[0]=g[0]/n+ridge*(w[0]-1);g[1]=g[1]/n+ridge*(w[1]-1);g[2]/=n;
      const step=lr/Math.sqrt(1+iter/80);
      w=w.map((v,j)=>Math.max(-8,Math.min(8,v-step*g[j])));
    }
    return w;
  }

  function build(){
    const races=trainingRows(), key=races.length+':'+String(races.at(-1)?.saved_at||'');
    if(cache&&cacheKey===key)return cache;
    const samples=[[],[],[]];
    for(const rec of races){
      const result=String(rec.result||Object.values(rec.modes||{}).find(x=>x?.result)?.result||'').split('-');
      for(const [lane,ps] of Object.entries(rec.probabilities||{})){
        for(let pos=0;pos<3;pos++){
          const p=Number(ps?.[pos]);if(Number.isFinite(p))samples[pos].push({p,y:String(lane)===String(result[pos])?1:0});
        }
      }
    }
    const weights=samples.map(fitBeta), active=weights.every(Boolean);
    cacheKey=key;cache={active,weights,races:races.length,samples:samples.map(x=>x.length)};
    return cache;
  }

  function calibrate(p,pos){
    const m=build(),w=m.weights?.[pos];p=clamp(p);
    if(!m.active||!w)return p;
    return clamp(sigmoid(w[0]*Math.log(p)+w[1]*(-Math.log(1-p))+w[2]));
  }

  window.v8CalibrationStatus=()=>build();
  window.calibratedPredictionRows=function(rows){
    const out=(rows||[]).map(z=>({...z,p:Array.isArray(z.p)?z.p.map(Number):z.p}));
    if(!out.length||out.some(z=>!Array.isArray(z.p)))return out;
    for(let pos=0;pos<3;pos++){
      const vals=out.map(z=>calibrate(z.p[pos],pos)),sum=vals.reduce((a,b)=>a+b,0)||1;
      out.forEach((z,i)=>z.p[pos]=vals[i]/sum);
    }
    return out;
  };
})();