const MODES=['hit','balance','return'];
const LABELS={normal:'通常',inside:'イン逃げ',upset:'イン崩れ・穴',exhibition:'展示変化',water:'水面'};

function emptyGroup(label=''){
  return {label,saved:0,settled:0,inside_wins:0,modes:Object.fromEntries(MODES.map(mode=>[mode,{races:0,hits:0,invest:0,payout:0}])),value_modes:Object.fromEntries(MODES.map(mode=>[mode,{races:0,hits:0,invest:0,payout:0}]))};
}

function add(group,rec){
  group.saved++;
  if(!rec.expert_result)return;
  group.settled++;
  if(rec.expert_result.inside_won)group.inside_wins++;
  for(const kind of ['modes','value_modes'])for(const mode of MODES){
    const m=rec.expert_result[kind]?.[mode];
    if(!m||!Number(m.stake))continue;
    const row=group[kind][mode];row.races++;if(m.hit)row.hits++;
    row.invest+=Number(m.stake||0);row.payout+=Number(m.payout||0);
  }
}

export function summarizeExperts(records){
  const cohorts={live:emptyGroup('締切前保存'),reconstructed:{full:emptyGroup('過去復元・情報充足'),partial:emptyGroup('過去復元・一部欠損'),basic:emptyGroup('過去復元・基礎のみ')}};
  const by_active=Object.fromEntries(Object.entries(LABELS).map(([key,label])=>[key,emptyGroup(label)]));
  let saved=0,settled=0,reconstructed=0;
  for(const rec of records){
    const snap=rec?.expert_snapshot;if(!snap?.active)continue;
    saved++;if(rec.expert_result)settled++;
    const row=by_active[snap.active]||(by_active[snap.active]=emptyGroup(snap.label||snap.active));
    add(row,rec);
    if(snap.reconstructed){
      reconstructed++;row.reconstructed=(row.reconstructed||0)+1;
      const quality=['full','partial','basic'].includes(snap.reconstruction_quality)?snap.reconstruction_quality:'basic';
      add(cohorts.reconstructed[quality],rec);
    }else add(cohorts.live,rec);
  }
  for(const row of Object.values(by_active))row.reconstructed ||=0;
  return {version:2,saved,settled,reconstructed,live:saved-reconstructed,by_active,cohorts};
}
