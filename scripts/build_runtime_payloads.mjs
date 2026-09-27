import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const JST_DATE=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const PROGRAM_URL=process.env.PROGRAM_URL||`https://boatraceopenapi.github.io/api/v1/${JST_DATE.slice(0,4)}/${JST_DATE}.json`;

function readJson(file){return JSON.parse(fs.readFileSync(path.join(ROOT,file),'utf8'))}
function writeJson(file,data){const target=path.join(ROOT,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(data))}

const response=await fetch(PROGRAM_URL,{headers:{'user-agent':'kyotei-ai-v8-runtime-payload/1.0'}});
if(!response.ok)throw new Error(`program HTTP ${response.status}`);
const program=await response.json();
const ids=new Set();
for(const stadium of Object.values(program?.programs?.stadiums||{}))for(const race of Object.values(stadium?.races||{}))for(const racer of Object.values(race?.racers||{})){
  const id=String(racer?.number||racer?.registration_number||'').trim();
  if(id)ids.add(id);
}
if(ids.size<100)throw new Error(`program racer coverage too low: ${ids.size}`);

const aptitude=readJson('racer-aptitude.json'),aptitudeRacers={};
for(const id of ids)if(aptitude.racers?.[id])aptitudeRacers[id]=aptitude.racers[id];
const aptitudeRuntime={...aptitude,racers:aptitudeRacers,runtime:{date:JST_DATE,target_count:ids.size,available_count:Object.keys(aptitudeRacers).length,generated_at:new Date().toISOString()}};
const aptitudeText=JSON.stringify(aptitudeRuntime);
const aptitudeGzip=gzipSync(Buffer.from(aptitudeText),{level:9});
const aptitudeTarget=path.join(ROOT,'dev/racer-aptitude-runtime.json.gz');
fs.mkdirSync(path.dirname(aptitudeTarget),{recursive:true});
fs.writeFileSync(aptitudeTarget,aptitudeGzip);

const course=readJson('course-stats.json'),courseRacers={};
for(const id of ids)if(course.racers?.[id])courseRacers[id]=course.racers[id];
writeJson('dev/course-stats-runtime.json',{...course,racers:courseRacers,runtime:{date:JST_DATE,target_count:ids.size,available_count:Object.keys(courseRacers).length,generated_at:new Date().toISOString()}});

console.log(JSON.stringify({date:JST_DATE,target:ids.size,aptitude:Object.keys(aptitudeRacers).length,aptitude_bytes:aptitudeGzip.length,course:Object.keys(courseRacers).length}));
