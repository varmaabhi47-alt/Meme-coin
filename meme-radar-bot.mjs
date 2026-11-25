#!/usr/bin/env node
/**
 * MEME.RADAR v4 — 24/7 Autonomous Paper-Trading Node.js Bot (Zero Simulation)
 * GitHub Actions mode: one paper-trading scan per scheduled run.
 *
 * Features:
 * - Polls live DexScreener feeds + enriches in 30-address batches
 * - Strict Liquidity & Sellability Gate + mandatory live RugCheck (Solana) / GoPlus (EVM)
 * - Realistic AMM impact (tradeUsd / (2 * liquidityUsd)) + 0.30% DEX fee on Buy & Sell
 * - Auto-Exit: Take Profit, Stop Loss, Trailing Stop, Max Hold Time, Emergency Liq Drop (>60%)
 * - Saves state persistently to paper_portfolio.json (importable into Web UI!) & paper_trades.csv
 * - Sends instant Telegram receipts on every AUTO-BUY and AUTO-SELL + hourly summary
 */

import fs from 'node:fs/promises';
import { scoreCandidate, calculatePaperBuy, calculatePaperSell, detectBasicMarketWarnings, calculateTopHolderConcentration, analyzeCreatorSignals, summarizeCrossTokenClusters, evaluateDiscoveryPrefilter, calculateJupiterQuoteExit, analyzeNarrativeFootprint, summarizePaperLearning, evaluateSolanaHardSecurityGates } from './meme-radar-v5-intelligence.mjs';
import { evaluatePositionRisk, calculatePositionSize, checkCircuitBreakers, parseTelegramCommand, makeStateLock } from './meme-radar-v5-risk-engine.mjs';
import { RpcCreditGuard, SolanaEventListener, extractMintsFromTransaction, extractWalletTokenBuys, createSmartMoneyConfluence, computeEdgeProof } from './path2-runtime.mjs';

const CONFIG = {
  FEED_URL: 'https://api.dexscreener.com/token-profiles/latest/v1',
  CHAIN_FILTER: "all",
  SUPPORTED_CHAINS: ['solana', 'base', 'ethereum', 'bsc', 'arbitrum'],
  EVM_CHAIN_IDS: { ethereum: '1', bsc: '56', base: '8453', arbitrum: '42161' },
  POLL_SEC: 30,
  MONITOR_SEC: 10,
  DISCOVERY_SEC: 180,
  DEX_FEE_RATE: 0.003,
  JUPITER_API_KEY: process.env.JUPITER_API_KEY || '',
  JUPITER_QUOTE_ENABLED: process.env.JUPITER_QUOTE_ENABLED !== 'false',
  BACKOFF_STEPS: [10, 20, 40, 60],

  // Synced Strategy & Liquidity Gate Settings
  STARTING_BANKROLL: 1000,
  BASE_RISK_FRACTION: 0.05,
  MAX_POOL_LIQ_FRACTION: 0.003,
  MAX_OPEN_POSITIONS: 5,
  TP_PCT: 40,
  SL_PCT: 18,
  TRAIL_ARM_PCT: 40,
  TRAIL_DROP_PCT: 15,
  MAX_HOLD_HOURS: 24,
  COOLDOWN_MINS: 60,
  MIN_LIQUIDITY_USD: 75000,
  MAX_TRADE_TO_LIQ_PCT: 0.5,
  MIN_LIQ_FDV_PCT: 8,
  MIN_SELLS_1H: 10,
  MIN_VOLUME_24H: 50000,
  MIN_BUY_RATIO_PCT: 55,

  // Telegram & Persistence
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  PORTFOLIO_FILE: 'paper_portfolio.json',
  CSV_FILE: 'paper_trades.csv',
  RESEARCH_FILE: 'paper_research.jsonl'
};

const secCache = new Map();
const jupiterQuoteCache = new Map();
let lastJupiterRequestMs = 0;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let failures = 0;
let lastPollIso = null;
let lastError = '';
let lastHourlySummaryMs = 0;
let d1Version = 0;
let stateLock = makeStateLock();
let consecutiveRiskExits = 0;
let telegramOffset = 0;
const rpcGuard = new RpcCreditGuard({ maxRps: Number(process.env.RPC_MAX_RPS || 6), monthlyLimit: Number(process.env.RPC_MONTHLY_CREDIT_LIMIT || 800000), stateFile: 'rpc-usage.json' });
const holderAuditCache = new Map();
const eventMintQueue = new Set();
const smartMoneyConfluence = createSmartMoneyConfluence();
let eventListener = null;

let portfolio = {
  autoTradeEnabled: true,
  startingBankroll: CONFIG.STARTING_BANKROLL,
  cashUsd: CONFIG.STARTING_BANKROLL,
  openPositions: [],
  closedTrades: [],
  cooldowns: {},
  decisionLog: []
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

async function loadState() {
  try { const cache=JSON.parse(await fs.readFile('audit-cache.json','utf8')); for(const [key,value] of Object.entries(cache)) if(value&&Date.now()-Number(value.ts)<900000)secCache.set(key,value); } catch {}
  try {
    const raw = await fs.readFile(CONFIG.PORTFOLIO_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    portfolio = { ...portfolio, ...parsed };
    lastHourlySummaryMs = Number(parsed.lastHourlySummaryMs || 0);
    consecutiveRiskExits = Number(parsed.consecutiveRiskExits || 0);
    telegramOffset = Number(parsed.telegramOffset || 0);
    console.log(`[${nowIso()}] Loaded ${CONFIG.PORTFOLIO_FILE} | Cash: $${portfolio.cashUsd.toFixed(2)} | Open: ${portfolio.openPositions.length} | Closed: ${portfolio.closedTrades.length}`);
  } catch {
    await saveState();
    console.log(`[${nowIso()}] Initialized fresh ${CONFIG.PORTFOLIO_FILE} with $${portfolio.cashUsd.toFixed(2)} USDC`);
  }
}

async function saveState() { return stateLock(async()=>{portfolio.lastHourlySummaryMs=lastHourlySummaryMs;portfolio.rpcTelemetry=rpcGuard.telemetry();portfolio.edgeProof=computeEdgeProof(portfolio.closedTrades||[]);const tmp=CONFIG.PORTFOLIO_FILE+'.tmp';await fs.writeFile(tmp,JSON.stringify(portfolio,null,2),'utf8');await fs.rename(tmp,CONFIG.PORTFOLIO_FILE);await fs.writeFile('audit-cache.json',JSON.stringify(Object.fromEntries(secCache)),'utf8');}); }

async function appendCsv(t) {
  let exists=true;try{await fs.access(CONFIG.CSV_FILE);}catch{exists=false;}
  if(!exists)await fs.writeFile(CONFIG.CSV_FILE,'EntryTime,ExitTime,Symbol,Chain,BuyPrice,TokensBought,CostUSD,EntryLiqUSD,SellPrice,ExitValueUSD,FeesImpactUSD,NetPnLUSD,NetPnLPct,ExitReason,TokensSold,RemainingTokens,RealizedPartialPnLUSD,QuoteFallback,EntryQuoteFallback\n','utf8');
  const line=[new Date(t.entryTime).toISOString(),new Date(t.exitTime).toISOString(),t.symbol,t.chainId,t.buyPrice,t.tokensBought,t.costUsd.toFixed(2),Math.round(t.entryLiquidityUsd),t.sellPrice,t.exitValueUsd.toFixed(2),t.feesImpactUsd.toFixed(2),t.netPnlUsd.toFixed(2),t.netPnlPct.toFixed(2),t.exitReason,t.tokensSold??t.tokensBought,t.remainingTokens??0,t.realizedPartialPnlUsd??0,!!t.quoteFallback,!!t.entryQuoteFallback].join(',')+'\n';
  await fs.appendFile(CONFIG.CSV_FILE,line,'utf8');
}

async function fetchJsonStrict(url, timeoutMs = 11000, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`${url} -> ${err.message}`);
  }
}

async function sendTelegram(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.error(`[${nowIso()}] Telegram not configured: missing bot token or chat ID.`);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.description || `Telegram HTTP ${res.status}`);
    }
    console.log(`[${nowIso()}] Telegram message delivered (message_id: ${data.result?.message_id ?? 'accepted'}).`);
    return true;
  } catch (e) {
    console.error(`[${nowIso()}] Telegram delivery failed: ${e.message}`);
    return false;
  }
}

function logDecision(action, symbol, chainId, reason) {
  portfolio.decisionLog.unshift({ ts: Date.now(), timeStr: nowIso().slice(11, 19), action, symbol, chainId, reason });
  if (portfolio.decisionLog.length > 150) portfolio.decisionLog.pop();
  console.log(`[${nowIso()}] [${action}] ${symbol} (${chainId}): ${reason}`);
}

function calcBuy(usd, price, liq) {
  const result = calculatePaperBuy(usd, price, liq, CONFIG.DEX_FEE_RATE);
  return { feeUsd: result.feeUsd, impactUsd: result.impactUsd, impactRate: result.impactRate, effPrice: result.effectivePrice, tokens: result.tokens, model: result.model };
}

function estimatedNetworkFeeUsd(chain){return chain==='solana'?Math.min(0.75,Math.max(0.35,Number(process.env.SOLANA_FEE_USD_ESTIMATE||0.55))):chain==='ethereum'?4.00:chain==='base'?0.20:chain==='bsc'?0.25:chain==='arbitrum'?0.30:0.50;}
async function calcPaperEntry(usd,pair,security,decimals){
 const chain=String(pair.chainId||'').toLowerCase(),networkFeeUsd=estimatedNetworkFeeUsd(chain),tax=Number(security?.buyTaxRate||0);
 if(chain==='solana'&&CONFIG.JUPITER_QUOTE_ENABLED&&pair.baseToken?.address&&decimals!==null&&decimals!==undefined&&decimals!==''&&Number.isInteger(Number(decimals))&&Number(decimals)>=0&&Number(decimals)<=18){
  try{const amount=String(Math.floor(usd*1e6)),params=new URLSearchParams({inputMint:USDC_MINT,outputMint:pair.baseToken.address,amount});const headers=CONFIG.JUPITER_API_KEY?{'x-api-key':CONFIG.JUPITER_API_KEY}:{};
   const q=await fetchJsonStrict('https://api.jup.ag/swap/v2/order?'+params,9000,headers);const raw=String(q.outAmount||'');if(!/^\\d+$/.test(raw)||Number(raw)<=0)throw Error('invalid Jupiter entry output');
   const tokens=Number(raw)/(10**Number(decimals));if(!(tokens>0&&Number.isFinite(tokens)))throw Error('invalid Jupiter token quantity');
   const impact=Number(q.priceImpactPct||0);return {tokens,effPrice:(usd+networkFeeUsd)/tokens,feeUsd:networkFeeUsd,impactUsd:Math.max(0,usd*impact),impactRate:impact,model:'jupiter-entry-route-quote',quoteSource:'jupiter',quoteFallback:false,networkFeeUsd,buyTaxRate:0};
  }catch(e){console.warn('Jupiter entry quote failed; conservative labelled fallback: '+e.message);}
 }
 const est=calcBuy(usd,Number(pair.priceUsd),Number(pair.liquidity?.usd||0));
 const fallbackPenalty=chain==='solana'?Math.min(0.15,Math.max(0.08,Number(process.env.QUOTE_FALLBACK_SLIPPAGE_PCT||8))/100):0;
 const tokens=est.tokens*(1-fallbackPenalty)*(1-tax);
 return {...est,tokens,effPrice:(usd+networkFeeUsd)/tokens,feeUsd:est.feeUsd+networkFeeUsd+usd*tax,networkFeeUsd,buyTaxRate:tax,quoteSource:'constant-product-fallback',quoteFallback:chain==='solana',fallbackPenaltyPct:fallbackPenalty*100};
}

async function calcPaperExit(pos, price, liq) {
  const qty=Number(pos.remainingTokens??pos.tokens);const fallback=()=>{const est=calcSell(qty,price,liq);const penalty=pos.chainId==='solana'?Math.max(0,Number(process.env.QUOTE_FALLBACK_SLIPPAGE_PCT||8))/100:0;const tax=Number(pos.sellTaxRate||0),networkFeeUsd=estimatedNetworkFeeUsd(pos.chainId);const afterTax=est.netProceeds*(1-tax);return {...est,netProceeds:Math.max(0,afterTax*(1-penalty)-networkFeeUsd),feeUsd:est.feeUsd+networkFeeUsd+est.netProceeds*tax,quoteSource:'constant-product-fallback',quoteFallback:pos.chainId==='solana',fallbackPenaltyPct:penalty*100,networkFeeUsd};};
  if (!CONFIG.JUPITER_QUOTE_ENABLED || pos.chainId !== 'solana' ||
      !pos.address || pos.tokenDecimals == null || !Number.isInteger(Number(pos.tokenDecimals))) return fallback();
  const decimals = Number(pos.tokenDecimals);
  if (decimals < 0 || decimals > 18) return fallback();
  const cacheKey = String(pos.address)+':'+qty;
  const cached = jupiterQuoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 8000) return cached.value;
  try {
    const rawAmount = BigInt(Math.floor(qty * (10 ** decimals))).toString();
    if (rawAmount === '0') return fallback();
    const waitMs = Math.max(0, 2100 - (Date.now() - lastJupiterRequestMs));
    if (waitMs) await sleep(waitMs);
    const params = new URLSearchParams({ inputMint: pos.address, outputMint: USDC_MINT, amount: rawAmount });
    lastJupiterRequestMs = Date.now();
    const headers = CONFIG.JUPITER_API_KEY ? { 'x-api-key': CONFIG.JUPITER_API_KEY } : {};
    const quote = await fetchJsonStrict(`https://api.jup.ag/swap/v2/order?${params}`, 9000, headers);
    const result = calculateJupiterQuoteExit({ quote, tokens: qty, spotPrice: price, outputDecimals: 6 });
    const value = {
      effPrice: result.effectivePrice, impactUsd: result.impactUsd, impactRate: result.impactRate,
      feeUsd: result.feeUsd + estimatedNetworkFeeUsd('solana'), netProceeds: Math.max(0,result.netProceeds-estimatedNetworkFeeUsd('solana')), model: result.model, networkFeeUsd: estimatedNetworkFeeUsd('solana'),
      quoteSource: 'jupiter', quoteFallback: false, router: result.router
    };
    jupiterQuoteCache.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (error) {
    console.warn(`[${nowIso()}] Jupiter quote unavailable for ${pos.symbol}; using labelled paper estimate: ${error.message}`);
    return fallback();
  }
}

function calcSell(tokens, price, liq) {
  const result = calculatePaperSell(tokens, price, liq, CONFIG.DEX_FEE_RATE);
  return { effPrice: result.effectivePrice, impactUsd: result.impactUsd, impactRate: result.impactRate, feeUsd: result.feeUsd, netProceeds: result.netProceeds, model: result.model };
}

async function inspectSolanaHolders(tokenAddress, pairAddress = null) {
  const cachedAudit = holderAuditCache.get(tokenAddress);
  if (cachedAudit && Date.now() - cachedAudit.ts < 900000) return cachedAudit.value;
  const endpoint = process.env.SOLANA_RPC_HTTP || 'https://api.mainnet-beta.solana.com';
  const rpc = (method, params, id) => rpcGuard.rpc(endpoint, method, params, { credits: 1, cacheKey: 'solana:' + method + ':' + JSON.stringify(params) });
  try {
    const [largest, supply, mintInfo] = await Promise.all([
      rpc('getTokenLargestAccounts', [tokenAddress, { commitment: 'confirmed' }], 1),
      rpc('getTokenSupply', [tokenAddress, { commitment: 'confirmed' }], 2),
      rpc('getAccountInfo', [tokenAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }], 3)
    ]);
    const accounts = largest?.value || [];
    const accountAddresses = accounts.map(account => account.address).filter(Boolean);
    const ownerResponse = accountAddresses.length
      ? await rpc('getMultipleAccounts', [accountAddresses, { encoding: 'jsonParsed', commitment: 'confirmed' }], 4)
      : { value: [] };
    const holderOwners = (ownerResponse?.value || []).map(account => account?.data?.parsed?.info?.owner || null);
    const accountsWithOwners = accounts.map((account, index) => ({ ...account, owner: holderOwners[index] || null }));
    const info = mintInfo?.value?.data?.parsed?.info || {};
    const mintAuthority = info.mintAuthority || null;
    const freezeAuthority = info.freezeAuthority || null;
    let authoritySignatureCount = null;
    if (mintAuthority) {
      try {
        const signatures = await rpc('getSignaturesForAddress', [mintAuthority, { limit: 1000, commitment: 'confirmed' }], 5);
        authoritySignatureCount = Array.isArray(signatures) ? signatures.length : null;
      } catch {}
    }
    const holderDistribution = {
      ...calculateTopHolderConcentration(accountsWithOwners, supply?.value?.amount, [pairAddress]),
      decimals: supply?.value?.decimals ?? null,
      source: 'Solana RPC', totalSupplyRaw: String(supply?.value?.amount || '0')
    };
    let priorRows = [];
    try {
      const raw = await fs.readFile(CONFIG.RESEARCH_FILE, 'utf8');
      priorRows = raw.split(/\r?\n/).filter(Boolean).slice(-5000).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch {}
    const creatorSignals = analyzeCreatorSignals({
      mintAuthority, freezeAuthority, authoritySignatureCount, holderOwners, priorAuthorityRows: priorRows
    });
    const currentObservation = { token: tokenAddress, creatorSignals };
    const relatedClusters = summarizeCrossTokenClusters([...priorRows, currentObservation])
      .filter(cluster => cluster.tokens.includes(tokenAddress));
    creatorSignals.crossTokenClusters = relatedClusters;
    creatorSignals.crossTokenClusterCount = relatedClusters.length;
    creatorSignals.crossTokenTokensObserved = [...new Set(relatedClusters.flatMap(cluster => cluster.tokens))].length;
    const value = { holderDistribution, creatorSignals }; holderAuditCache.set(tokenAddress, { ts: Date.now(), value }); return value;
  } catch (error) {
    const value = { holderDistribution: { known: false, reason: error.message, source: 'Solana RPC' }, creatorSignals: { known: false, warnings: [], reason: error.message } }; holderAuditCache.set(tokenAddress, { ts: Date.now(), value }); return value;
  }
}


async function checkLaunchBundle(pair, totalSupplyRaw) {
  try {
    const endpoint=process.env.SOLANA_RPC_HTTP;
    if(!endpoint)throw new Error('SOLANA_RPC_HTTP required for bundle evidence');
    const signatures=await rpcGuard.rpc(endpoint,'getSignaturesForAddress',[pair.pairAddress,{limit:25,commitment:'confirmed'}],{credits:1,cacheKey:'bundle-sigs:'+pair.pairAddress});
    if(!Array.isArray(signatures)||!signatures.length)throw new Error('pool signatures unavailable');
    const creationSlot=Math.min(...signatures.map(x=>Number(x.slot)).filter(Number.isFinite));
    if(!Number.isFinite(creationSlot))throw new Error('pool creation slot unavailable');
    const sameSlot=signatures.filter(x=>Number(x.slot)===creationSlot&&x.signature);
    if(!sameSlot.length)return {pass:true,reason:'No same-slot launch bundle evidence'};
    const requests=sameSlot.map((x,i)=>({jsonrpc:'2.0',id:i+1,method:'getTransaction',params:[x.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]}));
    const txs=await rpcGuard.batch(endpoint,requests,{credits:requests.length});
    const buyerAmounts=new Map();
    for(const tx of txs){
      if(!tx||Number(tx.slot)!==creationSlot)continue;
      const pre=new Map((tx.meta?.preTokenBalances||[]).filter(x=>x.mint===pair.address&&x.owner).map(x=>[x.owner,BigInt(x.uiTokenAmount?.amount||'0')]));
      const post=new Map((tx.meta?.postTokenBalances||[]).filter(x=>x.mint===pair.address&&x.owner).map(x=>[x.owner,BigInt(x.uiTokenAmount?.amount||'0')]));
      for(const [owner,amount] of post){const delta=amount-(pre.get(owner)||0n);if(delta>0n)buyerAmounts.set(owner,(buyerAmounts.get(owner)||0n)+delta);}
    }
    const total=BigInt(String(totalSupplyRaw||'0'));if(total<=0n)throw new Error('mint supply unavailable for bundle ratio');
    const acquired=[...buyerAmounts.values()].reduce((s,x)=>s+x,0n);
    const pct=Number(acquired*10000n/total)/100;
    const reject=buyerAmounts.size>=4&&pct>20;
    return {pass:!reject,reason:reject?'LAUNCH_BUNDLE_REJECT: >=4 same-slot buyers control >20% supply':'No launch bundle threshold breach',sameSlotBuyerWallets:buyerAmounts.size,sameSlotAcquiredSupplyPct:pct,creationSlot};
  }catch(error){return {pass:false,reason:'LAUNCH_BUNDLE_UNKNOWN: '+error.message};}
}

async function recordResearch(pair, security, analysis, decision, holders = null) {
  const row = {
    schemaVersion: 1, recordedAt: nowIso(), token: pair.baseToken?.address || pair.address || null,
    symbol: pair.baseToken?.symbol || pair.symbol || 'UNKNOWN', chainId: pair.chainId || null,
    pairAddress: pair.pairAddress || null, priceUsd: Number(pair.priceUsd || 0),
    liquidityUsd: Number(pair.liquidity?.usd || 0), volume24hUsd: Number(pair.volume?.h24 || 0),
    security: { pass: security?.pass === true, checked: security?.checked !== false && !!security, reason: security?.reason || 'not checked', buyTaxRate: security?.buyTaxRate ?? null, sellTaxRate: security?.sellTaxRate ?? null },
    networkFeeUsd: estimatedNetworkFeeUsd(pair.chainId), entryQuoteFallback: String(pair.chainId||'').toLowerCase()==='solana', quoteFallback: String(pair.chainId||'').toLowerCase()==='solana',
    score: analysis?.score ?? null, tier: analysis?.tier || 'UNSCORED',
    components: analysis?.components || {}, metrics: analysis?.metrics || {}, reasons: analysis?.reasons || [],
    narrativeFootprint: analyzeNarrativeFootprint(pair), paperLearning: summarizePaperLearning(portfolio.closedTrades),
    warnings: detectBasicMarketWarnings(pair), holderDistribution: holders?.holderDistribution || holders, creatorSignals: holders?.creatorSignals || null, decision
  };
  await fs.appendFile(CONFIG.RESEARCH_FILE, JSON.stringify(row) + '\n', 'utf8');
  if (['RESEARCH','WATCH'].includes(String(decision||'').toUpperCase()) && pair.pairAddress) {
    portfolio.researchTracked = portfolio.researchTracked || {};
    const token = String(pair.baseToken?.address || pair.address || pair.pairAddress);
    if (!portfolio.researchTracked[token]) portfolio.researchTracked[token] = {
      token, pairAddress: pair.pairAddress, chainId: pair.chainId, symbol: row.symbol,
      entryAt: Date.now(), entryPrice: row.priceUsd, score: row.score, tier: row.tier,
      security: row.security, intervalsLogged: []
    };
  }
}

async function auditSecurity(pair) {
  const key = pair.id;
  const cached = secCache.get(key);
  if (cached && Date.now() - cached.ts < 900000) return cached;

  if (pair.chainId === 'solana') {
    try {
      const r = await fetchJsonStrict(`https://api.rugcheck.xyz/v1/tokens/${pair.address}/report/summary`, 9000);
      const score = r.score ?? r.score_normalised ?? 0;
      const danger = (r.risks || []).find(x => (x.level || '').toLowerCase() === 'danger');
      const pass = !r.rugged && score <= 2000 && !danger;
      const reason = pass ? `RugCheck PASS (Score ${score})` : `RugCheck REJECT (rugged=${!!r.rugged}, score=${score}, danger=${danger?.name || 'none'})`;
      const out = { ts: Date.now(), pass, reason, buyTaxRate: 0, sellTaxRate: 0 };
      secCache.set(key, out);
      return out;
    } catch (e) {
      const out={ ts: Date.now(), pass: false, reason: `Skipped: Security API unreachable (RugCheck: ${e.message})` };secCache.set(key,out);return out;
    }
  } else if (CONFIG.EVM_CHAIN_IDS[pair.chainId]) {
    const id = CONFIG.EVM_CHAIN_IDS[pair.chainId];
    try {
      const gp = await fetchJsonStrict(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${pair.address}`, 9000);
      const d = gp?.result?.[pair.address.toLowerCase()];
      if (!d) { const out={ ts: Date.now(), pass: false, reason: 'GoPlus REJECT: Unindexed contract' };secCache.set(key,out);return out; }
      const bt = Number(d.buy_tax || 0), st = Number(d.sell_tax || 0);
      const pass = d.is_honeypot !== '1' && d.cannot_sell_all !== '1' && bt <= 0.05 && st <= 0.05;
      const reason = pass ? `GoPlus PASS (Tax ${(bt*100).toFixed(1)}%/${(st*100).toFixed(1)}%)` : `GoPlus REJECT (honey=${d.is_honeypot}, sellTax=${(st*100).toFixed(1)}%)`;
      const out = { ts: Date.now(), pass, reason };
      secCache.set(key, out);
      return out;
    } catch (e) {
      const out={ ts: Date.now(), pass: false, reason: `Skipped: Security API unreachable (GoPlus: ${e.message})` };secCache.set(key,out);return out;
    }
  }
  return { ts: Date.now(), pass: false, reason: 'Unsupported chain' };
}

async function syncPortfolioToCloudflare(){const secret=process.env.MEMERADAR_SYNC_SECRET;if(!secret){console.error('D1 sync skipped: missing secret');return false;}try{const headers={'Authorization':`Bearer ${secret}`,'Content-Type':'application/json'};const read=await fetch('https://memeradar-state-api.varmaabhi47.workers.dev/state',{headers,cache:'no-store'});if(!read.ok)throw Error('D1 read HTTP '+read.status);const current=await read.json();d1Version=Number(current.version??d1Version);const response=await fetch('https://memeradar-state-api.varmaabhi47.workers.dev/state',{method:'POST',headers,body:JSON.stringify({portfolio,version:d1Version})});const result=await response.json().catch(()=>({}));if(!response.ok||result.success===false){if(response.status===409)d1Version=Number(result.version||d1Version);throw Error(result.error||'D1 write HTTP '+response.status);}d1Version=Number(result.version??d1Version+1);console.log('D1 sync OK version '+d1Version);return true;}catch(e){console.error('D1 sync failed: '+e.message);process.exitCode=1;return false;}}

async function monitorResearchSnapshots(){
 const tracked=Object.values(portfolio.researchTracked||{});if(!tracked.length)return;
 const targets=[5,15,30,60,240],now=Date.now();
 for(const item of tracked){
  const due=targets.filter(m=>now-Number(item.entryAt)>=m*60000&&!(item.intervalsLogged||[]).includes(m));
  if(!due.length)continue;
  try{
   const data=await fetchJsonStrict(`https://api.dexscreener.com/latest/dex/pairs/${item.chainId}/${item.pairAddress}`,10000);
   const pair=(data?.pairs||[]).find(x=>String(x.pairAddress||'').toLowerCase()===String(item.pairAddress).toLowerCase());
   if(!pair||!(Number(pair.priceUsd)>0&&Number(pair.liquidity?.usd)>0))throw Error('live pair mark/liquidity unavailable');
   for(const target of due){
    const row={schemaVersion:2,recordedAt:nowIso(),token:item.token,symbol:item.symbol,chainId:item.chainId,pairAddress:item.pairAddress,priceUsd:Number(pair.priceUsd),liquidityUsd:Number(pair.liquidity.usd),score:item.score,tier:item.tier,decision:'SNAPSHOT',researchIntervalMin:target,elapsedMinutes:(now-Number(item.entryAt))/60000,entryAt:new Date(item.entryAt).toISOString(),entryPrice:item.entryPrice,security:item.security,networkFeeUsd:estimatedNetworkFeeUsd(item.chainId),entryQuoteFallback:String(item.chainId||'').toLowerCase()==='solana',quoteFallback:String(item.chainId||'').toLowerCase()==='solana',source:'DexScreener live pair mark'};
    await fs.appendFile(CONFIG.RESEARCH_FILE,JSON.stringify(row)+'\n','utf8');item.intervalsLogged=[...(item.intervalsLogged||[]),target];
   }
  }catch(e){logDecision('RESEARCH_STALE',item.symbol,item.chainId,`snapshot poll failed; no mark recorded: ${e.message}`);}
 }
 for(const item of tracked){if(targets.every(m=>(item.intervalsLogged||[]).includes(m)))delete portfolio.researchTracked[item.token];}
 await saveState();
}

async function monitorPositions({ discover = false } = {}) {
  // 1. Refresh Open Positions
  const byChainPos = new Map();
  for (const pos of portfolio.openPositions) {
    if (!byChainPos.has(pos.chainId)) byChainPos.set(pos.chainId, new Set());
    byChainPos.get(pos.chainId).add(pos.pairAddress);
  }
  const livePosMap = new Map();
  for (const [chain, set] of byChainPos.entries()) {
    const addrs = Array.from(set);
    for (let i = 0; i < addrs.length; i += 30) {
      await sleep(220);
      const res = await fetchJsonStrict(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${addrs.slice(i, i + 30).join(',')}`);
      for (const p of (res?.pairs || [])) livePosMap.set(p.pairAddress.toLowerCase(), p);
    }
  }

  for (let i = portfolio.openPositions.length - 1; i >= 0; i--) {
    const pos = portfolio.openPositions[i];
    const lp = livePosMap.get(pos.pairAddress.toLowerCase());
    const currentLiquidityUsd=Number(lp?.liquidity?.usd||0);
    const livePrice=Number(lp?.priceUsd||0);
    if(!lp){
      pos.emergencyNoLiquidity=true;pos.dataStale=true;pos.dataStaleReason='Live pair disappeared from DexScreener; zero recoverable liquidity assumed, no quote fabricated.';
      logDecision('LIQUIDITY_EXIT',pos.symbol,pos.chainId,pos.dataStaleReason);
    }else if(!(livePrice>0)){
      if(currentLiquidityUsd<=0){pos.emergencyNoLiquidity=true;pos.dataStale=true;pos.dataStaleReason='Live pair has no price and zero liquidity; emergency zero-recovery exit.';}
      else{pos.dataStale=true;pos.dataStaleReason='Live price unavailable; no fabricated exit price used';logDecision('STALE',pos.symbol,pos.chainId,pos.dataStaleReason);continue;}
    }else{
      pos.dataStale=false;pos.dataStaleReason='';pos.lastPrice=livePrice;pos.emergencyNoLiquidity=currentLiquidityUsd<=0;
    }
    if(pos.lastPrice>pos.peakPrice)pos.peakPrice=pos.lastPrice;
    if(CONFIG.TRAIL_ARM_PCT>0&&((pos.peakPrice-pos.buyPrice)/pos.buyPrice)*100>=CONFIG.TRAIL_ARM_PCT)pos.trailArmed=true;

    const ex=pos.emergencyNoLiquidity?{effPrice:0,impactUsd:0,feeUsd:0,netProceeds:0,quoteSource:'no-live-liquidity',quoteFallback:true}:await calcPaperExit(pos,pos.lastPrice,currentLiquidityUsd);
    const pnlPct = ((ex.netProceeds - pos.costUsd) / pos.costUsd) * 100;
    const holdHrs = (Date.now() - pos.entryTime) / 3600000;
    const dropPeak = pos.peakPrice > 0 ? ((pos.peakPrice - pos.lastPrice) / pos.peakPrice) * 100 : 0;
    const liqDrop = pos.entryLiquidityUsd > 0 ? ((pos.entryLiquidityUsd - pos.lastLiquidityUsd) / pos.entryLiquidityUsd) * 100 : 0;

    const risk=pos.manualCloseRequested?{action:'EXIT_ALL',reason:'MANUAL_TELEGRAM_CLOSE',peakPrice:pos.peakPrice}:evaluatePositionRisk(pos,{markPrice:pos.lastPrice,liquidityUsd:currentLiquidityUsd,now:Date.now(),frictionRate:CONFIG.DEX_FEE_RATE,netPnlPctOverride:Number(pos.remainingCostUsd??pos.costUsd)>0?((ex.netProceeds-Number(pos.remainingCostUsd??pos.costUsd))/Number(pos.remainingCostUsd??pos.costUsd))*100:0});
    if(risk.peakPrice)pos.peakPrice=risk.peakPrice;pos.lastLiquidityUsd=currentLiquidityUsd;
    if(risk.action==='PARTIAL_EXIT'){
      const qty=Number(pos.remainingTokens??pos.tokens),sellQty=qty*.5,ex=await calcPaperExit({...pos,tokens:sellQty,remainingTokens:sellQty},pos.lastPrice,currentLiquidityUsd);
      const remCost=Number(pos.remainingCostUsd??pos.costUsd),soldCost=remCost*.5,realized=ex.netProceeds-soldCost;
      portfolio.cashUsd+=ex.netProceeds;pos.remainingTokens=qty-sellQty;pos.remainingCostUsd=remCost-soldCost;pos.realizedPartialPnlUsd=Number(pos.realizedPartialPnlUsd||0)+realized;pos.partialExitProceedsUsd=Number(pos.partialExitProceedsUsd||0)+ex.netProceeds;pos.partialFeesImpactUsd=Number(pos.partialFeesImpactUsd||0)+ex.feeUsd+ex.impactUsd;pos.partialTpDone=true;pos.breakevenStopNetPct=2;
      pos.partialExits=[...(pos.partialExits||[]),{at:Date.now(),tokensSold:sellQty,proceedsUsd:ex.netProceeds,allocatedCostUsd:soldCost,realizedPnlUsd:realized,quoteSource:ex.quoteSource,quoteFallback:!!ex.quoteFallback,reason:'PARTIAL_TP_40'}];
      await appendCsv({symbol:pos.symbol,chainId:pos.chainId,entryTime:pos.entryTime,exitTime:Date.now(),buyPrice:pos.buyPrice,sellPrice:ex.effPrice,tokensBought:pos.tokens,tokensSold:sellQty,remainingTokens:pos.remainingTokens,costUsd:soldCost,entryLiquidityUsd:pos.entryLiquidityUsd,exitValueUsd:ex.netProceeds,feesImpactUsd:ex.feeUsd+ex.impactUsd,netPnlUsd:realized,netPnlPct:soldCost?realized/soldCost*100:0,realizedPartialPnlUsd:realized,quoteFallback:!!ex.quoteFallback,entryQuoteFallback:!!pos.entryQuoteFallback,exitReason:'PARTIAL_TP_40'});
      logDecision('PARTIAL_SELL',pos.symbol,pos.chainId,'50% sold at +40% net; runner stop +2% net');await sendTelegram(`PARTIAL TP ${pos.symbol}: sold half; realized $${realized.toFixed(2)}; remaining ${pos.remainingTokens.toFixed(4)}`);
    }else if(risk.action==='EXIT_ALL'){
      const qty=Number(pos.remainingTokens??pos.tokens),ex=pos.emergencyNoLiquidity?{effPrice:0,impactUsd:0,feeUsd:0,netProceeds:0,quoteSource:'no-live-liquidity',quoteFallback:true}:await calcPaperExit({...pos,tokens:qty,remainingTokens:qty},pos.lastPrice,currentLiquidityUsd),remCost=Number(pos.remainingCostUsd??pos.costUsd),pnl=Number(pos.realizedPartialPnlUsd||0)+ex.netProceeds-remCost,totalCost=Number(pos.originalCostUsd??pos.costUsd);
      portfolio.cashUsd+=ex.netProceeds;const trade={id:'tr_'+Date.now(),symbol:pos.symbol,chainId:pos.chainId,address:pos.address,entryTime:pos.entryTime,buyPrice:pos.buyPrice,tokensBought:pos.tokens,tokensSold:qty,remainingTokens:0,costUsd:totalCost,entryLiquidityUsd:pos.entryLiquidityUsd,exitTime:Date.now(),sellPrice:ex.effPrice,exitQuoteSource:ex.quoteSource,quoteFallback:!!ex.quoteFallback,exitValueUsd:Number(pos.partialExitProceedsUsd||0)+ex.netProceeds,finalExitValueUsd:ex.netProceeds,feesImpactUsd:Number(pos.buyFeeAndImpactUsd||0)+Number(pos.partialFeesImpactUsd||0)+ex.feeUsd+ex.impactUsd,realizedPartialPnlUsd:Number(pos.realizedPartialPnlUsd||0),partialExits:pos.partialExits||[],entryQuoteFallback:!!pos.entryQuoteFallback,netPnlUsd:pnl,netPnlPct:totalCost?pnl/totalCost*100:0,exitReason:risk.reason};
      portfolio.closedTrades.unshift(trade);portfolio.cooldowns[pos.pairId]=Date.now();if(['STOP_LOSS','LIQ_DROP_ENTRY','LIQ_DROP_CHECK'].includes(risk.reason))consecutiveRiskExits++;else{consecutiveRiskExits=0;if(portfolio.breaker)portfolio.breaker.triggeredLossCount=0;}portfolio.consecutiveRiskExits=consecutiveRiskExits;portfolio.openPositions.splice(i,1);await appendCsv(trade);logDecision('SOLD',pos.symbol,pos.chainId,`[${risk.reason}] PnL ${pnl.toFixed(2)} USD`);await sendTelegram(`AUTO-SELL [${risk.reason}] ${pos.symbol}: net $${pnl.toFixed(2)} incl partials; fallback ${!!ex.quoteFallback}`);
    }else if(risk.action==='HOLD_STALE'){pos.dataStale=true;pos.dataStaleReason=risk.reason;}
  }

  // 2. Discovery is a separate 3-minute loop; fast position monitor never scans feeds.
  if (discover && portfolio.openPositions.length < CONFIG.MAX_OPEN_POSITIONS && portfolio.cashUsd > 0) {
    const items = await fetchJsonStrict(CONFIG.FEED_URL);
    const byChain = new Map();
    for (const it of (items || [])) {
      const c = (it.chainId || '').toLowerCase();
      if (!CONFIG.SUPPORTED_CHAINS.includes(c)) continue;
      if (CONFIG.CHAIN_FILTER !== 'all' && c !== CONFIG.CHAIN_FILTER) continue;
      if (!it.tokenAddress) continue;
      if (!byChain.has(c)) byChain.set(c, new Set());
      byChain.get(c).add(it.tokenAddress);
    }

    const queuedMints = [...eventMintQueue];
    if (queuedMints.length) { if (!byChain.has('solana')) byChain.set('solana', new Set()); for (const mint of queuedMints) byChain.get('solana').add(mint); }
    const best = new Map();
    for (const [chain, set] of byChain.entries()) {
      const addrs = Array.from(set);
      for (let i = 0; i < addrs.length; i += 30) {
        await sleep(250);
        const batch = await fetchJsonStrict(`https://api.dexscreener.com/tokens/v1/${chain}/${addrs.slice(i, i + 30).join(',')}`);
        for (const p of (batch || [])) {
          if (!p.baseToken?.address || !Number(p.priceUsd)) continue;
          const key = `${chain}:${p.baseToken.address.toLowerCase()}`;
          const liq = Number(p.liquidity?.usd || 0);
          if (!best.has(key) || liq > Number(best.get(key).liquidity?.usd || 0)) best.set(key, p);
        }
      }
    }

    const held = new Set(portfolio.openPositions.map(x => x.pairId));
    let secChecks = 0;
    for (const [key, p] of best.entries()) {
      if (p.baseToken?.address) eventMintQueue.delete(String(p.baseToken.address));
      if (portfolio.openPositions.length >= CONFIG.MAX_OPEN_POSITIONS || portfolio.cashUsd <= 0) break;
      if (held.has(key)) continue;
      if (Date.now() - (portfolio.cooldowns[key] || 0) < CONFIG.COOLDOWN_MINS * 60000) continue;

      const liq = Number(p.liquidity?.usd || 0);
      portfolio.lastLiquidityByPair = portfolio.lastLiquidityByPair || {};
      const priorLiq = Number(portfolio.lastLiquidityByPair[key] || 0);
      if (priorLiq > 0) p.previousLiquidityUsd = priorLiq;
      portfolio.firstLiquidityByPair = portfolio.firstLiquidityByPair || {};
      if (!(Number(portfolio.firstLiquidityByPair[key]) > 0) && liq > 0) portfolio.firstLiquidityByPair[key] = liq;
      const firstLiq = Number(portfolio.firstLiquidityByPair[key] || liq);
      if (firstLiq > 0 && liq < firstLiq * 0.95) { await recordResearch(p,{pass:false,checked:false,reason:'Liquidity declined >5% from first observed snapshot'},{score:null,tier:'REJECT',components:{},metrics:{firstLiquidityUsd:firstLiq,currentLiquidityUsd:liq},reasons:['liquidity decay >5%']},'REJECT'); logDecision('REJECT',p.baseToken.symbol,p.chainId,'liquidity decay >5% since first observed'); continue; }
      portfolio.lastLiquidityByPair[key] = liq;
      const prefilter = evaluateDiscoveryPrefilter(p, CONFIG);
      if (!prefilter.pass) {
        await recordResearch(p, { pass: false, checked: false, reason: 'Not security-audited: rejected by inexpensive discovery prefilter' },
          { score: null, tier: 'PREFILTER_REJECT', components: {}, metrics: prefilter.metrics, reasons: prefilter.reasons },
          'PREFILTER_REJECT');
        logDecision('PREFILTER', p.baseToken.symbol, p.chainId, prefilter.reasons.join('; '));
        continue;
      }

      if (secChecks >= 12) break;
      secChecks++;
      await sleep(250);
      const pairObj = { id: key, chainId: p.chainId.toLowerCase(), address: p.baseToken.address };
      const sec = await auditSecurity(pairObj);
      const intelligence = scoreCandidate(p, sec);
      const holders = pairObj.chainId === 'solana' ? await inspectSolanaHolders(pairObj.address, p.pairAddress) : { holderDistribution: { known: false, reason: 'holder RPC not implemented for this chain' }, creatorSignals: { known: false, warnings: [], reason: 'Solana-only creator analysis' } };
      const holderData=holders.holderDistribution,creatorData=holders.creatorSignals;
      if(pairObj.chainId==='solana'){const gates=evaluateSolanaHardSecurityGates({mintAuthority:creatorData?.mintAuthority,freezeAuthority:creatorData?.freezeAuthority,holderDistribution:holderData,creatorSignals:creatorData});if(!gates.pass){intelligence.tier='REJECT';intelligence.hardReject=true;intelligence.reasons.push(...gates.reasons);}}
      await recordResearch(p, sec, intelligence, intelligence.tier, holders);
      if (!sec.pass || intelligence.tier !== 'RESEARCH') {
        logDecision('SKIPPED', p.baseToken.symbol, pairObj.chainId,
          `V5 ${intelligence.score}/100 [${intelligence.tier}] ${[...intelligence.reasons, ...detectBasicMarketWarnings(p)].join('; ') || sec.reason}`);
        continue;
      }
      if(pairObj.chainId==='solana'){
        const bundle=await checkLaunchBundle({pairAddress:p.pairAddress,address:p.baseToken.address},holderData?.totalSupplyRaw);
        if(!bundle.pass){intelligence.tier='REJECT';intelligence.hardReject=true;intelligence.reasons.push(bundle.reason);logDecision('REJECT',p.baseToken.symbol,'solana',bundle.reason);await recordResearch(p,sec,intelligence,'REJECT',holders);continue;}
      }

      if (portfolio.autoTradeEnabled === false || process.env.DRY_RUN === 'true' || Number(portfolio.breaker?.pauseUntil || 0) > Date.now()) {
        logDecision('PAUSED', p.baseToken.symbol, pairObj.chainId, portfolio.breaker?.reason || 'new entries disabled');
        continue;
      }
      const equityUsd=portfolio.cashUsd+portfolio.openPositions.reduce((sum,x)=>sum+Number(x.lastPrice||x.buyPrice)*Number(x.remainingTokens??x.tokens),0);
      const entryFee=estimatedNetworkFeeUsd(pairObj.chainId);const usableCash=Math.max(0,portfolio.cashUsd-entryFee);const smartMoneySignal=!!portfolio.smartMoneySignals?.[String(p.baseToken.address)];const sizeUsd=calculatePositionSize({equityUsd,poolLiquidityUsd:liq,score:intelligence.score,cashUsd:usableCash,tier:intelligence.tier,smartMoneyConfluence:smartMoneySignal});if(!(sizeUsd>0)){logDecision('SKIPPED',p.baseToken.symbol,pairObj.chainId,'position size below usable cash/liquidity cap');continue;}const ex=await calcPaperEntry(sizeUsd,p,sec,holderData?.decimals);const totalCost=sizeUsd+entryFee;portfolio.cashUsd-=totalCost;
      portfolio.openPositions.unshift({
        id: 'pos_' + Date.now(), pairId: key, chainId: pairObj.chainId, pairAddress: p.pairAddress,
        address: p.baseToken.address, symbol: p.baseToken.symbol.toUpperCase(), name: p.baseToken.name || p.baseToken.symbol,
        entryTime: Date.now(), entrySpotPrice: Number(p.priceUsd), buyPrice: ex.effPrice, tokens: ex.tokens, tokenDecimals: holderData?.decimals ?? null,
        costUsd:totalCost,originalCostUsd:totalCost,remainingCostUsd:totalCost,remainingTokens:ex.tokens,partialTpDone:false,realizedPartialPnlUsd:0,partialExitProceedsUsd:0,partialExits:[],buyFeeAndImpactUsd:ex.feeUsd+ex.impactUsd,entryLiquidityUsd:liq,buyTaxRate:Number(sec.buyTaxRate||0),sellTaxRate:Number(sec.sellTaxRate||0),entryQuoteSource:ex.quoteSource,entryQuoteFallback:!!ex.quoteFallback,
        lastPrice: Number(p.priceUsd), lastLiquidityUsd: liq, peakPrice: Number(p.priceUsd), trailArmed: false, securitySummary: sec.reason
      });
      held.add(key);
      logDecision('BOUGHT',p.baseToken.symbol,pairObj.chainId,`${sizeUsd.toFixed(2)} @ ${ex.effPrice} | Liq ${Math.round(liq).toLocaleString()} | ${sec.reason}`);
      await sendTelegram(`AUTO-BUY: ${p.baseToken.symbol} (${pairObj.chainId.toUpperCase()})\nPrice: $${ex.effPrice} | Tokens: ${ex.tokens.toFixed(2)}\nCost: ${sizeUsd.toFixed(2)} | Liq: ${Math.round(liq).toLocaleString()}\nSecurity: ${sec.reason}`);
    }
  }

  portfolio.rpcTelemetry = rpcGuard.telemetry();
  portfolio.edgeProof = computeEdgeProof(portfolio.closedTrades || []);
  lastPollIso = nowIso();
  lastError = '';
  await saveState();
  await syncPortfolioToCloudflare();

  if (Date.now() - lastHourlySummaryMs >= 3600000) {
    lastHourlySummaryMs = Date.now();
    const real = portfolio.closedTrades.reduce((a, t) => a + t.netPnlUsd, 0);
    await sendTelegram(`HOURLY STATUS\nCash: $${portfolio.cashUsd.toFixed(2)} | Open: ${portfolio.openPositions.length}\nClosed Trades: ${portfolio.closedTrades.length} | Realized PnL: ${real >= 0 ? '+' : '-'}$${Math.abs(real).toFixed(2)}`);
  }
}

async function pollCycle(){await monitorPositions({discover:true});await updateCircuitBreaker();await monitorResearchSnapshots();}

// GitHub Actions mode: one scan per scheduled job; portfolio state is committed by workflow.

async function updateCircuitBreaker(){
 const now=Date.now(),equity=portfolio.cashUsd+portfolio.openPositions.reduce((sum,p)=>sum+Number(p.lastPrice||p.buyPrice)*Number(p.remainingTokens??p.tokens),0);
 const snaps=(portfolio.dailyEquitySnapshots||[]).filter(x=>now-Number(x.ts)<=86400000);snaps.push({ts:now,equity});portfolio.dailyEquitySnapshots=snaps;
 const base=Number(snaps[0]?.equity||equity),pnl=equity-base,old=portfolio.breaker||{},decision=checkCircuitBreakers({realizedUnrealizedPnlUsd:pnl,dailyStartingEquityUsd:base,now,breaker:old,consecutiveRiskExits});
 let pauseUntil=Number(old.pauseUntil||0),reason=old.reason||null;
 if(decision.dailyDrawdownPct<=-12&&!(reason==='DAILY_DRAWDOWN_12'&&pauseUntil>now)){pauseUntil=now+12*3600000;reason='DAILY_DRAWDOWN_12';}
 if(consecutiveRiskExits>=3&&Number(old.triggeredLossCount||0)<consecutiveRiskExits){pauseUntil=Math.max(pauseUntil,now+2*3600000);reason='CONSECUTIVE_RISK_EXITS';}
 if(pauseUntil<=now){pauseUntil=0;reason=null;}
 portfolio.breaker={pauseUntil,reason,dailyDrawdownPct:decision.dailyDrawdownPct,dailyStartingEquityUsd:base,equityUsd:equity,triggeredLossCount:consecutiveRiskExits,checkedAt:now};
 if(reason&&(!old.reason||old.pauseUntil<=now||old.reason!==reason))await sendTelegram(`CIRCUIT BREAKER: ${reason}\nDaily drawdown: ${decision.dailyDrawdownPct.toFixed(2)}%\nNew entries paused until ${new Date(pauseUntil).toISOString()}. Position monitor remains active.`);
}
async function pollTelegramCommands(){
 if(!CONFIG.TELEGRAM_BOT_TOKEN||!CONFIG.TELEGRAM_CHAT_ID)return;
 try{
  const data=await fetchJsonStrict(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramOffset+1}&timeout=0&allowed_updates=%5B%22message%22%5D`,8000);
  let updatesProcessed=false;for(const update of data.result||[]){telegramOffset=Math.max(telegramOffset,Number(update.update_id||0));portfolio.telegramOffset=telegramOffset;updatesProcessed=true;const msg=update.message;if(!msg)continue;
   if(String(msg.chat?.id)!==String(CONFIG.TELEGRAM_CHAT_ID)){console.warn('Ignored Telegram command from unauthorized chat.');continue;}
   const cmd=parseTelegramCommand(msg.text);if(!cmd)continue;
   if(cmd.command==='status'){const realized=portfolio.closedTrades.reduce((a,t)=>a+Number(t.netPnlUsd||0),0);await sendTelegram(`STATUS\nCash $${portfolio.cashUsd.toFixed(2)} • Open ${portfolio.openPositions.length} • Closed ${portfolio.closedTrades.length}\nRealized PnL $${realized.toFixed(2)}\nBreaker ${portfolio.breaker?.reason||'clear'}`);}
   else if(cmd.command==='positions'){await sendTelegram(portfolio.openPositions.length?portfolio.openPositions.map(p=>`${p.symbol} ${p.chainId}: ${Number(p.remainingTokens??p.tokens).toFixed(4)} tokens • partialTP ${!!p.partialTpDone}`).join('\n'):'No open positions.');}
   else if(cmd.command==='pause'){portfolio.autoTradeEnabled=false;await sendTelegram('New paper entries PAUSED. Position monitoring and exits remain active.');}
   else if(cmd.command==='resume'){portfolio.autoTradeEnabled=true;await sendTelegram('New paper entries RESUMED (unless circuit breaker is active).');}
   else if(cmd.command==='kill'){portfolio.autoTradeEnabled=false;for(const p of portfolio.openPositions)p.manualCloseRequested=true;await sendTelegram('KILL SWITCH: new entries disabled; open paper positions flagged for exit at next live monitor quote. No live swaps are enabled.');}
   else if(cmd.command==='close'){const p=portfolio.openPositions.find(x=>String(x.symbol).toUpperCase()===cmd.symbol);if(!p)await sendTelegram('No open position matches '+cmd.symbol+'.');else{p.manualCloseRequested=true;await sendTelegram('Close requested for '+p.symbol+'; next live monitor quote will evaluate exit.');}}
  }
  if(updatesProcessed){await saveState();await syncPortfolioToCloudflare();}
 }catch(e){console.error('Telegram command poll failed: '+e.message);}
}
async function persistentRunner(){
 let lastMonitor=0,lastDiscovery=0,lastResearch=0;
 while(true){
  try{await pollTelegramCommands();const now=Date.now();
   if(portfolio.openPositions.length&&now-lastMonitor>=CONFIG.MONITOR_SEC*1000){await monitorPositions({discover:false});lastMonitor=Date.now();}
   if(now-lastDiscovery>=CONFIG.DISCOVERY_SEC*1000){await updateCircuitBreaker();await monitorPositions({discover:true});lastDiscovery=Date.now();}
   if(now-lastResearch>=300000){await monitorResearchSnapshots();lastResearch=Date.now();}
  }catch(e){lastError=e?.message||String(e);console.error('Persistent runner error: '+lastError);await saveState();}
  await sleep(5000);
 }
}
async function main(){
 if(process.argv.includes('--dry-run')){
  try{await fs.access(CONFIG.PORTFOLIO_FILE);console.log('Existing bot portfolio file detected; dry run will not read or write its contents.');}catch(e){if(e.code!=='ENOENT')throw e;console.log('No local bot portfolio file; dry run will not initialize one.');}
  const feed=await fetchJsonStrict(CONFIG.FEED_URL);
  console.log(`DRY RUN OK: live discovery feed returned ${Array.isArray(feed)?feed.length:'non-array'} records.`);
  const secret=process.env.MEMERADAR_SYNC_SECRET;if(!secret)throw Error('D1 read check skipped: MEMERADAR_SYNC_SECRET is missing.');
  const read=await fetchJsonStrict('https://memeradar-state-api.varmaabhi47.workers.dev/state',8000,{Authorization:`Bearer ${secret}`});
  console.log(`D1 authenticated read OK | version ${Number(read.version||0)} | updated_at ${read.updated_at||'null'}`);
  console.log('Dry run made no buys, sells, local portfolio changes, or D1 writes.');return;
 }
 if(process.argv.includes('--telegram-test')){const ok=await sendTelegram('MEME.RADAR Telegram connection test. Paper-only.');if(!ok)throw Error('Telegram test failed');console.log('Telegram test message sent.');return;}
 if(process.argv.includes('--sync-check')){let raw;try{raw=await fs.readFile(CONFIG.PORTFOLIO_FILE,'utf8');}catch{throw Error('D1 sync-check requires an existing bot portfolio file; refusing to initialize/overwrite from defaults.');}const parsed=JSON.parse(raw);portfolio={...portfolio,...parsed};lastHourlySummaryMs=Number(parsed.lastHourlySummaryMs||0);consecutiveRiskExits=Number(parsed.consecutiveRiskExits||0);telegramOffset=Number(parsed.telegramOffset||0);const ok=await syncPortfolioToCloudflare();if(!ok)throw Error('D1 sync check failed');console.log(`D1 versioned sync check passed at version ${d1Version}.`);return;}
 await loadState();
 if(process.env.TELEGRAM_TEST==='true'){const ok=await sendTelegram('MEME.RADAR Telegram connection test. Paper-only.');if(!ok)process.exitCode=1;}
 if(process.env.RUN_MODE==='persistent'){console.log('Persistent mode: 12s position monitor / 180s discovery scanner.');await persistentRunner();return;}
 try{await pollCycle();failures=0;console.log('Completed one paper-trading scan.');}
 catch(err){failures++;lastError=err?.message||String(err);console.error('[ERROR] '+lastError);await saveState();process.exitCode=1;}
}

main().catch(err => {
  console.error(`[${nowIso()}] Fatal error: ${err?.stack || err}`);
  process.exitCode = 1;
});
