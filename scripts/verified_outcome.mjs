import crypto from 'node:crypto';
import {parseOfficialResult} from './official_result_parser.mjs';
import {checkedOutcome} from './checked_outcome.mjs';
import {fetchFeed} from './feed_fetch.mjs';

export async function verifyIndividualResult(request,published,{fetchIndividual}={}){
  const url=`https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${Number(request.race)}&jcd=${String(Number(request.stadium)).padStart(2,'0')}&hd=${request.date}`;
  const html=await (fetchIndividual?fetchIndividual(request):fetchFeed(url,{type:'text'}));
  let result;
  try{result=parseOfficialResult(html,request);}catch(error){console.warn(`Official result held pending ${request.date}/${request.stadium}/${request.race}: ${error.message}`);return {pending:true,reason:error.message};}
  const verification={request:{...request},url,fetched_at:new Date().toISOString(),html_sha256:crypto.createHash('sha256').update(html).digest('hex')};
  const outcome=checkedOutcome(result);
  if(outcome.exclude)return {excluded:{confirmed:true,reason:outcome.reason,kind:result.special_payout?'special_payout':result.refund_boats.length?'refund':'nonstandard_result',refund_boats:result.refund_boats},verification};
  if(!outcome.eligible)return {pending:true,reason:outcome.reason||'incomplete_official_result'};
  if(String(published?.combination)!==outcome.combo||Number(published?.amount)!==outcome.amount){console.warn(`Official/published payout mismatch ${request.date}/${request.stadium}/${request.race}`);return {pending:true,reason:'published_payout_mismatch'};}
  return {combination:outcome.combo,amount:outcome.amount,verification};
}
