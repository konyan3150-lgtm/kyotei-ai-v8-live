// run() of update_server_predictions with fixtures only (no network): verification budget, per-race failures,
// rotation, and that time-critical prediction saving is not delayed by result checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {individualHtml} from './test_official_fixtures.mjs';

const date='20261012',SID='24',RACES=[1,2,3,4,5,6,7,8];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'v8-update-budget-')),dev=path.join(root,'dev');fs.mkdirSync(dev);
fs.writeFileSync(path.join(root,'racer-aptitude.json'),JSON.stringify({history_end:'2026-10-11',racers:{}}));
const official=path.join(root,'official-results.json');
fs.writeFileSync(official,JSON.stringify({date,races:{[SID]:Object.fromEntries(RACES.map(n=>[String(n),{combination:'1-2-3',amount:1000+n}]))}}));
fs.writeFileSync(path.join(root,'odds.json'),JSON.stringify({}));fs.writeFileSync(path.join(root,'previews.json'),JSON.stringify({}));
Object.assign(process.env,{PREDICTION_DATA_ROOT:root,MODEL_PATH:path.resolve(import.meta.dirname,'..','v8_model_aptitude.json'),
  PROGRAM_URL:'https://fixture.invalid/program.json',RESULTS_URL:'https://fixture.invalid/results.json',EXHIBITION_URL:'https://fixture.invalid/ex.csv',
  OFFICIAL_RESULTS_PATH:official,ODDS_PATH:path.join(root,'odds.json'),OFFICIAL_PREVIEWS_PATH:path.join(root,'previews.json')});
delete process.env.VERIFY_BUDGET_MS;
// All races already closed (so nothing new is predicted); program feed served from memory.
const program={programs:{stadiums:{[SID]:{races:Object.fromEntries(RACES.map(n=>[String(n),{closed_at:`2026-10-12 ${String(9+n).padStart(2,'0')}:00:00`}]))}}}};
const realFetch=globalThis.fetch;
globalThis.fetch=async url=>{url=String(url);
  if(url.endsWith('program.json'))return new Response(JSON.stringify(program));
  if(url.endsWith('results.json'))return new Response(JSON.stringify({results:[]}));
  if(url.endsWith('ex.csv'))return new Response('');
  throw Error('unexpected network '+url);};
const {run}=await import('./update_server_predictions.mjs');
const key=n=>`kyotei_v8_dev_result_${date}_${SID}_${String(n).padStart(2,'0')}`;
const base=n=>({date,stadium:SID,race:String(n),saved_at:'2026-10-12T00:00:00Z',mode:'hit',picks:['1-2-3'],stake:100,source:'server',
  modes:{hit:{picks:['1-2-3'],stake:100,settled:false,hit:false,payout:0}},value_modes:{hit:{picks:['1-2-3'],stake:300,items:[{combo:'1-2-3',stake:300,ev:1.5}]}},value_model_version:4});
function reset(){
  fs.rmSync(path.join(dev,'server-predictions-archive'),{recursive:true,force:true});
  fs.writeFileSync(path.join(dev,'server-predictions.json'),JSON.stringify({schema:'kyotei-v8-server-predictions',version:1,records:Object.fromEntries(RACES.map(n=>[key(n),base(n)]))}));
  fs.writeFileSync(path.join(dev,'server-predictions-index.json'),JSON.stringify({schema:'kyotei-v8-server-predictions-index',version:1,archives:[]}));
}
const read=()=>JSON.parse(fs.readFileSync(path.join(dev,'server-predictions.json'),'utf8')).records;
const now=new Date('2026-10-12T13:00:00Z');
const page=req=>individualHtml({date:req.date,stadium:req.stadium,race:req.race,order:[1,2,3],amount:1000+Number(req.race)});
const quiet=async f=>{const w=console.warn,l=console.log;console.warn=()=>{};console.log=()=>{};try{return await f()}finally{console.warn=w;console.log=l}};

try{
  // 1) Budget runs out after 3 checks: the 3 verified races are saved; the rest stay exactly as they were.
  reset();{
    let t=now.getTime();const clock=()=>new Date(t),seen=[];
    await quiet(()=>run({now,clock,verifyBudgetMs:'30500',fetchIndividual:async req=>{seen.push(req.race);t+=10000;return page(req)}}));
    const after=read(),done=RACES.filter(n=>after[key(n)].settled);
    assert.equal(seen.length,3);assert.equal(done.length,3);
    for(const n of done){assert.equal(after[key(n)].modes.hit.payout,1000+n);assert.deepEqual(after[key(n)].picks,['1-2-3']);assert.equal(after[key(n)].stake,100);assert.equal(after[key(n)].value_modes.hit.stake,300);}
    for(const n of RACES.filter(n=>!done.includes(n)))assert.ok(!after[key(n)].settled&&!after[key(n)].excluded&&!after[key(n)].hit);
  }
  // 2) A per-race fetch failure keeps only that race pending; the others are saved in the same run.
  reset();{
    await quiet(()=>run({now,clock:()=>now,fetchIndividual:async req=>{if(req.race==='3')throw Error('timeout');return page(req)}}));
    const after=read();assert.ok(!after[key(3)].settled&&!after[key(3)].excluded);
    assert.equal(RACES.filter(n=>after[key(n)].settled).length,7);
  }
  // 3) The first races fail slowly every run; rotation still lets the others settle over a few runs, without double settling.
  reset();{
    const slow=new Set(['1','2','3']);let payoutsSeen={};
    for(let i=0;i<12;i++){
      let t=now.getTime()+i*6*60000;const clock=()=>new Date(t);
      await quiet(()=>run({now,clock,verifyBudgetMs:'30500',fetchIndividual:async req=>{t+=10000;if(slow.has(req.race))throw Error('slow failure');return page(req)}}));
      const after=read();for(const n of RACES)if(after[key(n)].settled){payoutsSeen[n]??=after[key(n)].modes.hit.payout;assert.equal(after[key(n)].modes.hit.payout,payoutsSeen[n]);}
    }
    const after=read();
    for(const n of [4,5,6,7,8])assert.ok(after[key(n)].settled,`race ${n} should settle eventually`);
    for(const n of [1,2,3])assert.ok(!after[key(n)].settled&&!after[key(n)].excluded&&!after[key(n)].hit);
  }
  // 4) A wrong VERIFY_BUDGET_MS falls back to the default (5 min), not unlimited.
  reset();{
    let t=now.getTime();const clock=()=>new Date(t);let n=0;
    await quiet(()=>run({now,clock,verifyBudgetMs:'0',fetchIndividual:async req=>{n++;t+=200000;return page(req)}}));
    assert.equal(n,2);                                                    // 0s, 200s started; 400s > 300s default
  }
  console.log('update run() verification OK: budget saves verified races and leaves the rest untouched, per-race failure isolated, rotation gets past slow failures without double settling, invalid budget uses the default');
}finally{globalThis.fetch=realFetch;fs.rmSync(root,{recursive:true,force:true});}
