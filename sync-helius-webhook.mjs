#!/usr/bin/env node
/**
 * Reconcile a single Helius transaction webhook with smart_wallets.json.
 * Only webhook management endpoints are used; no Enhanced Transactions/Wallet API calls.
 */
import fs from 'node:fs/promises';
const file=new URL('./smart_wallets.json',import.meta.url);
const apiKey=process.env.HELIUS_API_KEY||'',webhookUrl=process.env.HELIUS_WEBHOOK_URL||'',forcedId=process.env.HELIUS_WEBHOOK_ID||'';
const authHeader=process.env.HELIUS_WEBHOOK_AUTH||'',dry=process.argv.includes('--dry-run'),base='https://api.helius.xyz/v0/webhooks';
function fail(m){throw new Error(m);}
async function request(url,method='GET',body){
  const res=await fetch(url,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const txt=await res.text();let data;try{data=JSON.parse(txt);}catch{fail('Helius webhook API returned non-JSON HTTP '+res.status);}
  if(!res.ok)fail('Helius webhook API HTTP '+res.status+': '+JSON.stringify(data).slice(0,700));return data;
}
const sort=a=>[...new Set(a)].sort();
async function main(){
  if(!apiKey)fail('HELIUS_API_KEY is required.');
  if(!webhookUrl.startsWith('https://'))fail('HELIUS_WEBHOOK_URL must be an HTTPS Worker /webhook/helius URL.');
  if(!authHeader)fail('HELIUS_WEBHOOK_AUTH must equal the Cloudflare HELIUS_WEBHOOK_SECRET secret; set both explicitly.');
  const doc=JSON.parse(await fs.readFile(file,'utf8')),active=sort((doc.wallets||[]).filter(w=>w.status==='ACTIVE').map(w=>w.address));
  if(active.length>50)fail('ACTIVE wallet cap exceeded (50).');
  if(active.some(a=>typeof a!=='string'||a.length<32||a.length>44))fail('smart_wallets.json has an invalid ACTIVE address.');
  const listed=await request(base+'?api-key='+encodeURIComponent(apiKey));if(!Array.isArray(listed))fail('Webhook list response was not an array.');
  const hook=forcedId?listed.find(x=>String(x.webhookID||x.webhookId||x.id)===forcedId):listed.find(x=>x.webhookURL===webhookUrl);
  const payload={webhookURL:webhookUrl,accountAddresses:active,transactionTypes:['SWAP'],webhookType:'enhanced',authHeader};
  if(dry){console.log(JSON.stringify({mode:'dry-run',managementCalls:1,webhookExists:!!hook,plannedAction:hook?'PUT':'POST',activeWallets:active.length,usesEnhancedTransactionsApi:false,creditEstimate:'Webhook delivery credit policy is provider-side; this script does not poll wallet history.'},null,2));return;}
  if(hook){const id=hook.webhookID||hook.webhookId||hook.id;if(!id)fail('Matched webhook lacks ID; set HELIUS_WEBHOOK_ID.');const result=await request(base+'/'+encodeURIComponent(id)+'?api-key='+encodeURIComponent(apiKey),'PUT',payload);console.log(JSON.stringify({action:'updated',webhookId:id,activeWallets:active.length,result},null,2));}
  else{const result=await request(base+'?api-key='+encodeURIComponent(apiKey),'POST',payload);console.log(JSON.stringify({action:'created',activeWallets:active.length,result},null,2));}
}
main().catch(e=>{console.error('[webhook sync]',e.message);process.exitCode=1;});
