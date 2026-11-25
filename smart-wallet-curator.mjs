#!/usr/bin/env node
/**
 * MEME.RADAR V6 Smart Wallet Curator.
 * Uses only standard Solana RPC methods (getSignaturesForAddress/getTransaction).
 * Unknown/unsupported trade accounting is rejected; never fabricate metrics.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const RPC=process.env.SOLANA_RPC_URL||process.env.HELIUS_RPC_URL||'https://api.mainnet-beta.solana.com';
const KEY=process.env.HELIUS_API_KEY||'';
const RPC_URL=KEY && /helius/i.test(RPC) ? (RPC.includes('?')?RPC+'&':'?')+'api-key='+encodeURIComponent(KEY) : RPC;
const WALLETS=path.join(ROOT,'smart_wallets.json');
const QUEUE=path.join(ROOT,'candidate_wallets.json');
const USAGE=path.join(ROOT,'rpc-curator-usage.json');
const DAY=86400, LOOKBACK=30*DAY;
const MAX_RPS=Math.min(6,Math.max(1,Number(process.env.RPC_MAX_RPS||6)));
const MONTHLY_LIMIT=1_000_000;
const DEX_PROGRAMS=new Set([
 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB','JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
 '675kPX9MHTjS2zt1qfr1NYHuzefG8uW1vZ8wzY5zYz','whirLbMiicVdio4qvUfM5KAg6Ct3V7x5k3h4n9v2',
 'CPMMoo8L3F4NbTegBCKVN5p9P7qj9V7fJ8W5b8p','6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const iso=ms=>new Date(ms).toISOString();
const readJson=async(p,fb)=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch{return fb;}};
const writeJson=async(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n');
function monthKey(){const d=new Date();return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');}
let lastReq=0, rpcId=0;
async function rpc(method,params){
  const usage=await readJson(USAGE,{month:monthKey(),credits:0,requests:0});
  if(usage.month!==monthKey()){usage.month=monthKey();usage.credits=0;usage.requests=0;}
  if(usage.credits>=MONTHLY_LIMIT)throw new Error('RPC monthly credit budget exhausted; refusing further calls.');
  const wait=Math.max(0,Math.ceil(1000/MAX_RPS)-(Date.now()-lastReq));if(wait)await sleep(wait);
  let attempt=0;
  while(true){
    lastReq=Date.now();
    const res=await fetch(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});
    if(res.status===429){if(attempt++>=7)throw new Error('RPC 429 persisted after exponential backoff');await sleep(Math.min(60000,1000*2**attempt)+Math.floor(Math.random()*500));continue;}
    const raw=await res.text();let body;try{body=JSON.parse(raw);}catch{throw new Error('RPC returned non-JSON HTTP '+res.status);}
    usage.credits++;usage.requests++;await writeJson(USAGE,usage);
    if(!res.ok||body.error)throw new Error('RPC '+method+' failed HTTP '+res.status+': '+JSON.stringify(body.error||body).slice(0,500));
    if(!Object.hasOwn(body,'result'))throw new Error('RPC '+method+' response missing result');
    return body.result;
  }
}
function parseCsvLine(line){return line.split(',').map(x=>x.trim().replace(/^["']|["']$/g,''));}
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
  const loaded=tx.meta?.loadedAddresses||{};
  return keys.concat((loaded.writable||[]).map(k=>typeof k==='string'?k:k.pubkey),(loaded.readonly||[]).map(k=>typeof k==='string'?k:k.pubkey));
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
  return d;
}
function decodeSwap(tx,owner){
  if(!tx?.meta||tx.meta.err) return [];
  const programs=instructionProgramIds(tx);if(!programs.some(p=>DEX_PROGRAMS.has(p)))return [];
  const t=tokenDeltaByOwner(tx),sol=solDeltaByAccount(tx),out=[];
  for(const [key,delta] of t){const [wallet,mint]=key.split('|');if(wallet!==owner||!mint||!Number.isFinite(delta)||delta===0)continue;
    const solChange=sol.get(owner);if(!Number.isFinite(solChange)||Math.abs(solChange)<1e-9)continue;
    // SOL-funded token acquisition or token disposal with SOL received; non-SOL pairs are intentionally not valued.
    if(delta>0&&solChange<0)out.push({mint,side:'BUY',tokenAmount:delta,solAmount:Math.abs(solChange),slot:Number(tx.slot||0),blockTime:Number(tx.blockTime||0),signature:tx.signature||''});
    if(delta<0&&solChange>0)out.push({mint,side:'SELL',tokenAmount:Math.abs(delta),solAmount:solChange,slot:Number(tx.slot||0),blockTime:Number(tx.blockTime||0),signature:tx.signature||''});
  }return out;
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
  return rpc('getTransaction',[signature,{encoding:'json',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
}
async function discoverFromMint(mint){
  if(!validAddress(mint))throw new Error('Invalid mint: '+mint);
  const sigs=await signatures(mint,Date.now()/1000-LOOKBACK);
  const candidates=new Map();
  for(const s of sigs){const tx=await txBySignature(s.signature);if(!tx)continue;
    const keys=resolvedKeys(tx),deltas=tokenDeltaByOwner(tx);
    for(const [key,delta] of deltas){const [owner,token]=key.split('|');if(token===mint&&delta>0&&validAddress(owner))candidates.set(owner,{address:owner,label:'graduated-token-discovery',source:'winning-mint:'+mint,firstSeen:s.blockTime||0});}
  }return [...candidates.values()];
}
async function recentWalletSwaps(address,cutoff){
  const sigs=await signatures(address,cutoff),rows=[];
  for(const s of sigs){const tx=await txBySignature(s.signature);if(!tx)continue;
    // Use fully resolved account keys; any versioned tx lacking loaded address metadata is skipped.
    const msg=tx.transaction?.message;if((msg?.addressTableLookups?.length||0)>0&&!tx.meta?.loadedAddresses)continue;
    const swaps=decodeSwap(tx,address);for(const x of swaps){x.signature=s.signature;x.blockTime=Number(tx.blockTime||s.blockTime||0);rows.push(x);}
  }return rows.sort((a,b)=>a.blockTime-b.blockTime);
}
function analyzeTrades(swaps){
  const open=new Map(),closed=[];
  for(const s of swaps){if(s.side==='BUY'){const q=open.get(s.mint)||[];q.push(s);open.set(s.mint,q);continue;}
    const q=open.get(s.mint);if(!q?.length)continue;
    // FIFO proportional lot closure. SOL amounts are actual wallet SOL deltas, including fees/tips.
    let remaining=s.tokenAmount,proceeds=s.solAmount,matchedCost=0,matchedTokens=0,first=Infinity;
    while(remaining>1e-12&&q.length){const lot=q[0],take=Math.min(remaining,lot.tokenAmount),ratio=take/lot.tokenAmount;matchedCost+=lot.solAmount*ratio;matchedTokens+=take;first=Math.min(first,lot.blockTime);lot.tokenAmount-=take;lot.solAmount*=1-ratio;remaining-=take;if(lot.tokenAmount<=1e-12)q.shift();}
    if(matchedTokens>0){const sellMatched=s.tokenAmount?proceeds*(matchedTokens/s.tokenAmount):0;closed.push({mint:s.mint,buyTime:first,sellTime:s.blockTime,holdMins:(s.blockTime-first)/60,costSol:matchedCost,proceedsSol:sellMatched,pnlSol:sellMatched-matchedCost});}
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
  const profitableMints=new Set(wins.map(t=>t.mint)),pnlByMint=new Map();for(const t of trades)pnlByMint.set(t.mint,(pnlByMint.get(t.mint)||0)+t.pnlSol);
  const largest=pnl>0?Math.max(0,...pnlByMint.values())/pnl:1;
  const holds=trades.map(t=>t.holdMins).filter(Number.isFinite),medianHold=median(holds);
  const buySizes=swaps.filter(x=>x.side==='BUY').map(x=>x.solAmount),medianBuy=median(buySizes);
  if(profitableMints.size<5)reasons.push('less-than-5-profitable-tokens');
  if(largest>0.6)reasons.push('single-token-pnl-concentration');
  if(medianHold===null||medianHold<10)reasons.push('median-hold-under-10m');
  if(swaps.some((s,i)=>i&&s.mint===swaps[i-1].mint&&s.blockTime-swaps[i-1].blockTime<60&&s.side!==swaps[i-1].side))reasons.push('wash-loop-under-1m');
  if(trades.length<10)reasons.push('less-than-10-closed-trades');
  if(medianBuy===null||medianBuy<0.25)reasons.push('median-buy-under-0.25-sol');
  if(winRate===null||winRate<45)reasons.push('win-rate-under-45pct');
  if(pf===null||pf<1.8)reasons.push('profit-factor-under-1.8');
  if(!Number.isFinite(pnl)||pnl<=0)reasons.push('non-positive-realized-pnl');
  const confidence=Math.max(0,Math.min(100,Math.round((winRate||0)*0.35+Math.min(3,pf||0)*12+Math.min(30,profitableMints.size)*0.8+(days7.length?10:0))));
  return {pass:reasons.length===0,reasons,metrics:{closedTrades:trades.length,profitableTokens:profitableMints.size,realizedWinRate30d:winRate,profitFactor30d:pf,medianHoldMins:medianHold,medianBuySol:medianBuy,largestTokenPnlShare:largest,realizedPnlSol:pnl,confidenceScore:confidence,swaps30d:swaps.length,swaps7d:days7.length}};
}
async function vetCandidate(c){
  if(!validAddress(c.address))return {candidate:c,pass:false,reasons:['invalid-solana-address']};
  const cutoff=Date.now()/1000-LOOKBACK,swaps=await recentWalletSwaps(c.address,cutoff),trades=analyzeTrades(swaps);
  const result=vetWallet(c.address,trades,swaps);
  return {...result,candidate:c,swaps,trades};
}
async function sourceResearchMints(file){
  const txt=await fs.readFile(file,'utf8'),mints=new Set();
  for(const line of txt.split(/\r?\n/)){try{const r=JSON.parse(line);if(r.chainId==='solana'&&r.token&&Number(r.paperLearning?.totalPnlUsd)>0&&Number(r.paperLearning?.sampleSize)>=5)mints.add(r.token);}catch{}}
  return [...mints];
}
async function pruneWallets(){
  const j=await readJson(WALLETS,{version:1,wallets:[]}),research=(await fs.readFile(path.join(ROOT,'paper_research.jsonl'),'utf8').catch(()=>'' )).split(/\r?\n/).filter(Boolean);
  const outcomes=new Map();
  for(const line of research){try{const r=JSON.parse(line),a=r.wallet||r.sourceWallet;if(!a)continue;const arr=outcomes.get(a)||[];arr.push(r);outcomes.set(a,arr);}catch{}}
  const muted=[],active=[];
  for(const w of j.wallets||[]){const rs=outcomes.get(w.address)||[],recent=rs.filter(r=>Date.parse(r.recordedAt||r.timestamp||0)>=Date.now()-14*DAY);
    const hit=recent.filter(r=>Number(r.performance?.pnl15m??r.pnl15m)>0).length,hitRate=recent.length?hit/recent.length*100:null;
    const rugCount=recent.filter(r=>r.rugPull===true||r.outcome==='RUG').length,age=Date.now()-Date.parse(w.last_active_at||w.added_at||0);
    const reasons=[];if(age>14*DAY*1000)reasons.push('inactive-14d');if(hitRate!==null&&hitRate<35)reasons.push('14d-hit-rate-under-35');if(rugCount>=2)reasons.push('two-rug-entries');
    if(reasons.length){w.status='MUTED';w.muted_at=iso(Date.now());w.mute_reasons=reasons;muted.push({address:w.address,reasons});}else active.push(w);
  }
  active.sort((a,b)=>Number(b.confidence_score||0)-Number(a.confidence_score||0));
  const kept=active.slice(0,50);for(const w of active.slice(50)){w.status='WATCH';}
  j.wallets=[...kept,...active.slice(50),...muted.map(x=>(j.wallets||[]).find(w=>w.address===x.address))].filter(Boolean);
  j.updated_at=iso(Date.now());await writeJson(WALLETS,j);return {active:kept.length,muted};
}
async function main(){
  const args=process.argv.slice(2),get=(flag)=>{const i=args.indexOf(flag);return i>=0?args[i+1]:null;};
  if(args.includes('--help')){console.log('Usage: node smart-wallet-curator.mjs --import candidates.csv|json|txt | --from-mints MINT1,MINT2 | --from-research [file] | --prune | --dry-run');return;}
  if(args.includes('--prune')){console.log(JSON.stringify(await pruneWallets(),null,2));return;}
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
  for(const c of candidates){if(!validAddress(c.address))continue;try{const v=await vetCandidate(c);if(!v.pass){rejected.push({address:c.address,reasons:v.reasons,metrics:v.metrics});continue;}
    const m=v.metrics,w={address:c.address,label:c.label||'curated',added_at:iso(Date.now()),last_active_at:iso(Date.now()),realized_win_rate_30d:m.realizedWinRate30d,profit_factor_30d:m.profitFactor30d,median_hold_mins:m.medianHoldMins,median_buy_sol:m.medianBuySol,confidence_score:m.confidenceScore,status:'ACTIVE',metrics:m};
    curated.wallets=[...curated.wallets.filter(x=>x.address!==c.address),w];promoted.push(w);
  }catch(e){rejected.push({address:c.address,error:String(e)});}}
  curated.wallets.sort((a,b)=>Number(b.confidence_score||0)-Number(a.confidence_score||0));curated.wallets=curated.wallets.slice(0,50);curated.updated_at=iso(Date.now());await writeJson(WALLETS,curated);
  console.log(JSON.stringify({candidateCount:candidates.length,promoted:promoted.length,rejected,activeCount:curated.wallets.filter(w=>w.status==='ACTIVE').length,rpcUsage:await readJson(USAGE,{})},null,2));
}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(e=>{console.error('[curator error]',e.message);process.exitCode=1;});
export {resolvedKeys,instructionProgramIds,tokenDeltaByOwner,decodeSwap,analyzeTrades,vetWallet,validAddress};
