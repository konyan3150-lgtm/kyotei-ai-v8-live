import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyBudget} from './verify_budget.mjs';
import {recover} from './settle_pending_results.mjs';
import {parseOfficialPayPage} from './fetch_official_results.mjs';
import {verifyIndividualResult} from './verified_outcome.mjs';

// Budget helper: unlimited by default, counts deferrals once the limit is reached.
{let t=0;const b=verifyBudget({budgetMs:100,clock:()=>t});assert.equal(b.allow(),true);t=99;assert.equal(b.allow(),true);t=100;assert.equal(b.allow(),false);assert.equal(b.allow(),false);assert.equal(b.deferred,2);}
{const b=verifyBudget({});for(let i=0;i<1000;i++)assert.equal(b.allow(),true);assert.equal(b.deferred,0);assert.equal(b.limitMs,Infinity);}
{const b=verifyBudget({budgetMs:'bad'});assert.equal(b.limitMs,Infinity);}

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
  const out=await recover({root,now,verifyBudgetMs:20,clock:()=>t,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>{fetched.push(req.race);t+=10;return individual(Number(req.race));}});
  assert.equal(out.settled,2);assert.equal(out.deferred,4);assert.equal(fetched.length,2);
  const after=read(file),done=Object.values(after).filter(r=>r.settled);
  assert.equal(done.length,2);for(const r of done)assert.equal(r.modes.hit.payout,(1000+Number(r.race)));
  for(const [k,r] of Object.entries(after))if(!r.settled)assert.deepEqual(r,before[k]);
  // 2) Next run continues from where it stopped and finishes the backlog.
  t=0;fetched=[];
  const out2=await recover({root,now,verifyBudgetMs:20,clock:()=>t,fetchPage:async()=>payHtml(races),fetchIndividual:async req=>{fetched.push(req.race);t+=10;return individual(Number(req.race));}});
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
console.log('Verification time budget OK: partial progress saved, rest pending and untouched, next run continues, per-race fetch failure isolated, pay page failure still fatal');
