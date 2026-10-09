let racerAptitudeData=null,racerAptitudeDay='',racerAptitudeLoadPromise=null;
async function decodeRacerAptitudeGzip(res){
  if(!res.ok)throw Error(`gzip HTTP ${res.status}`);
  const encoded=/gzip/i.test(res.headers.get('content-encoding')||'');
  if(encoded)return await res.json();
  if(!res.body||typeof DecompressionStream!=='function')throw Error('gzip展開非対応');
  return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
}
async function fetchRacerAptitude(base){
  const version='160-runtime1',dateKey=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tokyo'}).replaceAll('-','');
  if(typeof DecompressionStream==='function'){
    try{
      const runtimeUrl=`https://raw.githubusercontent.com/konyan3150-lgtm/kyotei-ai-v8-live/main/dev/racer-aptitude-runtime.json.gz?d=${dateKey}&v=${version}`;
      const runtime=await decodeRacerAptitudeGzip(await fetch(runtimeUrl,{cache:'no-store'}));
      if(runtime?.schema!=='kyotei-v8-racer-aptitude')throw Error('runtime形式不一致');
      if(runtime?.runtime?.date&&String(runtime.runtime.date)!==dateKey)throw Error('runtime日付不一致');
      return runtime;
    }catch(e){console.warn('当日用選手適性データ取得失敗。保存版へ切替',e)}
    try{
      const res=await fetch(`${base}racer-aptitude.json.gz?v=${version}`,{cache:'no-cache'});
      return await decodeRacerAptitudeGzip(res);
    }catch(e){console.warn('圧縮選手適性データ取得失敗。通常版へ切替',e)}
  }
  const res=await fetch(`${base}racer-aptitude.json?v=${version}`,{cache:'no-cache'});
  if(!res.ok)throw Error(`HTTP ${res.status}`);
  return await res.json();
}
async function loadRacerAptitudeFull(){
  if(!racerAptitudeLoadPromise)racerAptitudeLoadPromise=(async()=>{const base=location.pathname.includes('/dev/')?'../':'',data=await fetchRacerAptitude(base);if(data?.schema!=='kyotei-v8-racer-aptitude')throw Error('形式不一致');return data})().finally(()=>{racerAptitudeLoadPromise=null});
  return racerAptitudeLoadPromise;
}
const racerAptitudeReady=(async()=>{try{racerAptitudeData=await loadRacerAptitudeFull();return true}catch(e){console.warn('選手適性データ取得失敗',e);return false}})();
function racerIdsInProgram(program){const ids=new Set();for(const venue of Object.values(program?.programs?.stadiums||{}))for(const race of Object.values(venue?.races||{}))for(const racer of Object.values(race?.racers||{})){const id=String(racer?.number||racer?.registration_number||'').trim();if(id)ids.add(id)}return ids}
async function prepareRacerAptitudeForProgram(program,dateKey){
  if(!await racerAptitudeReady)return 0;
  const key=String(dateKey||''),ids=racerIdsInProgram(program);
  if(racerAptitudeDay===key)return Object.keys(racerAptitudeData?.racers||{}).length;
  let data=racerAptitudeData;
  if(racerAptitudeDay&&racerAptitudeDay!==key)data=await loadRacerAptitudeFull();
  const racers={};for(const id of ids){const item=data?.racers?.[id];if(item)racers[id]=item}
  racerAptitudeData={...data,racers};racerAptitudeDay=key;
  console.info(`選手適性DBを端末用に縮小: ${Object.keys(racers).length}/${ids.size}選手`);
  return Object.keys(racers).length;
}
function aptitudeRaw(a){const n=Number(a?.[1]||0),sn=Number(a?.[6]||0),st=sn?Number(a[7])/sn:.17,v=sn?Math.max(0,Number(a[8])/sn-st*st):0;return{win:n?Number(a[2])/n:1/6,top2:n?Number(a[3])/n:2/6,top3:n?Number(a[4])/n:.5,finish:n?Number(a[5])/n:3.5,st,st_std:Math.sqrt(v)}}
function aptitudeSmooth(a,prior,alpha){a=a||[];const n=Number(a[1]||0),sn=Number(a[6]||0),raw=aptitudeRaw(a);return{win:(Number(a[2]||0)+alpha*prior.win)/(n+alpha),top2:(Number(a[3]||0)+alpha*prior.top2)/(n+alpha),top3:(Number(a[4]||0)+alpha*prior.top3)/(n+alpha),finish:(Number(a[5]||0)+alpha*prior.finish)/(n+alpha),st:(Number(a[7]||0)+alpha*prior.st)/(sn+alpha),st_std:raw.st_std}}
function racerAptitudeFeatures(racerId,venue,course){const data=racerAptitudeData,r=data?.racers?.[String(racerId||'')],c=String(Number(course));if(!r||!c)return{};const gp=aptitudeRaw(data.global_course?.[c]),o=aptitudeSmooth(r.o,gp,30),cs=r.c?.[c]||[],cv=aptitudeSmooth(cs,o,16),vs=r.v?.[venue]||[],vv=aptitudeSmooth(vs,o,16),xs=r.x?.[`${venue}:${c}`]||[],xp={win:(cv.win+vv.win)/2,top2:(cv.top2+vv.top2)/2,top3:(cv.top3+vv.top3)/2,finish:(cv.finish+vv.finish)/2,st:(cv.st+vv.st)/2},xv=aptitudeSmooth(xs,xp,10),selected=Number(xs[1]||0)>=8?xv:Number(cs[1]||0)>=12?cv:Number(vs[1]||0)>=12?vv:o;return{APT_STARTS:Number(r.o?.[0]||0),APT_WIN:o.win,APT_TOP2:o.top2,APT_TOP3:o.top3,APT_MEAN_FINISH:o.finish,APT_MEAN_ST:o.st,APT_ST_STD:o.st_std,APT_COURSE_STARTS:Number(cs[0]||0),APT_COURSE_WIN:cv.win,APT_COURSE_TOP2:cv.top2,APT_COURSE_TOP3:cv.top3,APT_COURSE_ST:cv.st,APT_VENUE_STARTS:Number(vs[0]||0),APT_VENUE_WIN:vv.win,APT_VENUE_TOP2:vv.top2,APT_VENUE_TOP3:vv.top3,APT_VENUE_ST:vv.st,APT_VC_STARTS:Number(xs[0]||0),APT_SELECTED_WIN:selected.win,APT_SELECTED_TOP2:selected.top2,APT_SELECTED_TOP3:selected.top3,APT_SELECTED_ST:selected.st,APT_VENUE_COURSE_ADV:selected.win-gp.win}}
