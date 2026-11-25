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
  const res=await fetch(endpoint+'?since='+since+'&limit=10000',{headers:{authorization:'Bearer '+secret}});
  const text=await res.text();let body;try{body=JSON.parse(text);}catch{fail('Worker returned non-JSON HTTP '+res.status);}
  if(!res.ok||body.ok!==true||!Array.isArray(body.buys)||Number(body.returned)!==body.buys.length)fail('Buy-event export failed or response count mismatch: HTTP '+res.status+' '+text.slice(0,500));
  const file=path.join(ROOT,'smart_wallet_buys.json');
  await fs.writeFile(file,JSON.stringify({version:1,exported_at:new Date().toISOString(),since,buys:body.buys},null,2)+'\n');
  console.log(JSON.stringify({ok:true,exported:body.buys.length,file:'smart_wallet_buys.json',since},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error('[wallet buy sync]',e.message);process.exitCode=1;});
