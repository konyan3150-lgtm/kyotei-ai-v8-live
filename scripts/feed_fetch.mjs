import {setTimeout as delay} from 'node:timers/promises';

export async function fetchFeed(url,{type='json',required=true,timeoutMs=15000,attempts=2,retryDelayMs=250}={}) {
  let lastError;
  for(let attempt=0;attempt<attempts;attempt++) {
    try {
      const response=await fetch(url,{headers:{'user-agent':'kyotei-v8-server-predictions'},signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok) throw Error(`HTTP ${response.status}`);
      return type==='text'?await response.text():await response.json();
    } catch(error) { lastError=error; if(attempt+1<attempts)await delay(retryDelayMs); }
  }
  const message=`Feed failed after ${attempts} attempts: ${url}: ${lastError?.message}`;
  if(required) throw new Error(message,{cause:lastError});
  console.warn(message);
  return type==='text'?'':null;
}
