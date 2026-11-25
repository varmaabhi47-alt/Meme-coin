#!/usr/bin/env node
/**
 * MEME.RADAR V6 Smart Wallet Curator.
 * Uses only standard Solana RPC methods (getSignaturesForAddress/getTransaction).
 * Unknown/unsupported trade accounting is rejected; never fabricate metrics.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeFundingLinks } from './funding-link-detection.mjs';
import { summarizeWalletOutcomes } from './curator-outcomes.mjs';
import { reconstructSolSwap } from './swap-reconstruction.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const RPC=process.env.SOLANA_RPC_URL||process.env.HELIUS_RPC_URL||'https://api.mainnet-beta.solana.com';
const KEY=process.env.HELIUS_API_KEY||'';
const RPC_URL=(()=>{if(!KEY||!/helius/i.test(RPC))return RPC;const url=new URL(RPC);url.searchParams.set('api-key',KEY);return url.toString();})();
const WALLETS=path.join(ROOT,'smart_wallets.json');
const QUEUE=path.join(ROOT,'candidate_wallets.json');
const USAGE=path.join(ROOT,'rpc-curator-usage.json');
const DAY=86400, LOOKBACK=30*DAY;
const MAX_RPS=Math.min(6,Math.max(1,Number(process.env.RPC_MAX_RPS||6)));
const MONTHLY_LIMIT=1_000_000;
const DEX_PROGRAMS=new Set([
 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
 '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
 '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const iso=ms=>new Date(ms).toISOString();
const readJson=async(p,fb)=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch{return fb;}};
const writeJson=async(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n');
function monthKey(){const d=new Date();return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');}
let lastReq=0, rpcId=0;
async function rpc(method,params){
  const usage=await readJson(USAGE,{month:monthKey(),credits:0,requests:0});
  if(usage.month!==monthKey()){usage.month=monthKey();usage.credits=0;usage.requests=0;usage.byMethod={};usage.httpRequests=0;}
  if(usage.credits>=MONTHLY_LIMIT)throw new Error('RPC monthly credit budget exhausted; refusing further calls.');
  const wait=Math.max(0,Math.ceil(1000/MAX_RPS)-(Date.now()-lastReq));if(wait)await sleep(wait);
  let attempt=0;
  while(true){
    lastReq=Date.now();
    const res=await fetch(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});
    if(res.status===429){if(attempt++>=7)throw new Error('RPC 429 persisted after exponential backoff');const retry=Number(res.headers.get('retry-after'));await sleep((Number.isFinite(retry)&&retry>0?retry*1000:Math.min(60000,1000*2**attempt))+Math.floor(Math.random()*500));continue;}
    const raw=await res.text();let body;try{body=JSON.parse(raw);}catch{throw new Error('RPC returned non-JSON HTTP '+res.status);}
    usage.credits++;usage.requests++;usage.httpRequests=(usage.httpRequests||0)+1;usage.byMethod=usage.byMethod||{};usage.byMethod[method]=(usage.byMethod[method]||0)+1;await writeJson(USAGE,usage);
    if(!res.ok||body.error)throw new Error('RPC '+method+' failed HTTP '+res.status+': '+JSON.stringify(body.error||body).slice(0,500));
    if(!Object.hasOwn(body,'result'))throw new Error('RPC '+method+' response missing result');
    return body.result;
  }
}
const RPC_BATCH_SIZE=25;
async function rpcBatch(method,paramsList){
  const results=[];
  for(let offset=0;offset<paramsList.length;offset+=RPC_BATCH_SIZE){
    const params=paramsList.slice(offset,offset+RPC_BATCH_SIZE),usage=await readJson(USAGE,{month:monthKey(),credits:0,requests:0});
    if(usage.month!==monthKey()){usage.month=monthKey();usage.credits=0;usage.requests=0;usage.byMethod={};usage.httpRequests=0;}
    if(usage.credits+params.length>MONTHLY_LIMIT)throw new Error('RPC monthly credit budget would be exceeded by batch; refusing calls.');
    const wait=Math.max(0,Math.ceil(1000/MAX_RPS)-(Date.now()-lastReq));if(wait)await sleep(wait);
    const requests=params.map(p=>({jsonrpc:'2.0',id:++rpcId,method,params:p})),ids=requests.map(x=>x.id);
    let attempt=0,body;
    while(true){
      lastReq=Date.now();
      const res=await fetch(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requests)});
      if(res.status===429){if(attempt++>=7)throw new Error('RPC batch 429 persisted after exponential backoff');const retry=Number(res.headers.get('retry-after'));await sleep((Number.isFinite(retry)&&retry>0?retry*1000:Math.min(60000,1000*2**attempt))+Math.floor(Math.random()*500));continue;}
      const raw=await res.text();try{body=JSON.parse(raw);}catch{throw new Error('RPC provider rejected JSON-RPC batch request (non-JSON HTTP '+res.status+').');}
      if(!res.ok)throw new Error('RPC batch failed HTTP '+res.status+': '+JSON.stringify(body).slice(0,500));
      break;
    }
    if(!Array.isArray(body))throw new Error('RPC provider rejected JSON-RPC batch request (response was not an array).');
    usage.credits+=requests.length;usage.requests+=requests.length;usage.httpRequests=(usage.httpRequests||0)+1;usage.byMethod=usage.byMethod||{};usage.byMethod[method]=(usage.byMethod[method]||0)+requests.length;await writeJson(USAGE,usage);
    const byId=new Map(body.map(item=>[item.id,item]));
    for(const id of ids){const item=byId.get(id);if(!item){results.push({error:{message:'batch response omitted request id '+id}});continue;}results.push(Object.hasOwn(item,'error')?{error:item.error}:item.result);}
  }
  return results;
}
async function transactionsBySignatures(signatures,encoding='json'){
  const params=signatures.map(signature=>[signature,{encoding,maxSupportedTransactionVersion:1,commitment:'confirmed'}]);
  try{return await rpcBatch('getTransaction',params);}
  catch(error){
    if(!String(error.message).includes('rejected JSON-RPC batch'))throw error;
    const rows=[];for(const p of params){try{rows.push(await rpc('getTransaction',p));}catch(e){rows.push({error:{message:String(e.message)}});}}
    return rows;
  }
}
function parseCsvLine(line){const out=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(ch===','&&!quoted){out.push(value.trim());value='';}else value+=ch;}out.push(value.trim());return out;}
async function importCandidates(file){
  const txt=await fs.readFile(file,'utf8'), out=[];
  if(file.endsWith('.json')){const j=JSON.parse(txt);for(const x of Array.isArray(j)?j:(j.wallets||j.candidates||[])){const a=typeof x==='string'?x:x.address;if(a)out.push({address:a,label:typeof x==='object'?(x.label||'imported'):'imported',source:'manual-import'});}}
  else for(const line of txt.split(/\r?\n/)){if(!line.trim()||line.trim().startsWith('#'))continue;const [address,label]=parseCsvLine(line);if(address&&address!=='address')out.push({address,label:label||'imported',source:'manual-import'});}
  return out;
}
function validAddress(a){return typeof a==='string'&&a.length>=32&&a.length<=44&&/^[1-9A-HJ-NP-Za-km-z]+$/.test(a);}
function resolvedKeys(tx){
  const msg=tx?.transaction?.message||tx?.message;
  if(!msg)throw new Error('transaction message missing');
  const stat=msg.staticAccountKeys||msg.accountKeys||[];
  const keys=stat.map(k=>typeof k==='string'?k:k.pubkey);
  const lookups=msg.addressTableLookups||[];
  const loaded=tx.meta?.loadedAddresses;
  // A v0 message with lookups is not safely decodable unless RPC supplied the
  // resolved addresses. Never guess lookup-table contents or account ordering.
  if(lookups.length&&!loaded)throw new Error('versioned transaction missing meta.loadedAddresses; skip metrics');
  const writable=(loaded?.writable||[]).map(k=>typeof k==='string'?k:k.pubkey);
  const readonly=(loaded?.readonly||[]).map(k=>typeof k==='string'?k:k.pubkey);
  const expectedWritable=lookups.reduce((n,x)=>n+(x.writableIndexes||[]).length,0);
  const expectedReadonly=lookups.reduce((n,x)=>n+(x.readonlyIndexes||[]).length,0);
  if(lookups.length&&(writable.length!==expectedWritable||readonly.length!==expectedReadonly))
    throw new Error('loaded ALT address count does not match message lookup indexes; skip metrics');
  return keys.concat(writable,readonly);
}
function instructionProgramIds(tx){
  const msg=tx?.transaction?.message||tx?.message;const keys=resolvedKeys(tx);
  return (msg.instructions||msg.compiledInstructions||[]).map(ix=>{
    if(ix.programId)return typeof ix.programId==='string'?ix.programId:ix.programId.toBase58?.();
    return keys[Number(ix.programIdIndex)];
  }).filter(Boolean);
}
function tokenDeltaByOwner(tx){
  const d=new Map(), meta=tx.meta||{};
  const apply=(arr,sign)=>{for(const b of arr||[]){const owner=b.owner,mint=b.mint;if(!owner||!mint)continue;const amount=Number(b.uiTokenAmount?.uiAmountString??b.uiTokenAmount?.uiAmount??0);const key=owner+'|'+mint;d.set(key,(d.get(key)||0)+sign*amount);}};
  apply(meta.preTokenBalances,-1);apply(meta.postTokenBalances,1);return d;
}
function solDeltaByAccount(tx){
  const meta=tx.meta||{},keys=resolvedKeys(tx),pre=meta.preBalances||[],post=meta.postBalances||[],d=new Map();
  for(let i=0;i<Math.min(keys.length,pre.length,post.length);i++)d.set(keys[i],(post[i]-pre[i])/1e9);
  // Balance deltas include the transaction fee. Restore it to the fee payer's
  // delta so trade notional is not understated on buys or sells.
  const fee=Number(meta.fee||0),payer=keys[0];
  if(Number.isFinite(fee)&&fee>0&&payer&&d.has(payer))d.set(payer,d.get(payer)+fee/1e9);
  return d;
}
function decodeSwap(tx,owner){
  const result=reconstructSolSwap(tx,owner);
  return result.swap?[result.swap]:[];
}
async function signatures(address,before,until){
  const all=[];let cursor;
  for(let page=0;page<10;page++){
    const p={limit:1000};if(cursor)p.before=cursor;if(until)p.until=until;
    const batch=await rpc('getSignaturesForAddress',[address,p]);if(!Array.isArray(batch))throw new Error('getSignaturesForAddress malformed result');
    all.push(...batch);if(batch.length<1000)break;cursor=batch.at(-1)?.signature;if(!cursor)break;
    if(batch.at(-1)?.blockTime&&batch.at(-1).blockTime<before)break;
  }return all.filter(s=>Number(s.blockTime||0)>=before&&!s.err);
}
async function txBySignature(signature){
  return rpc('getTransaction',[signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}]);
}
async function discoverFromMint(mint){
  if(!validAddress(mint))throw new Error('Invalid mint: '+mint);
  const sigs=await signatures(mint,Date.now()/1000-LOOKBACK),candidates=new Map();
  for(let offset=0;offset<sigs.length;offset+=RPC_BATCH_SIZE){
    const batch=sigs.slice(offset,offset+RPC_BATCH_SIZE),txs=await transactionsBySignatures(batch.map(s=>s.signature),'json');
    for(let i=0;i<batch.length;i++){const s=batch[i],tx=txs[i];if(!tx||tx.error)continue;
      try{resolvedKeys(tx);const deltas=tokenDeltaByOwner(tx);
        for(const [key,delta] of deltas){const [owner,token]=key.split('|');if(token===mint&&delta>0&&validAddress(owner))candidates.set(owner,{address:owner,label:'graduated-token-discovery',source:'winning-mint:'+mint,firstSeen:s.blockTime||0});}
      }catch{/* unresolved/unsupported transaction: no inferred candidate evidence */}
    }
  }return [...candidates.values()];
}
async function recentWalletSwaps(address,cutoff){
  const sigs=await signatures(address,cutoff),rows=[];
  for(let offset=0;offset<sigs.length;offset+=RPC_BATCH_SIZE){
    const batch=sigs.slice(offset,offset+RPC_BATCH_SIZE),txs=await transactionsBySignatures(batch.map(s=>s.signature),'json');
    for(let i=0;i<batch.length;i++){const s=batch[i],tx=txs[i];if(!tx||tx.error)continue;
      const msg=tx.transaction?.message;if((msg?.addressTableLookups?.length||0)>0&&!tx.meta?.loadedAddresses)continue;
      const swaps=decodeSwap(tx,address);for(const x of swaps){x.signature=s.signature;x.blockTime=Number(tx.blockTime||s.blockTime||0);rows.push(x);}
    }
  }return rows.sort((a,b)=>a.blockTime-b.blockTime);
}
function analyzeTrades(swaps){
  const open=new Map(),closed=[];
  for(const s of swaps){if(s.side==='BUY'){const q=open.get(s.mint)||[];q.push(s);open.set(s.mint,q);continue;}
    const q=open.get(s.mint);if(!q?.length)continue;
    // FIFO proportional lot closure. SOL amounts are actual wallet SOL deltas, including fees/tips.
    let remaining=s.tokenAmount,proceeds=s.solAmount,matchedCost=0,matchedTokens=0,weightedBuyTime=0,firstSlot=Infinity;
    while(remaining>1e-12&&q.length){const lot=q[0],take=Math.min(remaining,lot.tokenAmount),ratio=take/lot.tokenAmount;matchedCost+=lot.solAmount*ratio;matchedTokens+=take;weightedBuyTime+=Number(lot.blockTime||0)*take;firstSlot=Math.min(firstSlot,Number(lot.slot||Infinity));lot.tokenAmount-=take;lot.solAmount*=1-ratio;remaining-=take;if(lot.tokenAmount<=1e-12)q.shift();}
    if(matchedTokens>0){const sellMatched=s.tokenAmount?proceeds*(matchedTokens/s.tokenAmount):0;const buyTime=matchedTokens>0?weightedBuyTime/matchedTokens:s.blockTime;closed.push({mint:s.mint,buyTime,buySlot:firstSlot,sellTime:s.blockTime,sellSlot:Number(s.slot||0),holdMins:(s.blockTime-buyTime)/60,costSol:matchedCost,proceedsSol:sellMatched,pnlSol:sellMatched-matchedCost});}
  }return closed;
}
function median(a){if(!a.length)return null;const x=[...a].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function vetWallet(address,trades,swaps,{knownBad=new Set(),knownTracked=new Set()}={}){
  const reasons=[],now=Date.now()/1000,days7=swaps.filter(x=>x.blockTime>=now-7*DAY);
  if(knownBad.has(address))reasons.push('funding/deployer-linked');
  if(knownTracked.has(address))reasons.push('tracked-wallet-sybil-link');
  if(swaps.length<10)reasons.push('insufficient-swap-activity');
  if(!days7.length)reasons.push('inactive-7d');
  const wins=trades.filter(t=>t.pnlSol>0),losses=trades.filter(t=>t.pnlSol<0),pnl=trades.reduce((s,t)=>s+t.pnlSol,0);
  const winRate=trades.length?wins.length/trades.length*100:null;
  const grossWin=wins.reduce((s,t)=>s+t.pnlSol,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnlSol,0));
  const pf=grossLoss?grossWin/grossLoss:(grossWin>0?Infinity:null);
  const pnlByMint=new Map();for(const t of trades)pnlByMint.set(t.mint,(pnlByMint.get(t.mint)||0)+t.pnlSol);
  const profitableMints=new Set([...pnlByMint].filter(([,net])=>net>0).map(([mint])=>mint));
  const positiveMintPnl=[...pnlByMint.values()].filter(v=>v>0),positivePnlTotal=positiveMintPnl.reduce((a,b)=>a+b,0);
  const largest=positivePnlTotal>0?Math.max(0,...positiveMintPnl)/positivePnlTotal:1;
  const holds=trades.map(t=>t.holdMins).filter(Number.isFinite),medianHold=median(holds);
  const buySizes=swaps.filter(x=>x.side==='BUY').map(x=>x.solAmount),medianBuy=median(buySizes);
  if(profitableMints.size<5)reasons.push('less-than-5-net-profitable-tokens');
  if(largest>0.6)reasons.push('single-token-pnl-concentration');
  if(medianHold===null||medianHold<10)reasons.push('median-hold-under-10m');
  if(trades.some(t=>Number.isFinite(t.buySlot)&&Number.isFinite(t.sellSlot)&&Math.abs(t.sellSlot-t.buySlot)<=1&&t.holdMins<1))reasons.push('same-slot-or-next-slot-roundtrip');
  if(trades.length<10)reasons.push('less-than-10-closed-trades');
  if(medianBuy===null||medianBuy<0.25)reasons.push('median-buy-under-0.25-sol');
  if(winRate===null||winRate<45)reasons.push('win-rate-under-45pct');
  if(pf===null||pf<1.8)reasons.push('profit-factor-under-1.8');
  if(!Number.isFinite(pnl)||pnl<=0)reasons.push('non-positive-realized-pnl');
  const recent7=trades.filter(t=>t.sellTime>=now-7*DAY),win7=recent7.length?recent7.filter(t=>t.pnlSol>0).length/recent7.length*100:null,weightedWin=win7===null?(winRate||0):(win7*0.65+(winRate||0)*0.35);
  const confidence=Math.max(0,Math.min(100,Math.round(weightedWin*0.45+Math.min(3,pf||0)*12+Math.min(30,profitableMints.size)*0.8+(days7.length?8:0))));
  return {pass:reasons.length===0,reasons,metrics:{closedTrades:trades.length,profitableTokens:profitableMints.size,realizedWinRate30d:winRate,realizedWinRate7d:win7,profitFactor30d:Number.isFinite(pf)?pf:(pf===Infinity?'Infinity':null),medianHoldMins:medianHold,medianBuySol:medianBuy,largestTokenPnlShare:largest,realizedPnlSol:pnl,realizedPnl7dSol:recent7.reduce((s,t)=>s+t.pnlSol,0),confidenceScore:confidence,swaps30d:swaps.length,swaps7d:days7.length}};
}
async function findFundingSource(address){
  // Scan the earliest signatures available in the bounded 10k-signature window;
  // initial wallet funding often predates the 30-day trading lookback.
  const sigs=await signatures(address,0),oldest=sigs.filter(s=>s.blockTime).sort((a,b)=>a.blockTime-b.blockTime).slice(0,30);
  const txs=await transactionsBySignatures(oldest.map(s=>s.signature),'jsonParsed');
  for(let i=0;i<oldest.length;i++){const tx=txs[i];if(!tx?.meta||tx.meta.err||tx.error)continue;
    const msg=tx.transaction?.message,inner=(tx.meta.innerInstructions||[]).flatMap(x=>x.instructions||[]);
    for(const ix of [...(msg?.instructions||[]),...inner]){if(ix.program==='system'&&ix.parsed?.type==='transfer'){const info=ix.parsed.info;if(String(info.destination)===address&&String(info.source)!==address&&Number(info.lamports)>0)return String(info.source);}}
  }return null;
}
async function vetCandidate(c,{fundingSource=null,fundingLinked=false}={}){
  if(!validAddress(c.address))return {candidate:c,pass:false,reasons:['invalid-solana-address']};
  const cutoff=Date.now()/1000-LOOKBACK,swaps=await recentWalletSwaps(c.address,cutoff),trades=analyzeTrades(swaps);
  const result=vetWallet(c.address,trades,swaps,{knownBad:fundingLinked?new Set([c.address]):new Set()});
  if(fundingLinked&&!result.reasons.includes('funding/deployer-linked'))result.reasons.push('funding/deployer-linked');
  result.pass=result.reasons.length===0;
  return {...result,candidate:c,swaps,trades,fundingSource};
}
async function sourceResearchMints(file){
  const txt=await fs.readFile(file,'utf8'),mints=new Set();
  for(const line of txt.split(/\r?\n/)){try{const r=JSON.parse(line);if(r.chainId==='solana'&&r.token&&Number(r.paperLearning?.totalPnlUsd)>0&&Number(r.paperLearning?.sampleSize)>=5)mints.add(r.token);}catch{}}
  return [...mints];
}
async function pruneWallets(){
  const j=await readJson(WALLETS,{version:1,wallets:[]}),outcomeLines=(await fs.readFile(path.join(ROOT,'paper_wallet_outcomes.jsonl'),'utf8').catch(()=>'' )).split(/\r?\n/).filter(Boolean),outcomeRows=[];
  for(const line of outcomeLines){try{outcomeRows.push(JSON.parse(line));}catch{}}
  const outcomes=new Map();for(const row of outcomeRows){const arr=outcomes.get(row.wallet)||[];arr.push(row);outcomes.set(row.wallet,arr);}
  const muted=[],active=[],promoted=[],telemetryErrors=[],mutedExisting=[];
  for(const w of j.wallets||[]){
    if(w.status==='MUTED'){mutedExisting.push(w);continue;}
    let liveLast=null;try{const sigs=await signatures(w.address,Date.now()/1000-30*DAY);liveLast=Number(sigs[0]?.blockTime||0);if(liveLast)w.last_active_at=iso(liveLast*1000);}catch(e){telemetryErrors.push({address:w.address,error:String(e)});}
    const rs=outcomes.get(w.address)||[],recent=rs.filter(r=>Number(r.entryTime)>=Date.now()-14*DAY*1000),h4=recent.map(r=>r.outcomes?.['4h']?.returnPct).filter(Number.isFinite),allHorizons=recent.flatMap(r=>['15m','60m','4h'].map(h=>r.outcomes?.[h]?.returnPct).filter(Number.isFinite));
    const hitRate=h4.length>=10?h4.filter(x=>x>0).length/h4.length*100:(allHorizons.length>=30?allHorizons.filter(x=>x>0).length/allHorizons.length*100:null);
    const rugCount=recent.filter(r=>r.rug===true).length;
    const age=Date.now()-Date.parse(w.last_active_at||w.added_at||0),reasons=[];
    if(liveLast===null&&telemetryErrors.some(x=>x.address===w.address)){/* RPC failure: do not infer inactivity from stale data. */}
    else if(age>14*DAY*1000)reasons.push('inactive-14d');
    if(hitRate!==null&&hitRate<35)reasons.push('14d-hit-rate-under-35');if(rugCount>=2)reasons.push('two-rug-entries');
    w.performance14d={observations:recent.length,horizonSamples:allHorizons.length,hitRatePct:hitRate,rugEntries:rugCount,mean4hPct:h4.length?h4.reduce((s,v)=>s+v,0)/h4.length:null};
    if(reasons.length){w.status='MUTED';w.muted_at=iso(Date.now());w.mute_reasons=reasons;muted.push({address:w.address,reasons});}else if(w.status==='ACTIVE'){active.push(w);}else{w.status='WATCH';active.push(w);}
  }
  active.sort((a,b)=>Number(b.confidence_score||0)-Number(a.confidence_score||0));
  const kept=active.filter(w=>w.status==='ACTIVE').slice(0,50);const keptSet=new Set(kept);for(const w of active)if(!keptSet.has(w))w.status='WATCH';
  j.wallets=[...kept,...active.filter(w=>!keptSet.has(w)),...muted.map(x=>(j.wallets||[]).find(w=>w.address===x.address)),...mutedExisting].filter(Boolean);
  j.updated_at=iso(Date.now());await writeJson(WALLETS,j);
  const top=[...kept].sort((a,b)=>Number(b.performance14d?.mean4hPct??-Infinity)-Number(a.performance14d?.mean4hPct??-Infinity)).slice(0,5);
  const recentAdds=kept.filter(w=>Date.now()-Date.parse(w.added_at||0)<=7*DAY).map(w=>w.address);
  return {active:kept.length,promoted:[...new Set([...promoted,...recentAdds])],muted,top:top.map(w=>({address:w.address,hitRate14d:w.performance14d?.hitRatePct,mean4hPct:w.performance14d?.mean4hPct,confidence:w.confidence_score})),telemetryErrors};
}
async function sendWeeklyTelegram(summary){
  const token=process.env.TELEGRAM_BOT_TOKEN||'',chat=process.env.TELEGRAM_CHAT_ID||'';if(!token||!chat){console.log('[curator] Telegram summary skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured.');return;}
  const lines=['MEME.RADAR weekly wallet curator',`Active: ${summary.active}`,`Promoted: ${summary.promoted.length?summary.promoted.join(', '):'none'}`,`Muted: ${summary.muted.length?summary.muted.map(x=>x.address+' ('+x.reasons.join('/')+')').join(', '):'none'}`,'Top active:'];
  for(const w of summary.top)lines.push(`• ${w.address}: 14d hit ${w.hitRate14d??'n/a'}%, avg 4h ${w.mean4hPct??'n/a'}%, score ${w.confidence??'n/a'}`);
  if(summary.telemetryErrors.length)lines.push(`RPC telemetry errors: ${summary.telemetryErrors.length} (see CLI output)`);
  const res=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text:lines.join('\n')})});
  const body=await res.json().catch(()=>null);if(!res.ok||!body?.ok)throw new Error('Telegram weekly summary failed: HTTP '+res.status+' '+JSON.stringify(body).slice(0,300));
}
async function main(){
  const args=process.argv.slice(2),get=(flag)=>{const i=args.indexOf(flag);return i>=0?args[i+1]:null;};
  if(args.includes('--help')){console.log('Usage: node smart-wallet-curator.mjs --import candidates.csv|json|txt | --from-mints MINT1,MINT2 | --from-research [file] | --prune | --dry-run');return;}
  if(args.includes('--prune')){const summary=await pruneWallets();console.log(JSON.stringify(summary,null,2));await sendWeeklyTelegram(summary);return;}
  if(args.includes('--dry-run')){const u=await readJson(USAGE,{month:monthKey(),credits:0,requests:0});console.log(JSON.stringify({mode:'dry-run/no-RPC',rpcCreditsThisRun:0,monthlyUsage:u,monthlyLimit:MONTHLY_LIMIT,versionedTxParser:'resolved staticAccountKeys + meta.loadedAddresses; skips unresolved ALT transactions',veting:'strict gates reject incomplete evidence',note:'Use --verify-signature SIG --wallet ADDRESS for live RPC parser validation.'},null,2));return;}
  let candidates=[];
  const imp=get('--import');if(imp)candidates.push(...await importCandidates(imp));
  const mints=(get('--from-mints')||'').split(',').filter(Boolean);
  if(args.includes('--from-research')){const f=get('--from-research')||path.join(ROOT,'paper_research.jsonl');mints.push(...await sourceResearchMints(f));}
  for(const mint of [...new Set(mints)])candidates.push(...await discoverFromMint(mint));
  const verify=get('--verify-signature'),wallet=get('--wallet');if(verify&&wallet){const tx=await txBySignature(verify);if(!tx)throw new Error('Signature not found');console.log(JSON.stringify({signature:verify,slot:tx.slot,resolvedAccountKeys:resolvedKeys(tx),loadedAddresses:tx.meta?.loadedAddresses||null,programs:instructionProgramIds(tx)},null,2));return;}
  if(!candidates.length)throw new Error('No candidates. Supply --import file, --from-mints list, or --from-research [file].');
  const q=await readJson(QUEUE,{version:1,candidates:[]}),by=new Map((q.candidates||[]).map(x=>[x.address,x]));
  for(const c of candidates)if(validAddress(c.address))by.set(c.address,{...by.get(c.address),...c,queued_at:iso(Date.now()),status:'PENDING'});
  q.candidates=[...by.values()];await writeJson(QUEUE,q);
  const curated=await readJson(WALLETS,{version:1,wallets:[]}),tracked=new Set(curated.wallets.filter(w=>w.status==='ACTIVE').map(w=>w.address)),promoted=[],rejected=[];
  const knownDeployers=new Set(String(process.env.KNOWN_DEPLOYER_WALLETS||'').split(',').map(x=>x.trim()).filter(Boolean)),sources=new Map();
  for(const c of [...new Map(candidates.filter(x=>validAddress(x.address)).map(x=>[x.address,x])).values()]){try{sources.set(c.address,await findFundingSource(c.address));}catch(e){rejected.push({address:c.address,fundingScanError:String(e)});}}
  const fundingLinks=analyzeFundingLinks([...sources.keys()],sources,{knownRiskAddresses:knownDeployers,trackedAddresses:tracked,sharedSourceMin:2,maxDepth:2});
  for(const c of candidates){if(!validAddress(c.address))continue;try{const source=sources.get(c.address)||null,link=fundingLinks.get(c.address),fundingLinked=!!link?.linked,v=await vetCandidate(c,{fundingSource:source,fundingLinked});if(!v.pass){rejected.push({address:c.address,reasons:v.reasons,metrics:v.metrics,fundingLinkReasons:link?.reasons||[]});continue;}
    const m=v.metrics,w={address:c.address,label:c.label||'curated',added_at:iso(Date.now()),last_active_at:iso(Date.now()),realized_win_rate_30d:m.realizedWinRate30d,profit_factor_30d:m.profitFactor30d,median_hold_mins:m.medianHoldMins,median_buy_sol:m.medianBuySol,confidence_score:m.confidenceScore,status:'ACTIVE',correlation_group:link?.correlationGroup||source||'',funding_link_reasons:link?.reasons||[],metrics:m};
    curated.wallets=[...curated.wallets.filter(x=>x.address!==c.address),w];promoted.push(w);
  }catch(e){rejected.push({address:c.address,error:String(e)});}}
  const eligible=curated.wallets.filter(w=>w.status==='ACTIVE').sort((a,b)=>Number(b.confidence_score||0)-Number(a.confidence_score||0));const activeSet=new Set(eligible.slice(0,50));for(const w of curated.wallets)if(w.status!=='MUTED')w.status=activeSet.has(w)?'ACTIVE':'WATCH';curated.wallets.sort((a,b)=>Number(b.confidence_score||0)-Number(a.confidence_score||0));curated.updated_at=iso(Date.now());await writeJson(WALLETS,curated);
  console.log(JSON.stringify({candidateCount:candidates.length,promoted:promoted.length,rejected,activeCount:curated.wallets.filter(w=>w.status==='ACTIVE').length,rpcUsage:await readJson(USAGE,{})},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error('[curator error]',e.message);process.exitCode=1;});
export {resolvedKeys,instructionProgramIds,tokenDeltaByOwner,solDeltaByAccount,decodeSwap,analyzeTrades,vetWallet,validAddress,MONTHLY_LIMIT,MAX_RPS};
