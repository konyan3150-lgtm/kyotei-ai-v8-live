import crypto from 'node:crypto';
export function aptitudeHistoryEnd(data,date){
  const end=String(data?.history_end||'').replaceAll('-','');
  if(!/^\d{8}$/.test(end)||end>=date)throw Error('Aptitude history must end before race date');
  return end;
}
export const modelHash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function saveProof({savedAt,closedAt,date,historyEnd,modelSha}){
  const saved=Date.parse(savedAt),close=Date.parse(closedAt);
  if(!Number.isFinite(saved)||!Number.isFinite(close))return null;
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(saved)).replaceAll('-','');
  if(!Number.isFinite(saved)||!Number.isFinite(close)||saved>=close-60000||day!==date)return null;
  if(!/^\d{8}$/.test(historyEnd)||historyEnd>=date||!/^[a-f0-9]{64}$/.test(modelSha))throw Error('Invalid save provenance');
  return {saved_at:new Date(saved).toISOString(),closed_at:new Date(close).toISOString(),model_sha256:modelSha,aptitude_history_end:historyEnd,provenance:'verified_at_save'};
}
