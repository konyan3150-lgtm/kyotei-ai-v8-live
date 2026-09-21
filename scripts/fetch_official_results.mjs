import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const jstDay=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).replaceAll('-','');
const strip=s=>String(s||'').replace(/<[^>]+>/g,'').replace(/&nbsp;|&#160;/gi,' ').replace(/&yen;|&#165;/gi,'¥').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();

export function parseOfficialPayPage(html,date=jstDay()){
  const races={},cells=[...String(html||'').matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map(m=>({attrs:m[1],body:m[2]}));
  for(let i=0;i<cells.length;i++){
    const hrefMatch=cells[i].attrs.match(/data-href="([^"]+)"/i);if(!hrefMatch)continue;
    const href=hrefMatch[1].replaceAll('&amp;','&'),params=new URLSearchParams(href.split('?')[1]||''),stadium=String(Number(params.get('jcd'))),race=String(Number(params.get('rno')));
    if(!stadium||stadium==='NaN'||!race||race==='NaN')continue;
    const resultHtml=cells[i].body,resultText=strip(resultHtml);if(!/numberSet1|中止/.test(resultHtml))continue;
    if(/中止/.test(resultText)){(races[stadium]??={})[race]={cancelled:true};continue}
    const numbers=[...resultHtml.matchAll(/numberSet1_number[^"']*?\bis-type([1-6])\b/gi)].map(x=>x[1]).slice(0,3),amount=Number(strip(cells[i+1]?.body).replace(/\D/g,''));
    if(numbers.length===3&&amount>0)(races[stadium]??={})[race]={combination:numbers.join('-'),amount};
  }
  const resultCount=Object.values(races).reduce((n,x)=>n+Object.keys(x).length,0);
  return{schema:'kyotei-v8-official-results-v1',date,updated_at:new Date().toISOString(),source:'BOAT RACE official pay page',result_count:resultCount,races};
}

export async function run({now=new Date(),html=null}={}){
  const date=jstDay(now),url=`https://www.boatrace.jp/owpc/pc/race/pay?hd=${date}`;
  if(html==null){const res=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; kyotei-v8-results/1.0)','accept':'text/html'},signal:AbortSignal.timeout(45000)});if(!res.ok)throw Error(`official pay page HTTP ${res.status}`);html=await res.text()}
  if(String(html).length<10000)throw Error('official pay page unavailable');
  const payload=parseOfficialPayPage(html,date);if(!payload.result_count)throw Error('official pay page contained no results');
  fs.writeFileSync(path.join(ROOT,'dev/official-results.json'),JSON.stringify(payload)+'\n');
  console.log(`official results=${payload.result_count}`);return payload
}

async function selfTest(){
  const html='<td class="is-borderLeft1 cellbg" data-href="/x?rno=1&amp;jcd=05&amp;hd=20260921"><span class="numberSet1_number is-type1">1</span><span class="numberSet1_number is-type3">3</span><span class="numberSet1_number is-type6">6</span></td><td><span>&yen;4,390</span></td><td>18</td><td class="is-borderLeft1 cellbg" data-href="/x?rno=2&amp;jcd=02&amp;hd=20260921"><span>レース中止</span></td><td>&nbsp;</td>';
  const p=parseOfficialPayPage(html,'20260921');if(p.result_count!==2||p.races['5']['1'].combination!=='1-3-6'||p.races['5']['1'].amount!==4390||!p.races['2']['2'].cancelled)throw Error('official result parser self-test failed');console.log('official result parser self-test OK')
}
if(import.meta.url===`file://${process.argv[1]}`){if(process.argv.includes('--self-test'))await selfTest();else await run()}
