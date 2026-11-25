#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
function fail(message){throw new Error(message);}
async function main(){
  const webhookUrl=process.env.HELIUS_WEBHOOK_URL||'',secret=process.env.BOT_SYNC_SECRET||'',dry=process.argv.includes('--dry-run');
  if(!webhookUrl.startsWith('https://')||!webhookUrl.endsWith('/webhook/helius'))fail('HELIUS_WEBHOOK_URL must be the HTTPS Worker /webhook/helius endpoint.');
  if(!secret)fail('BOT_SYNC_SECRET is required.');
  const endpoint=webhookUrl.slice(0,-'/webhook/helius'.length)+'/smart-wallet-buys';
  const since=Date.now()-30*24*60*60*1000;
  if(dry){console.log(JSON.stringify({mode:'dry-run',endpoint,since,willWrite:false,expectedSource:'Cloudflare D1 smart_wallet_buys'},null,2));return;}
  const buys=[];let offset=0,page=0,hasMore=true;
  while(hasMore){
    if(page++>=100)fail('Buy-event export exceeded 1,000,000 rows; narrow the since window and retry.');
    const res=await fetch(endpoint+'?since='+since+'&limit=10000&offset='+offset,{headers:{authorization:'Bearer '+secret}});
    const text=await res.text();let body;try{body=JSON.parse(text);}catch{fail('Worker returned non-JSON HTTP '+res.status);}
    if(!res.ok||body.ok!==true||!Array.isArray(body.buys)||Number(body.returned)!==body.buys.length||Number(body.offset)!==offset)fail('Buy-event export failed or response count/cursor mismatch: HTTP '+res.status+' '+text.slice(0,500));
    buys.push(...body.buys);hasMore=body.hasMore===true;
    if(hasMore){const next=Number(body.nextOffset);if(!Number.isSafeInteger(next)||next<=offset)fail('Worker export returned an invalid nextOffset.');offset=next;}
  }
  const unique=new Map();for(const row of buys){const id=String(row.wallet)+'|'+String(row.signature)+'|'+String(row.mint);unique.set(id,row);}
  const exported=[...unique.values()],file=path.join(ROOT,'smart_wallet_buys.json');
  await fs.writeFile(file,JSON.stringify({version:1,exported_at:new Date().toISOString(),since,buys:exported},null,2)+'\n');
  console.log(JSON.stringify({ok:true,exported:exported.length,pages:page,file:'smart_wallet_buys.json',since},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error('[wallet buy sync]',e.message);process.exitCode=1;});
