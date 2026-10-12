import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyBudget,parseBudgetMs,rotate,FETCH_ATTEMPTS,RETRY_DELAY_MS,MIN_FETCH_TIMEOUT_MS,MIN_START_MS} from './verify_budget.mjs';
import {recover} from './settle_pending_results.mjs';
import {parseOfficialPayPage} from './fetch_official_results.mjs';
import {verifyIndividualResult} from './verified_outcome.mjs';
import {writeJsonBatch} from './history_store.mjs';

// Budget helper: a fetch only starts with at least 1s left; per-attempt timeout fits the remaining time.
{let t=0;const b=verifyBudget({budgetMs:20000,clock:()=>t});
 assert.equal(MIN_START_MS,2250);
 assert.equal(b.fetchTimeoutMs(),9875);assert.equal(b.allow(),true);t=12000;assert.equal(b.fetchTimeoutMs(),3875);
 t=17750;assert.equal(b.fetchTimeoutMs(),1000);assert.equal(b.allow(),true);   // 2250 left: 1000+250+1000 fits exactly
 t=18500;assert.equal(b.allow(),false);t=19001;assert.equal(b.allow(),false);   // 1500 left: two attempts cannot fit
 b.note('settled');b.note('settled');b.note('pending:payout_pending');
 assert.deepEqual(b.summary(),{limit_ms:20000,limit_source:'configured',elapsed_ms:19001,attempts:2,deferred_by_time_budget:2,outcomes:{settled:2,'pending:payout_pending':1}});}
// Configuration: missing -> default; explicit "unlimited" -> no limit; wrong values -> default (never unlimited by mistake).
assert.deepEqual(parseBudgetMs(undefined,300000),{ms:300000,source:'default'});
assert.deepEqual(parseBudgetMs('',300000),{ms:300000,source:'default'});
assert.deepEqual(parseBudgetMs('120000',300000),{ms:120000,source:'configured'});
assert.deepEqual(parseBudgetMs('unlimited',300000),{ms:Infinity,source:'unlimited'});
for(const bad of ['0','-5','abc','NaN','Infinity1',0,-1])assert.equal(parseBudgetMs(bad,300000).ms,300000,String(bad));
assert.equal(parseBudgetMs('0',300000).source,'invalid_fallback');
assert.throws(()=>parseBudgetMs('1000',0));
{const w=console.warn;console.warn=()=>{};try{const b=verifyBudget({budgetMs:'-1',defaultMs:480000});assert.equal(b.limitMs,480000);assert.equal(b.summary().limit_source,'invalid_fallback');}finally{console.warn=w}}
{const b=verifyBudget({budgetMs:'unlimited'});for(let i=0;i<1000;i++)assert.equal(b.allow(),true);assert.equal(b.fetchTimeoutMs(),15000);assert.equal(b.summary().limit_ms,null);}
{const b=verifyBudget({});assert.equal(b.limitMs,300000);}
// Worst case: every started fetch times out on every attempt. Total time never exceeds the budget.
for(const limit of [1000,1500,2000,2249,2250,2251,5000,29999,30000,61234,300000,480000]){
  let t=0;const b=verifyBudget({budgetMs:limit,clock:()=>t});
  while(b.allow())t+=FETCH_ATTEMPTS*b.fetchTimeoutMs()+(FETCH_ATTEMPTS-1)*RETRY_DELAY_MS;
  assert.ok(t<=limit,`limit ${limit}: ${t}`);
}
// The same holds with a jittery clock between checks (time also passes outside fetches).
for(let seed=1;seed<200;seed++){let t=0,x=seed;const b=verifyBudget({budgetMs:10000+seed*137,clock:()=>t});
  while(true){x=(x*1103515245+12345)%2147483648;t+=x%700;if(!b.allow())break;t+=FETCH_ATTEMPTS*b.fetchTimeoutMs()+(FETCH_ATTEMPTS-1)*RETRY_DELAY_MS;assert.ok(t<=10000+seed*137,`seed ${seed}`);}}
// Rotation keeps every item, changes the head between runs.
assert.deepEqual(rotate([],3),[]);
for(const n of [1,2,6,10,12,60,97]){const list=[...Array(n).keys()];
  // Same items in a cyclic order, deterministic per run time.
  for(const ms of [0,123456789,Date.parse('2026-10-12T13:17:00Z')]){const r=rotate(list,ms);assert.deepEqual([...r].sort((a,b)=>a-b),list);assert.deepEqual(rotate(list,ms),r);
    for(let i=0;i<n;i++)assert.equal(r[(i+1)%n],(r[i]+1)%n);}
  // Fixed schedules (hourly at :17, every 6 minutes) still reach many different starting points.
  if(n>1)for(const step of [60*60000,6*60000]){const heads=new Set();for(let k=0;k<200;k++)heads.add(rotate(list,Date.parse('2026-10-12T00:17:00Z')+k*step)[0]);
    assert.ok(heads.size>=Math.min(n,Math.ceil(n*0.6)),`n=${n} step=${step}: ${heads.size} starts`);}
}

// Official pages for one day: race n won 1-2-3 paying 1000+n yen at venue 24.
const date='20261012',SID='24',lanes=[1,2,3,4,5,6];
const payHtml=races=>races.map(n=>`<td data-href="/owpc/pc/race/raceresult?rno=${n}&amp;jcd=${SID}&amp;hd=${date}"><span class="numberSet1_number is-type1">1</span><span class="numberSet1_number is-type2">2</span><span class="numberSet1_number is-type3">3</span></td><td><span class="is-payout1">&yen;${(1000+n).toLocaleString('en-US')}</span></td>`).join('');
const individual=n=>`<div class="tab3 is-type1"><ul><li><a href="/owpc/pc/race/racelist?rno=${n}&amp;jcd=${SID}&amp;hd=${date}">出走表</a></li><li>結果</li></ul></div>
<table><thead><tr><th>着</th><th>枠</th><th>ボートレーサー</th><th>レースタイム</th></tr></thead><tbody>${lanes.map(l=>`<tr><td>${l}</td><td>${l}</td><td><span>${4000+l}</span></td><td>1'50"0</td></tr>`).join('')}</tbody></table>
<table><thead><tr><th>返還</th></tr></thead><tbody><tr><td><div class="numberSet1"></div></td></tr></tbody></table>
<table><thead><tr><th>勝式</th><th>組番</th><th>払戻金</th></tr></thead><tbody><tr><td>3連単</td><td><span class="numberSet1_number is-type1">1</span><span class="numberSet1_number is-type2">2</span><span class="numberSet1_number is-type3">3</span></td><td><span class="is-payout1">&yen;${(1000+n).toLocaleString('en-US')}</span></td></tr></tbody></table>`;
const races=[1,2,3,4,5,6];
// Fixtures must pass the real parsers, otherwise the test proves nothing.
const parsedPay=parseOfficialPayPage(payHtml(races),date);
assert.equal(parsedPay.races[SID]['3'].combination,'1-2-3');assert.equal(parsedPay.races[SID]['3'].amount,1003);
const v=await verifyIndividualResult({date,stadium:SID,race:'3'},parsedPay.races[SID]['3'],{fetchIndividual:async()=>individual(3)});
assert.equal(v.combination,'1-2-3');assert.equal(v.amount,1003);assert.ok(v.verification?.html_sha256);

function makeRoot(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v8-budget-test-')),dir=path.join(root,'dev');fs.mkdirSync(dir);
  const records=Object.fromEntries(races.map(n=>[`kyotei_v8_dev_result_${date}_${SID}_${String(n).padStart(2,'0')}`,
    {date,stadium:SID,race:String(n),saved_at:'2026-10-12T00:00:00Z',mode:'hit',picks:['1-2-3'],stake:100,modes:{hit:{picks:['1-2-3'],stake:100}}}]));
  fs.writeFileSync(path.join(dir,'server-predictions.json'),JSON.stringify({schema:'kyotei-v8-server-predictions',version:1,records}));
  fs.writeFileSync(path.join(dir,'server-predictions-index.json'),JSON.stringify({schema:'kyotei-v8-server-predictions-index',version:1,archives:[]}));
  return {root,file:path.join(dir,'server-predictions.json')};
}
const read=file=>JSON.parse(fs.readFileSync(file,'utf8')).records;
const now=new Date('2026-10-12T14:00:00Z');

// 1) Budget allows 2 verifications: those 2 are saved, the other 4 stay pending and untouched (never settled unverified).
{
  const {root,file}=makeRoot(),before=read(file);let t=0,fetched=[];
  const out=await recover({root,now,verifyBudgetMs:'55500',clock:()=>t,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>{fetched.push(req.race);t+=30000;return individual(Number(req.race));}});
  assert.equal(out.settled,2);assert.equal(out.deferred,4);assert.equal(fetched.length,2);
  const after=read(file),done=Object.values(after).filter(r=>r.settled);
  assert.equal(done.length,2);for(const r of done)assert.equal(r.modes.hit.payout,(1000+Number(r.race)));
  for(const [k,r] of Object.entries(after))if(!r.settled)assert.deepEqual(r,before[k]);
  // 2) Next run continues from where it stopped and finishes the backlog.
  t=0;fetched=[];
  const out2=await recover({root,now,verifyBudgetMs:'55500',clock:()=>t,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>{fetched.push(req.race);t+=30000;return individual(Number(req.race));}});
  assert.equal(out2.settled,2);assert.ok(fetched.every(r=>!done.some(d=>d.race===r)));
  const out3=await recover({root,now,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>individual(Number(req.race))});
  assert.equal(out3.settled,2);assert.equal(out3.pending,0);assert.equal(Object.values(read(file)).filter(r=>r.settled).length,6);
  fs.rmSync(root,{recursive:true});
}
// 3) One failed per-race fetch keeps only that race pending; the others are still saved.
{
  const {root,file}=makeRoot(),before=read(file);
  const out=await recover({root,now,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>{if(req.race==='4')throw Error('timeout');return individual(Number(req.race));}});
  assert.equal(out.settled,5);assert.equal(out.fetchFailures,1);
  const after=read(file),k4=`kyotei_v8_dev_result_${date}_${SID}_04`;
  assert.deepEqual(after[k4],before[k4]);assert.equal(Object.values(after).filter(r=>r.settled).length,5);
  fs.rmSync(root,{recursive:true});
}
// 4) Default (no budget env) behaves as before: everything verified in one run.
{
  const {root,file}=makeRoot();
  const out=await recover({root,now,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>individual(Number(req.race))});
  assert.equal(out.settled,6);assert.equal(out.deferred,0);assert.equal(out.fetchFailures,0);
  fs.rmSync(root,{recursive:true});
}
// 5) The pay page itself failing is still an error (nothing written).
{
  const {root,file}=makeRoot(),before=fs.readFileSync(file,'utf8');
  await assert.rejects(recover({root,now,fetchPage:async()=>{throw Error('pay page down')},fetchIndividual:async()=>{throw Error('should not fetch')}}),/could not be fetched/);
  assert.equal(fs.readFileSync(file,'utf8'),before);fs.rmSync(root,{recursive:true});
}
// 6) Invalid individual result (page not final) stays pending, never a miss; refund stays excluded as before.
{
  const {root,file}=makeRoot(),before=read(file);
  const refund=n=>individual(n).replace('<tbody><tr><td><div class="numberSet1"></div></td></tr></tbody>','<tbody><tr><td><div class="numberSet1"><span class="numberSet1_number is-type4">4</span></div></td></tr></tbody>');
  const out=await recover({root,now,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>req.race==='2'?'<html>not ready</html>':req.race==='5'?refund(5):individual(Number(req.race))});
  const after=read(file),k=n=>`kyotei_v8_dev_result_${date}_${SID}_0${n}`;
  assert.deepEqual(after[k(2)],before[k(2)]);                      // unverifiable: untouched, pending
  assert.ok(after[k(5)].excluded&&!after[k(5)].settled);            // refund: excluded by the existing rule
  assert.equal(out.settled,4);assert.equal(out.excluded,1);assert.equal(out.pending,1);
  // Saved purchases are never rewritten by settlement.
  for(const n of [1,3,4,6]){const r=after[k(n)];assert.deepEqual([r.picks,r.stake,r.saved_at,r.modes.hit.picks,r.modes.hit.stake],[before[k(n)].picks,before[k(n)].stake,before[k(n)].saved_at,before[k(n)].modes.hit.picks,before[k(n)].modes.hit.stake]);}
  // Re-running does not settle twice or change settled payouts.
  const settledSnapshot=JSON.stringify(Object.fromEntries(Object.entries(after).filter(([,r])=>r.settled||r.excluded)));
  await recover({root,now,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>{assert.equal(req.race,'2');return individual(2);}});
  const again=read(file);assert.equal(JSON.stringify(Object.fromEntries(Object.entries(again).filter(([k2])=>JSON.parse(settledSnapshot)[k2]))),settledSnapshot);
  assert.ok(again[k(2)].settled);
  fs.rmSync(root,{recursive:true});
}
// 7) A real network fetch that hangs is cut off by the remaining-time timeout instead of blocking the job.
{
  const realFetch=globalThis.fetch;let seen=[];
  globalThis.fetch=(url,{signal}={})=>new Promise((_,reject)=>{seen.push(url);signal?.addEventListener('abort',()=>reject(signal.reason));});
  const keepAlive=setInterval(()=>{},20); // AbortSignal.timeout timers do not keep the process alive on their own
  try{const t0=Date.now();
    await assert.rejects(verifyIndividualResult({date,stadium:SID,race:'1'},{combination:'1-2-3',amount:1001},{timeoutMs:50}));
    assert.ok(Date.now()-t0<2000);assert.equal(seen.length,2);assert.ok(seen[0].includes('raceresult?rno=1&jcd=24&hd=20261012'));
  }finally{globalThis.fetch=realFetch;clearInterval(keepAlive);}
}
// 8) The write is atomic: a failure before rename leaves the original history file intact.
{
  const {root,file}=makeRoot(),before=fs.readFileSync(file,'utf8');
  assert.throws(()=>writeJsonBatch([[file,{schema:'kyotei-v8-server-predictions',version:1,records:{}}]],{beforeRename:()=>{throw Error('disk full')}}),/disk full/);
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n=>n.includes('.tmp-')),[]);
  fs.rmSync(root,{recursive:true});
}
// 9) Not enough time left for the day's pay page: the date waits for the next run (no fetch, no write, no error).
{
  const {root,file}=makeRoot(),before=fs.readFileSync(file,'utf8');
  const out=await recover({root,now,verifyBudgetMs:'30000',clock:()=>0,fetchPage:async()=>{throw Error('should not fetch the pay page')},fetchIndividual:async()=>{throw Error('should not fetch')}});
  assert.equal(out.deferredDates,1);assert.equal(out.settled,0);assert.equal(fs.readFileSync(file,'utf8'),before);
  // The pay page timeout never exceeds the time left.
  let asked;await recover({root,now,verifyBudgetMs:'40000',clock:()=>0,fetchPage:async(d,{timeoutMs})=>{asked=timeoutMs;return payHtml(races)},fetchIndividual:async req=>individual(Number(req.race))});
  assert.equal(asked,30000);
  fs.rmSync(root,{recursive:true});
}
// 10) Recovery: the first races fail slowly every run; rotation lets the rest settle over a few runs, no double settlement.
{
  const {root,file}=makeRoot();const slow=new Set(['1','2']);const first={};
  for(let i=0;i<10;i++){
    let t=i*60*60000;
    await recover({root,now,verifyBudgetMs:'55500',clock:()=>t,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>{t+=30000;if(slow.has(req.race))throw Error('slow failure');return individual(Number(req.race));}});
    for(const r of Object.values(read(file)))if(r.settled){first[r.race]??=r.modes.hit.payout;assert.equal(r.modes.hit.payout,first[r.race]);}
  }
  const after=Object.values(read(file));
  assert.deepEqual(after.filter(r=>r.settled).map(r=>r.race).sort(),['3','4','5','6']);
  assert.ok(after.filter(r=>slow.has(r.race)).every(r=>!r.settled&&!r.excluded&&!r.hit));
  fs.rmSync(root,{recursive:true});
}
console.log('Verification time budget OK: partial progress saved, rest pending and untouched, next run continues without double settlement, per-race fetch failure and unverifiable pages stay pending, refunds still excluded, saved purchases unchanged, hanging fetch cut off, pay page failure fatal, atomic write, safe budget parsing, worst-case time never exceeds the budget, pay page deferred when out of time, rotation past slow failures');
