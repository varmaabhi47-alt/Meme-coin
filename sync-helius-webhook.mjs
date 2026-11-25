#!/usr/bin/env node
/**
 * Reconcile one Helius transaction webhook and mirror curated wallet metadata to Worker D1.
 * Uses only Helius webhook-management APIs; no enhanced transaction or wallet-history API calls.
 */
import fs from 'node:fs/promises';
const file=new URL('./smart_wallets.json',import.meta.url);
const apiKey=process.env.HELIUS_API_KEY||'',webhookUrl=process.env.HELIUS_WEBHOOK_URL||'',forcedId=process.env.HELIUS_WEBHOOK_ID||'';
const authHeader=process.env.HELIUS_WEBHOOK_AUTH||'',workerSecret=process.env.BOT_SYNC_SECRET||'';
const dry=process.argv.includes('--dry-run'),base='https://api.helius.xyz/v0/webhooks';
function fail(m){throw new Error(m);}
async function request(url,method='GET',body){
  const res=await fetch(url,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const txt=await res.text();let data;try{data=JSON.parse(txt);}catch{fail('Helius webhook API returned non-JSON HTTP '+res.status);}
  if(!res.ok)fail('Helius webhook API HTTP '+res.status+': '+JSON.stringify(data).slice(0,700));
  return data;
}
const sort=a=>[...new Set(a)].sort();
async function main(){
  if(!apiKey)fail('HELIUS_API_KEY is required.');
  if(!webhookUrl.startsWith('https://')||!webhookUrl.endsWith('/webhook/helius'))fail('HELIUS_WEBHOOK_URL must be the HTTPS Worker /webhook/helius endpoint.');
  if(!authHeader)fail('HELIUS_WEBHOOK_AUTH must equal the Cloudflare HELIUS_WEBHOOK_SECRET secret.');
  if(!workerSecret)fail('BOT_SYNC_SECRET is required to sync wallet metadata to Worker D1.');
  const doc=JSON.parse(await fs.readFile(file,'utf8')),active=sort((doc.wallets||[]).filter(w=>w.status==='ACTIVE').map(w=>w.address));
  if(active.length>50)fail('ACTIVE wallet cap exceeded (50).');
  if(active.some(a=>typeof a!=='string'||a.length<32||a.length>44))fail('smart_wallets.json has an invalid ACTIVE address.');
  const listed=await request(base+'?api-key='+encodeURIComponent(apiKey));if(!Array.isArray(listed))fail('Webhook list response was not an array.');
  const hook=forcedId?listed.find(x=>String(x.webhookID||x.webhookId||x.id)===forcedId):listed.find(x=>x.webhookURL===webhookUrl);
  const payload={webhookURL:webhookUrl,accountAddresses:active,transactionTypes:['SWAP'],webhookType:'enhanced',authHeader};
  const workerEndpoint=webhookUrl.slice(0,-'/webhook/helius'.length)+'/smart-wallets';
  const walletMetadata=(doc.wallets||[]).map(w=>({address:w.address,label:w.label||'',status:w.status||'WATCH',median_buy_sol:Number(w.median_buy_sol||0),confidence_score:Number(w.confidence_score||0),correlation_group:w.correlation_group||''}));
  if(dry){console.log(JSON.stringify({mode:'dry-run',managementCalls:1,plannedAction:hook?'PUT':'POST',activeWallets:active.length,workerMetadataSync:'would POST '+walletMetadata.length+' records',usesEnhancedTransactionsApi:false,creditEstimate:'No wallet-history polling; webhook delivery credit policy is provider-side.'},null,2));return;}
  let result;if(hook){const id=hook.webhookID||hook.webhookId||hook.id;if(!id)fail('Matched webhook lacks ID; set HELIUS_WEBHOOK_ID.');result=await request(base+'/'+encodeURIComponent(id)+'?api-key='+encodeURIComponent(apiKey),'PUT',payload);console.log(JSON.stringify({action:'updated',webhookId:id,activeWallets:active.length,result},null,2));}
  else{result=await request(base+'?api-key='+encodeURIComponent(apiKey),'POST',payload);console.log(JSON.stringify({action:'created',activeWallets:active.length,result},null,2));}
  const sync=await fetch(workerEndpoint,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+workerSecret},body:JSON.stringify({wallets:walletMetadata})});
  const syncText=await sync.text();if(!sync.ok)fail('Worker /smart-wallets sync HTTP '+sync.status+': '+syncText.slice(0,500));
  console.log(JSON.stringify({workerMetadataSync:'ok',metadataWallets:walletMetadata.length},null,2));
}
main().catch(e=>{console.error('[webhook sync]',e.message);process.exitCode=1;});
