// Test-only official page fixtures that pass the real parsers (parseOfficialPayPage / parseOfficialResult).
const spans=order=>order.map(n=>`<span class="numberSet1_number is-type${n}">${n}</span>`).join('');
const yen=n=>`&yen;${Number(n).toLocaleString('en-US')}`;
export function payHtml(date,entries){
  return entries.map(({stadium,race,order,amount})=>`<td data-href="/owpc/pc/race/raceresult?rno=${Number(race)}&amp;jcd=${String(Number(stadium)).padStart(2,'0')}&amp;hd=${date}">${spans(order)}</td><td><span class="is-payout1">${yen(amount)}</span></td>`).join('');
}
export function individualHtml({date,stadium,race,order,amount,refundBoats=[]}){
  const sid=String(Number(stadium)).padStart(2,'0'),rank=new Map(order.map((lane,i)=>[lane,i+1]));let next=4;
  for(const lane of [1,2,3,4,5,6])if(!rank.has(lane))rank.set(lane,next++);
  const rows=[...rank].sort((a,b)=>a[1]-b[1]).map(([lane,place])=>`<tr><td>${place}</td><td>${lane}</td><td><span>${4000+lane}</span></td><td>1'50"0</td></tr>`).join('');
  return `<div class="tab3 is-type1"><ul><li><a href="/owpc/pc/race/racelist?rno=${Number(race)}&amp;jcd=${sid}&amp;hd=${date}">出走表</a></li><li>結果</li></ul></div>
<table><thead><tr><th>着</th><th>枠</th><th>ボートレーサー</th><th>レースタイム</th></tr></thead><tbody>${rows}</tbody></table>
<table><thead><tr><th>返還</th></tr></thead><tbody><tr><td><div class="numberSet1">${spans(refundBoats)}</div></td></tr></tbody></table>
<table><thead><tr><th>勝式</th><th>組番</th><th>払戻金</th></tr></thead><tbody><tr><td>3連単</td><td>${spans(order)}</td><td><span class="is-payout1">${yen(amount)}</span></td></tr></tbody></table>`;
}
