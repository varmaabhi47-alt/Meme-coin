#!/usr/bin/env node
/**
 * Reconcile the one Helius transaction webhook with smart_wallets.json.
 * Calls only the webhook management API; never calls Enhanced Transactions/Wallet API.
 */
import fs from 'node:fs/promises';
const file=new URL('./smart_wallets.json',import.meta.url);
const apiKey=process.env.HELIUS_API_KEY||'';
const webhookUrl=process.env.HELIUS_WEBHOOK_URL||'';
const forcedId=process.env.HELIUS_WEBHOOK_ID||'';
const dry=process.argv.includes('--dry-run');
const base='https://api.helius.xyz/v0/webhooks';
function fail(msg){throw new Error(msg);}
async function request(url,method='GET',body){
  const res=await fetch(url,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const txt=await res.text();let data;try{data=JSON.parse(txt);}catch{fail('Helius webhook API returned non-JSON HTTP '+res.status);}
  if(!res.ok)fail('Helius webhook API HTTP '+res.status+': '+JSON.stringify(data).slice(0,700));
  return data;
}
const sort=a=>[...new Set(a)].sort();
async function main(){
  if(!apiKey)fail('HELIUS_API_KEY is required.');
  if(!webhookUrl||!webhookUrl.startsWith('https://'))fail('HELIUS_WEBHOOK_URL must be the HTTPS Cloudflare Worker /webhook/helius endpoint.');
  const doc=JSON.parse(await fs.readFile(file,'utf8'));
  const active=sort((doc.wallets||[]).filter(w=>w.status==='ACTIVE').map(w=>w.address));
  if(active.some(a=>typeof a!=='string'||a.length<32||a.length>44))fail('smart_wallets.json contains an invalid active address.');
  const listed=await request(base+'?api-key='+encodeURIComponent(apiKey));
  if(!Array.isArray(listed))fail('Webhook list response was not an array.');
  let hook=forcedId?listed.find(x=>String(x.webhookID||x.webhookId||x.id)===forcedId):listed.find(x=>x.webhookURL===webhookUrl);
  const payload={webhookURL:webhookUrl,accountAddresses:active,transactionTypes:['SWAP'],webhookType:'enhanced',authHeader:process.env.HELIUS_WEBHOOK_AUTH||''};
  if(dry){console.log(JSON.stringify({mode:'dry-run',managementApiCalls:1,webhookExists:!!hook,action:hook?'PUT':'POST',activeWallets:active.length,addresses:active,usesEnhancedTransactionEndpoint:false,note:'Webhook management only; does not call Enhanced Transactions or Wallet API.'},null,2));return;}
  if(hook){const id=hook.webhookID||hook.webhookId||hook.id;if(!id)fail('Matched webhook has no ID. Set HELIUS_WEBHOOK_ID after inspecting list response.');const result=await request(base+'/'+encodeURIComponent(id)+'?api-key='+encodeURIComponent(apiKey),'PUT',payload);console.log(JSON.stringify({action:'updated',webhookId:id,activeWallets:active.length,result},null,2));}
  else{const result=await request(base+'?api-key='+encodeURIComponent(apiKey),'POST',payload);console.log(JSON.stringify({action:'created',activeWallets:active.length,result},null,2));}
}
main().catch(e=>{console.error('[webhook sync]',e.message);process.exitCode=1;});
