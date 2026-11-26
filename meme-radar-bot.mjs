#!/usr/bin/env node
/**
 * MEME.RADAR Path 2 — Persistent Paper-Trading Node.js Bot (Zero Simulation)
 * GitHub Actions mode: one paper-trading scan per scheduled run.
 *
 * Features:
 * - Polls live DexScreener feeds + enriches in 30-address batches
 * - Strict Liquidity & Sellability Gate + mandatory live RugCheck (Solana) / GoPlus (EVM)
 * - Realistic AMM impact (tradeUsd / (2 * liquidityUsd)) + 0.30% DEX fee on Buy & Sell
 * - V6 paper exits: -15% hard stop; trailing TP arms at +25% and trails 10% below peak; 45m time stop unless +10% was reached; existing liquidity emergency gates retained
 * - Saves state persistently to paper_portfolio.json (importable into Web UI!) & paper_trades.csv
 * - Sends instant Telegram receipts on every AUTO-BUY and AUTO-SELL + hourly summary
 */

import fs from 'node:fs/promises';
import { scoreCandidate, calculatePaperBuy, calculatePaperSell, detectBasicMarketWarnings, calculateTopHolderConcentration, analyzeCreatorSignals, summarizeCrossTokenClusters, evaluateDiscoveryPrefilter, calculateJupiterQuoteExit, analyzeNarrativeFootprint, summarizePaperLearning, evaluateSolanaHardSecurityGates } from './meme-radar-v5-intelligence.mjs';
import { evaluatePositionRisk, calculatePositionSize, checkCircuitBreakers, parseTelegramCommand, makeStateLock } from './meme-radar-v5-risk-engine.mjs';
import { RpcCreditGuard, SolanaEventListener, extractMintsFromTransaction, extractWalletTokenBuys, createSmartMoneyConfluence, computeEdgeProof } from './path2-runtime.mjs';
import { PaperExecutionAdapter, SolanaLiveExecutionAdapter } from './execution-adapter.mjs';
import { reconstructSolSwap } from './swap-reconstruction.mjs';

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
  TRAIL_ARM_PCT: 25, // aligned with V6 trailing take-profit arm
  COOLDOWN_MINS: 60,
  MIN_LIQUIDITY_USD: 75000,
  MIN_LIQ_FDV_PCT: 8,
  MIN_SELLS_1H: 10,
  MIN_VOLUME_24H: 50000,
  MIN_BUY_RATIO_PCT: 52,
  MIN_BUY_RATIO_1H_PCT: 52,
  MIN_BUY_RATIO_5M_PCT: 55,
  MIN_PAIR_AGE_MINUTES: 15,
  MAX_CHANGE_5M_PCT: 30,
  MAX_CHANGE_1H_PCT: 150,

  // Telegram & Persistence
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  PORTFOLIO_FILE: 'paper_portfolio.json',
  CSV_FILE: 'paper_trades.csv',
  RESEARCH_FILE: 'paper_research.jsonl'
};

function getSolanaRpcEndpoints() {
  return [process.env.SOLANA_RPC_URL, ...(process.env.SOLANA_RPC_FALLBACK_URLS || '').split(',')]
    .map(value => String(value || '').trim()).filter(Boolean);
}

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
  let localParsed=null,localExists=false;
  try{localParsed=JSON.parse(await fs.readFile(CONFIG.PORTFOLIO_FILE,'utf8'));localExists=true;}
  catch(error){if(error.code!=='ENOENT')throw new Error('Local portfolio file is unreadable; refusing to reset: '+error.message);}
  let parsed=null;
  const secret=process.env.MEMERADAR_SYNC_SECRET;
  if(secret){
    // D1 is authoritative whenever configured; local Git state is only a cache.
    const remote=await fetchJsonStrict('https://memeradar-state-api.varmaabhi47.workers.dev/state',8000,{Authorization:'Bearer '+secret});
    parsed=remote.portfolio||remote.state||null;d1Version=Number(remote.version||0);
    if(!parsed&&process.env.ALLOW_FRESH_PAPER_STATE==='true'&&localExists){parsed=localParsed;console.warn('D1 has no portfolio row; using local state only because fresh/bootstrap flag is explicitly enabled.');}
    if(!parsed)throw new Error('Authenticated D1 has no portfolio state; refusing to initialize or overwrite.');
    console.log('Loaded authoritative D1 portfolio version '+d1Version+'.');
  }else if(localExists)parsed=localParsed;
  else if(process.env.ALLOW_FRESH_PAPER_STATE==='true'){parsed={...portfolio};console.warn('Explicitly initializing a fresh paper portfolio without D1 sync.');}
  else throw new Error('No D1 secret or local paper portfolio. Set ALLOW_FRESH_PAPER_STATE=true only for an intentional fresh paper account.');
  if(!parsed||typeof parsed!=='object'||!Array.isArray(parsed.openPositions)||!Array.isArray(parsed.closedTrades))throw new Error('Portfolio state shape invalid; refusing to reset.');
  portfolio={...portfolio,...parsed};
  lastHourlySummaryMs=Number(parsed.lastHourlySummaryMs||0);consecutiveRiskExits=Number(parsed.consecutiveRiskExits||0);telegramOffset=Number(parsed.telegramOffset||0);
  await saveState();
  console.log(`[${nowIso()}] Loaded authoritative portfolio | Cash: $${Number(portfolio.cashUsd).toFixed(2)} | Open: ${portfolio.openPositions.length} | Closed: ${portfolio.closedTrades.length}`);
}

async function saveState() { return stateLock(async()=>{portfolio.lastHourlySummaryMs=lastHourlySummaryMs;portfolio.rpcTelemetry=rpcGuard.telemetry();portfolio.edgeProof=computeEdgeProof(portfolio.closedTrades||[]);const tmp=CONFIG.PORTFOLIO_FILE+'.tmp';await fs.writeFile(tmp,JSON.stringify(portfolio,null,2),'utf8');await fs.rename(tmp,CONFIG.PORTFOLIO_FILE);await fs.writeFile('audit-cache.json',JSON.stringify(Object.fromEntries(secCache)),'utf8');}); }

async function appendCsv(t) {
  let exists=true;try{await fs.access(CONFIG.CSV_FILE);}catch{exists=false;}
  if(!exists)await fs.writeFile(CONFIG.CSV_FILE,'EntryTime,ExitTime,Symbol,Chain,BuyPrice,TokensBought,CostUSD,EntryLiqUSD,SellPrice,ExitValueUSD,FeesImpactUSD,NetPnLUSD,NetPnLPct,ExitReason,TokensSold,RemainingTokens,RealizedPartialPnLUSD,QuoteFallback,EntryQuoteFallback,EntrySlippagePct,ExitSlippagePct\n','utf8');
  else {
    const existing=await fs.readFile(CONFIG.CSV_FILE,'utf8'),rows=existing.split('\n');
    if(rows[0]&&!rows[0].includes('EntrySlippagePct')) {
      rows[0]+=',EntrySlippagePct,ExitSlippagePct';
      for(let row=1;row<rows.length;row++)if(rows[row])rows[row]+=',,';
      await fs.writeFile(CONFIG.CSV_FILE,rows.join('\n'),'utf8');
    }
  }
  const line=[new Date(t.entryTime).toISOString(),new Date(t.exitTime).toISOString(),t.symbol,t.chainId,t.buyPrice,t.tokensBought,t.costUsd.toFixed(2),Math.round(t.entryLiquidityUsd),t.sellPrice,t.exitValueUsd.toFixed(2),t.feesImpactUsd.toFixed(2),t.netPnlUsd.toFixed(2),t.netPnlPct.toFixed(2),t.exitReason,t.tokensSold??t.tokensBought,t.remainingTokens??0,t.realizedPartialPnlUsd??0,!!t.quoteFallback,!!t.entryQuoteFallback,t.entrySlippagePct??'',t.exitSlippagePct??''].join(',')+'\n';
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

function telegramTime(timestamp = Date.now()) {
  const value = Number(timestamp);
  return Number.isFinite(value) && value > 0 ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) + ' IST' : 'time unavailable';
}
function usd(value) {
  const n = Number(value);
  return Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : 'unavailable';
}
function signedUsd(value) {
  const n = Number(value);
  return Number.isFinite(n) ? (n >= 0 ? '+' : '-') + usd(Math.abs(n)) : 'unavailable';
}
function formatBuyReceipt(position, details) {
  const p = position || {}, d = details || {};
  return ['🟢 MEME.RADAR V6 • PAPER BUY',
    'Coin: ' + (p.name || p.symbol || 'Unknown coin') + ' (' + (p.symbol || '—') + ')',
    'Chain: ' + String(p.chainId || 'unknown').toUpperCase(),
    'Bought at: ' + telegramTime(p.entryTime),
    'Entry price: ' + usd(d.price) + ' per token',
    'Tokens acquired: ' + Number(d.tokens || 0).toLocaleString('en-US', { maximumFractionDigits: 8 }),
    'Total cost: ' + usd(d.costUsd),
    'Pool liquidity: ' + usd(d.liquidityUsd),
    'Selection: ' + (d.signal?.source === 'legacy-dexscreener-selection' ? 'legacy DexScreener discovery' : (Array.isArray(d.signal && d.signal.walletAddresses) ? d.signal.walletAddresses.length + ' tracked wallet(s)' : 'verified signal')),
    'Contract: ' + (p.address || 'unavailable'),
    'Security: ' + (d.security || 'live audit passed'),
    'Mode: PAPER ONLY'].join('\n');
}
function formatSellReceipt(trade, details) {
  const t = trade || {}, d = details || {}, final = d.final === true;
  return [(final ? '🔴' : '🟠') + ' MEME.RADAR V6 • PAPER ' + (final ? 'SELL' : 'PARTIAL SELL'),
    'Coin: ' + (t.name || t.symbol || 'Unknown coin') + ' (' + (t.symbol || '—') + ')',
    'Chain: ' + String(t.chainId || 'unknown').toUpperCase(),
    'Sold at: ' + telegramTime(final ? t.exitTime : Date.now()),
    'Exit price: ' + usd(d.price) + ' per token',
    'Tokens sold: ' + Number(d.tokensSold || 0).toLocaleString('en-US', { maximumFractionDigits: 8 }),
    (final ? 'Final exit proceeds: ' : 'Sale proceeds: ') + usd(d.proceedsUsd),
    'Allocated buy cost: ' + usd(d.allocatedCostUsd),
    'This exit realized P&L: ' + signedUsd(d.realizedPnlUsd),
    (final ? 'Lifetime trade P&L (incl. partial sells): ' + signedUsd(t.netPnlUsd) : 'Remaining tokens: ' + Number(d.remainingTokens || 0).toLocaleString('en-US', { maximumFractionDigits: 8 })),
    'Reason: ' + (d.reason || t.exitReason || 'strategy exit'),
    'Contract: ' + (t.address || 'unavailable'),
    'Mode: PAPER ONLY'].join('\n');
}
function formatHourlyOverview(startMs, endMs) {
  const start = Number(startMs) || endMs - 3600000;
  const buys = (portfolio.decisionLog || []).filter(x => x.ts >= start && x.ts <= endMs && x.action === 'BOUGHT');
  const sells = (portfolio.decisionLog || []).filter(x => x.ts >= start && x.ts <= endMs && ['SOLD','PARTIAL_SELL'].includes(x.action));
  const closedTrades = portfolio.closedTrades || [];
  const closed = closedTrades.filter(t => Number(t.exitTime || 0) >= start && Number(t.exitTime || 0) <= endMs);
  const finalExitPnl = closed.reduce((sum,t) => {
    const partialCost = (t.partialExits || []).reduce((s,x) => s + Number(x.allocatedCostUsd || 0), 0);
    const remainingCost = Math.max(0, Number(t.costUsd || 0) - partialCost);
    return sum + Number(t.finalExitValueUsd ?? t.exitValueUsd ?? 0) - remainingCost;
  }, 0);
  const partialClosed = closedTrades.reduce((sum,t) => sum + (t.partialExits || []).filter(x => Number(x.at || 0) >= start && Number(x.at || 0) <= endMs).reduce((s,x) => s + Number(x.realizedPnlUsd || 0), 0), 0);
  const partialOpen = (portfolio.openPositions || []).reduce((sum,p) => sum + (p.partialExits || []).filter(x => Number(x.at || 0) >= start && Number(x.at || 0) <= endMs).reduce((s,x) => s + Number(x.realizedPnlUsd || 0), 0), 0);
  const realizedClosed = finalExitPnl + partialClosed;
  const allTime = (portfolio.closedTrades || []).reduce((sum,t) => sum + Number(t.netPnlUsd || 0), 0) + (portfolio.openPositions || []).reduce((sum,p) => sum + Number(p.realizedPartialPnlUsd || 0), 0);
  const unrealized = (portfolio.openPositions || []).reduce((sum,p) => sum + Number(p.lastPrice || p.buyPrice || 0) * Number(p.remainingTokens ?? p.tokens ?? 0) - Number((p.remainingCostUsd ?? p.costUsd) || 0), 0);
  const buyLines = buys.slice(0,8).map(x => '• BUY ' + x.symbol + ' ' + String(x.chainId || '').toUpperCase() + ' — ' + x.reason);
  const sellLines = sells.slice(0,8).map(x => '• ' + (x.action === 'PARTIAL_SELL' ? 'PARTIAL SELL ' : 'SELL ') + x.symbol + ' ' + String(x.chainId || '').toUpperCase() + ' — ' + x.reason);
  const openLines = portfolio.openPositions.slice(0,10).map(p => '• ' + (p.name || p.symbol) + ' (' + p.symbol + ') | ' + Number(p.remainingTokens ?? p.tokens ?? 0).toLocaleString('en-US',{maximumFractionDigits:6}) + ' tokens | mark ' + usd(p.lastPrice || p.buyPrice) + ' | unrealized ' + signedUsd(Number(p.lastPrice || p.buyPrice) * Number(p.remainingTokens ?? p.tokens ?? 0) - Number((p.remainingCostUsd ?? p.costUsd) || 0)));
  return ['📊 MEME.RADAR V6 • HOURLY OVERVIEW',
    'Period: ' + telegramTime(start) + ' → ' + telegramTime(endMs),
    'Activity: ' + buys.length + ' buy(s) • ' + sells.length + ' sell event(s) • ' + portfolio.openPositions.length + ' open position(s)',
    'Cash: ' + usd(portfolio.cashUsd),
    'Realized P&L this hour: ' + signedUsd(realizedClosed + partialOpen),
    'Realized P&L all time: ' + signedUsd(allTime),
    'Open-position mark-to-market (rough, not realized): ' + signedUsd(unrealized),
    'Closed trades: ' + portfolio.closedTrades.length,
    '', 'BUYS', ...(buyLines.length ? buyLines : ['No buys recorded in this period.']),
    '', 'SELLS', ...(sellLines.length ? sellLines : ['No sells recorded in this period.']),
    '', 'OPEN POSITIONS', ...(openLines.length ? openLines : ['None']),
    'Paper trading only • No live swaps'].join('\n');
}
async function sendTelegram(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.error(`[${nowIso()}] Telegram not configured: missing bot token or chat ID.`);
    return false;
  }
  const message = String(text || '');
  const chunks = message.match(/[\\s\\S]{1,3800}/g) || [''];
  try {
    for (const chunk of chunks) {
      const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: chunk, disable_web_page_preview: true })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${res.status}`);
      console.log(`[${nowIso()}] Telegram message delivered (message_id: ${data.result?.message_id ?? 'accepted'}).`);
    }
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

const paperExecution = new PaperExecutionAdapter({ quoteEntry: calcPaperEntry, quoteExit: calcPaperExit });
const liveExecutionAdapter = new SolanaLiveExecutionAdapter();

function calcSell(tokens, price, liq) {
  const result = calculatePaperSell(tokens, price, liq, CONFIG.DEX_FEE_RATE);
  return { effPrice: result.effectivePrice, impactUsd: result.impactUsd, impactRate: result.impactRate, feeUsd: result.feeUsd, netProceeds: result.netProceeds, model: result.model };
}

async function inspectSolanaHolders(tokenAddress, pairAddress = null) {
  for(const [mint,row] of holderAuditCache)if(Date.now()-row.ts>=900000)holderAuditCache.delete(mint);
  const cachedAudit = holderAuditCache.get(tokenAddress);
  if (cachedAudit && Date.now() - cachedAudit.ts < 900000) return cachedAudit.value;
  const endpoints = getSolanaRpcEndpoints();
  const rpc = (method, params) => rpcGuard.rpc(endpoints, method, params, { credits: 1, cacheKey: 'solana:' + method + ':' + JSON.stringify(params) });
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
    const tokenProgramId=String(mintInfo?.value?.owner||'');
    const tokenExtensions=Array.isArray(info.extensions)?info.extensions.map(x=>String(x.extension||x.type||'')):null;
    const mintAuthority = info.mintAuthority || null;
    const freezeAuthority = info.freezeAuthority || null;
    let authoritySignatureCount = null;
    if (mintAuthority) {
      try {
        const signatures = await rpc('getSignaturesForAddress', [mintAuthority, { limit: 25, commitment: 'confirmed' }], 5);
        authoritySignatureCount = Array.isArray(signatures) ? signatures.length : null;
      } catch (error) { throw new Error('creatorSignals authority signature audit failed: ' + error.message); }
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
    creatorSignals.tokenProgramId=tokenProgramId;creatorSignals.tokenExtensions=tokenExtensions;
    const currentObservation = { token: tokenAddress, creatorSignals };
    const relatedClusters = summarizeCrossTokenClusters([...priorRows, currentObservation])
      .filter(cluster => cluster.tokens.includes(tokenAddress));
    creatorSignals.crossTokenClusters = relatedClusters;
    creatorSignals.crossTokenClusterCount = relatedClusters.length;
    creatorSignals.crossTokenTokensObserved = [...new Set(relatedClusters.flatMap(cluster => cluster.tokens))].length;
    const value = { holderDistribution, creatorSignals }; holderAuditCache.set(tokenAddress, { ts: Date.now(), value }); return value;
  } catch (error) {
    const reason = String(error?.message || error);
    console.error('RPC_AUDIT_INCOMPLETE token=' + tokenAddress + ' reason=' + reason);
    return { holderDistribution: { known: false, reason, source: 'Solana RPC' }, creatorSignals: { known: false, warnings: [], reason } };
  }
}


async function checkLaunchBundle(pair, totalSupplyRaw) {
  try {
    const endpoints=getSolanaRpcEndpoints();
    if(!endpoints.length)throw new Error('SOLANA_RPC_URL is not configured');
    const signatures=await rpcGuard.rpc(endpoints,'getSignaturesForAddress',[pair.pairAddress,{limit:25,commitment:'confirmed'}],{credits:1,cacheKey:'bundle-sigs:'+pair.pairAddress});
    if(!Array.isArray(signatures)||!signatures.length)throw new Error('pool signatures unavailable');
    const oldest=signatures[signatures.length-1];
    if(!oldest?.signature)throw new Error('oldest pool signature unavailable');
    const creation=await rpcGuard.rpc(endpoints,'getTransaction',[oldest.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}],{credits:1,cacheKey:'bundle-create-tx:'+oldest.signature});
    const creationLogs=creation?.meta?.logMessages||[];
    if(!creation||!creationLogs.some(line=>/initialize.*pool|init.*pool|create.*pool|migrat/i.test(line)))return {pass:false,reason:'LAUNCH_BUNDLE_UNKNOWN: pool creation not found in latest 25 signatures'};
    const creationSlot=Number(creation.slot);
    const sameSlot=signatures.filter(x=>Number(x.slot)===creationSlot&&x.signature&&x.signature!==oldest.signature);
    const requests=sameSlot.map((x,i)=>({jsonrpc:'2.0',id:i+1,method:'getTransaction',params:[x.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]}));
    const txs=requests.length?await rpcGuard.batch(endpoints[0],requests,{credits:requests.length}):[];
    txs.push(creation);
    const buyerAmounts=new Map();
    for(const tx of txs){
      if(!tx||Number(tx.slot)!==creationSlot)continue;
      const aggregate=rows=>{const map=new Map();for(const x of rows||[]){if(x.mint!==pair.address||!x.owner)continue;const amount=BigInt(x.uiTokenAmount?.amount||'0');map.set(x.owner,(map.get(x.owner)||0n)+amount);}return map;};
      const pre=aggregate(tx.meta?.preTokenBalances),post=aggregate(tx.meta?.postTokenBalances);
      for(const [owner,amount] of post){const delta=amount-(pre.get(owner)||0n);if(delta>0n)buyerAmounts.set(owner,(buyerAmounts.get(owner)||0n)+delta);}
    }
    const total=BigInt(String(totalSupplyRaw||'0'));if(total<=0n)throw new Error('mint supply unavailable for bundle ratio');
    const acquired=[...buyerAmounts.values()].reduce((sum,x)=>sum+x,0n),pct=Number(acquired*10000n/total)/100;
    const reject=buyerAmounts.size>=4&&pct>20;
    return {pass:!reject,reason:reject?'LAUNCH_BUNDLE_REJECT: >=4 same-slot buyers control >20% supply':'No launch bundle threshold breach',sameSlotBuyerWallets:buyerAmounts.size,sameSlotAcquiredSupplyPct:pct,creationSlot};
  }catch(error){return {pass:false,reason:'LAUNCH_BUNDLE_UNKNOWN: '+error.message};}
}

async function recordResearch(pair, security, analysis, decision, holders = null) {
  if (Number(pair?.liquidity?.usd) === 0) {
    portfolio.skippedZeroLiquidityPairs = Number(portfolio.skippedZeroLiquidityPairs || 0) + 1;
    console.info('RESEARCH_SKIP_ZERO_LIQUIDITY pair=' + String(pair?.pairAddress || 'unknown') + ' total=' + portfolio.skippedZeroLiquidityPairs);
    return;
  }
  const signal=portfolio.smartMoneySignals?.[String(pair.baseToken?.address||pair.address||'')],signalAt=Number(signal?.at||signal?.latest||0),recentSignal=['worker-gated','standard-wss-wallet-events'].includes(signal?.source)&&signalAt>0&&Date.now()-signalAt<=3*60*1000;
  const row = {
    schemaVersion: 1, recordedAt: nowIso(), token: pair.baseToken?.address || pair.address || null,
    symbol: pair.baseToken?.symbol || pair.symbol || 'UNKNOWN', chainId: pair.chainId || null,
    pairAddress: pair.pairAddress || null, priceUsd: Number(pair.priceUsd || 0),
    liquidityUsd: Number(pair.liquidity?.usd || 0), volume24hUsd: Number(pair.volume?.h24 || 0),
    security: { pass: security?.pass === true, checked: security?.checked !== false && !!security, reason: security?.reason || 'not checked', buyTaxRate: security?.buyTaxRate ?? null, sellTaxRate: security?.sellTaxRate ?? null },
    networkFeeUsd: estimatedNetworkFeeUsd(pair.chainId), entryQuoteFallback: String(pair.chainId||'').toLowerCase()==='solana', quoteFallback: String(pair.chainId||'').toLowerCase()==='solana',
    score: analysis?.score ?? null, tier: analysis?.tier || 'UNSCORED', smartMoneyConfluence: recentSignal, smartWallets: recentSignal?(portfolio.smartMoneySignals?.[String(pair.baseToken?.address||pair.address||'')]?.walletAddresses||[]):[],
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
      security: row.security, smartMoneyConfluence: row.smartMoneyConfluence, smartWallets: row.smartWallets||[], intervalsLogged: []
    };
    else { portfolio.researchTracked[token].smartMoneyConfluence=!!row.smartMoneyConfluence; portfolio.researchTracked[token].smartWallets=row.smartWallets||[]; portfolio.researchTracked[token].score=row.score; portfolio.researchTracked[token].tier=row.tier; }
  }
}

async function auditSecurity(pair) {
  for(const [oldKey,row] of secCache)if(Date.now()-Number(row.ts||0)>=900000)secCache.delete(oldKey);
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

async function syncPortfolioToCloudflare(){const secret=process.env.MEMERADAR_SYNC_SECRET;if(!secret){console.error('D1 sync skipped: missing secret');return false;}try{const headers={'Authorization':`Bearer ${secret}`,'Content-Type':'application/json'};const read=await fetch('https://memeradar-state-api.varmaabhi47.workers.dev/state',{headers,cache:'no-store'});if(!read.ok)throw Error('D1 read HTTP '+read.status);const current=await read.json();d1Version=Number(current.version??d1Version);const response=await fetch('https://memeradar-state-api.varmaabhi47.workers.dev/state',{method:'POST',headers,body:JSON.stringify({portfolio,version:d1Version,updated_at:current.updated_at??null})});const result=await response.json().catch(()=>({}));if(!response.ok||result.success===false){if(response.status===409)d1Version=Number(result.version||d1Version);throw Error(result.error||'D1 write HTTP '+response.status);}d1Version=Number(result.version??d1Version+1);console.log('D1 sync OK version '+d1Version);return true;}catch(e){console.error('D1 sync failed: '+e.message);process.exitCode=1;return false;}}

async function publishV6Gate(mint,passed,reasons=[]){
  const secret=process.env.MEMERADAR_SYNC_SECRET;if(!secret){console.warn('V6 gate evidence not published: MEMERADAR_SYNC_SECRET missing');return false;}
  const base=(process.env.MEMERADAR_WORKER_URL||'https://memeradar-state-api.varmaabhi47.workers.dev').replace(/\/$/,'');
  try{const res=await fetch(base+'/v6-gates',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+secret},body:JSON.stringify({mint,passed:!!passed,reasons})});const body=await res.json().catch(()=>({}));if(!res.ok||body.ok!==true){console.error('V6 gate evidence rejected HTTP '+res.status+': '+JSON.stringify(body).slice(0,300));return false;}return true;}catch(error){console.error('V6 gate evidence publish failed: '+error.message);return false;}
}
async function fetchSmartMoneySignal(mint) {
  portfolio.smartMoneySignals=portfolio.smartMoneySignals||{};
  for(const [oldMint,signal] of Object.entries(portfolio.smartMoneySignals)){const signalAt=Number(signal?.at||signal?.latest||0);if(!signalAt||Date.now()-signalAt>3*60*1000)delete portfolio.smartMoneySignals[oldMint];}
  const existing=portfolio.smartMoneySignals[mint],existingAt=Number(existing?.at||existing?.latest||0);
  if(['worker-gated','standard-wss-wallet-events'].includes(existing?.source)&&existingAt>0&&Date.now()-existingAt>=0&&Date.now()-existingAt<=3*60*1000&&Array.isArray(existing.walletAddresses)&&existing.walletAddresses.length>=1){existing.signal='TRACKED_WALLET_BUY';return true;}
  if(existing)delete portfolio.smartMoneySignals[mint];
  const secret=process.env.MEMERADAR_SYNC_SECRET;if(!secret)return false;
  try{
    const url='https://memeradar-state-api.varmaabhi47.workers.dev/smart-money?mint='+encodeURIComponent(mint);
    const result=await fetchJsonStrict(url,7000,{Authorization:'Bearer '+secret});
    if(['SMART_MONEY_CONFLUENCE','TRACKED_WALLET_BUY'].includes(result.signal)&&Number(result.wallets||1)>=1&&Number(result.latest||0)>0&&Date.now()-Number(result.latest)<=3*60*1000){portfolio.smartMoneySignals=portfolio.smartMoneySignals||{};portfolio.smartMoneySignals[mint]={signal:'TRACKED_WALLET_BUY',wallets:Number(result.wallets||1),walletAddresses:Array.isArray(result.walletAddresses)?result.walletAddresses:[],latest:result.latest,source:'worker-gated',at:Number(result.latest)};return true;}
    return false;
  }catch(error){console.warn('Smart-money D1 query unavailable; no confluence applied: '+error.message);return false;}
}

async function monitorResearchSnapshots(){
 const tracked=Object.values(portfolio.researchTracked||{});if(!tracked.length)return;
 const targets=[5,15,30,60,240],now=Date.now();
 for(const item of tracked){
  const elapsed=(now-Number(item.entryAt))/60000;
  const due=targets.filter(m=>elapsed>=m&&!(item.intervalsLogged||[]).includes(m));
  if(!due.length)continue;
  const target=due.find(m=>elapsed<=m+2)||null;
  for(const missed of due.filter(m=>m!==target)){
    await fs.appendFile(CONFIG.RESEARCH_FILE,JSON.stringify({schemaVersion:3,recordedAt:nowIso(),token:item.token,symbol:item.symbol,chainId:item.chainId,pairAddress:item.pairAddress,decision:'SNAPSHOT_MISSED',researchIntervalMin:missed,elapsedMinutes:elapsed,priceUsd:null,liquidityUsd:null,source:'target window missed; no historical price fabricated'})+'\n','utf8');
    item.intervalsLogged=[...(item.intervalsLogged||[]),missed];
  }
  if(!target)continue;
  try{
   const data=await fetchJsonStrict(`https://api.dexscreener.com/latest/dex/pairs/${item.chainId}/${item.pairAddress}`,10000);
   const pair=(data?.pairs||[]).find(x=>String(x.pairAddress||'').toLowerCase()===String(item.pairAddress).toLowerCase());
   if(!pair||!(Number(pair.priceUsd)>0&&Number(pair.liquidity?.usd)>0))throw Error('live pair mark/liquidity unavailable');
   const row={schemaVersion:3,recordedAt:nowIso(),token:item.token,symbol:item.symbol,chainId:item.chainId,pairAddress:item.pairAddress,priceUsd:Number(pair.priceUsd),liquidityUsd:Number(pair.liquidity.usd),score:item.score,tier:item.tier,smartMoneyConfluence:item.smartMoneyConfluence===true,wallets:item.smartWallets||[],returnPct:Number(item.entryPrice)>0?(Number(pair.priceUsd)/Number(item.entryPrice)-1)*100:null,decision:'SNAPSHOT',researchIntervalMin:target,elapsedMinutes:elapsed,entryAt:new Date(item.entryAt).toISOString(),entryPrice:item.entryPrice,security:item.security,networkFeeUsd:estimatedNetworkFeeUsd(item.chainId),entryQuoteFallback:String(item.chainId||'').toLowerCase()==='solana',quoteFallback:String(item.chainId||'').toLowerCase()==='solana',source:'DexScreener live pair mark'};
   await fs.appendFile(CONFIG.RESEARCH_FILE,JSON.stringify(row)+'\n','utf8');item.intervalsLogged=[...(item.intervalsLogged||[]),target];
  }catch(error){logDecision('RESEARCH_STALE',item.symbol,item.chainId,`snapshot target ${target}m not recorded; no mark fabricated: ${error.message}`);}
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
    if (Number.isFinite(pnlPct)) pos.maxNetPnlPct = Math.max(Number(pos.maxNetPnlPct ?? -Infinity), pnlPct);
    const holdHrs = (Date.now() - pos.entryTime) / 3600000;
    const dropPeak = pos.peakPrice > 0 ? ((pos.peakPrice - pos.lastPrice) / pos.peakPrice) * 100 : 0;
    const liqDrop = pos.entryLiquidityUsd > 0 ? ((pos.entryLiquidityUsd - pos.lastLiquidityUsd) / pos.entryLiquidityUsd) * 100 : 0;

    const risk=pos.manualCloseRequested?{action:'EXIT_ALL',reason:'MANUAL_TELEGRAM_CLOSE',peakPrice:pos.peakPrice}:evaluatePositionRisk(pos,{markPrice:pos.lastPrice,liquidityUsd:currentLiquidityUsd,now:Date.now(),frictionRate:CONFIG.DEX_FEE_RATE,netPnlPctOverride:Number(pos.remainingCostUsd??pos.costUsd)>0?((ex.netProceeds-Number(pos.remainingCostUsd??pos.costUsd))/Number(pos.remainingCostUsd??pos.costUsd))*100:0});
    if(risk.peakPrice)pos.peakPrice=risk.peakPrice;pos.lastLiquidityUsd=currentLiquidityUsd;
    if(risk.action==='PARTIAL_EXIT'){
      const qty=Number(pos.remainingTokens??pos.tokens),sellQty=qty*.5,ex=await paperExecution.sell({position:{...pos,tokens:sellQty,remainingTokens:sellQty},price:pos.lastPrice,liquidity:currentLiquidityUsd});
      const remCost=Number(pos.remainingCostUsd??pos.costUsd),soldCost=remCost*.5,realized=ex.netProceeds-soldCost;
      portfolio.cashUsd+=ex.netProceeds;pos.remainingTokens=qty-sellQty;pos.remainingCostUsd=remCost-soldCost;pos.realizedPartialPnlUsd=Number(pos.realizedPartialPnlUsd||0)+realized;pos.partialExitProceedsUsd=Number(pos.partialExitProceedsUsd||0)+ex.netProceeds;pos.partialFeesImpactUsd=Number(pos.partialFeesImpactUsd||0)+ex.feeUsd+ex.impactUsd;pos.partialTpDone=true;pos.breakevenStopNetPct=2;
      pos.partialExits=[...(pos.partialExits||[]),{at:Date.now(),tokensSold:sellQty,proceedsUsd:ex.netProceeds,allocatedCostUsd:soldCost,realizedPnlUsd:realized,quoteSource:ex.quoteSource,quoteFallback:!!ex.quoteFallback,reason:'PARTIAL_TP_40'}];
      await appendCsv({symbol:pos.symbol,chainId:pos.chainId,entryTime:pos.entryTime,exitTime:Date.now(),buyPrice:pos.buyPrice,sellPrice:ex.effPrice,tokensBought:pos.tokens,tokensSold:sellQty,remainingTokens:pos.remainingTokens,costUsd:soldCost,entryLiquidityUsd:pos.entryLiquidityUsd,entrySlippagePct:pos.entrySlippagePct??null,exitSlippagePct:Number.isFinite(Number(ex.impactRate))?Number(ex.impactRate)*100:null,exitValueUsd:ex.netProceeds,feesImpactUsd:ex.feeUsd+ex.impactUsd,netPnlUsd:realized,netPnlPct:soldCost?realized/soldCost*100:0,realizedPartialPnlUsd:realized,quoteFallback:!!ex.quoteFallback,entryQuoteFallback:!!pos.entryQuoteFallback,exitReason:'PARTIAL_TP_40'});
      logDecision('PARTIAL_SELL',pos.symbol,pos.chainId,'50% sold at +40% net; runner stop +2% net');await sendTelegram(formatSellReceipt(pos,{price:ex.effPrice,tokensSold:sellQty,proceedsUsd:ex.netProceeds,allocatedCostUsd:soldCost,realizedPnlUsd:realized,remainingTokens:pos.remainingTokens,reason:'PARTIAL TAKE-PROFIT'}));
    }else if(risk.action==='EXIT_ALL'){
      const qty=Number(pos.remainingTokens??pos.tokens),ex=pos.emergencyNoLiquidity?{effPrice:0,impactUsd:0,feeUsd:0,netProceeds:0,quoteSource:'no-live-liquidity',quoteFallback:true}:await paperExecution.sell({position:{...pos,tokens:qty,remainingTokens:qty},price:pos.lastPrice,liquidity:currentLiquidityUsd}),remCost=Number(pos.remainingCostUsd??pos.costUsd),pnl=Number(pos.realizedPartialPnlUsd||0)+ex.netProceeds-remCost,totalCost=Number(pos.originalCostUsd??pos.costUsd);
      portfolio.cashUsd+=ex.netProceeds;const trade={id:'tr_'+Date.now(),name:pos.name,symbol:pos.symbol,chainId:pos.chainId,address:pos.address,entryTime:pos.entryTime,buyPrice:pos.buyPrice,tokensBought:pos.tokens,tokensSold:qty,remainingTokens:0,costUsd:totalCost,entryLiquidityUsd:pos.entryLiquidityUsd,exitTime:Date.now(),sellPrice:ex.effPrice,exitQuoteSource:ex.quoteSource,quoteFallback:!!ex.quoteFallback,exitValueUsd:Number(pos.partialExitProceedsUsd||0)+ex.netProceeds,finalExitValueUsd:ex.netProceeds,entrySlippagePct:pos.entrySlippagePct??null,exitSlippagePct:Number.isFinite(Number(ex.impactRate))?Number(ex.impactRate)*100:null,feesImpactUsd:Number(pos.buyFeeAndImpactUsd||0)+Number(pos.partialFeesImpactUsd||0)+ex.feeUsd+ex.impactUsd,realizedPartialPnlUsd:Number(pos.realizedPartialPnlUsd||0),partialExits:pos.partialExits||[],entryQuoteFallback:!!pos.entryQuoteFallback,netPnlUsd:pnl,netPnlPct:totalCost?pnl/totalCost*100:0,exitReason:risk.reason};
      portfolio.closedTrades.unshift(trade);portfolio.cooldowns[pos.pairId]=Date.now();if(['STOP_LOSS','LIQ_DROP_ENTRY','LIQ_DROP_CHECK'].includes(risk.reason))consecutiveRiskExits++;else{consecutiveRiskExits=0;if(portfolio.breaker)portfolio.breaker.triggeredLossCount=0;}portfolio.consecutiveRiskExits=consecutiveRiskExits;portfolio.openPositions.splice(i,1);await appendCsv(trade);logDecision('SOLD',pos.symbol,pos.chainId,`[${risk.reason}] PnL ${pnl.toFixed(2)} USD`);await sendTelegram(formatSellReceipt(trade,{price:ex.effPrice,tokensSold:qty,proceedsUsd:ex.netProceeds,allocatedCostUsd:remCost,realizedPnlUsd:ex.netProceeds-remCost,remainingTokens:0,reason:risk.reason,final:true}));
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
          if (liq === 0) {
            portfolio.skippedZeroLiquidityPairs = Number(portfolio.skippedZeroLiquidityPairs || 0) + 1;
            continue;
          }
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
      const prefilter = evaluateDiscoveryPrefilter(p, { ...CONFIG, PREVIOUS_LIQUIDITY_USD: priorLiq, REQUIRE_LIQUIDITY_STABILITY: true });
      if (!prefilter.pass) {
        await recordResearch(p, { pass: false, checked: false, reason: 'Not security-audited: rejected by inexpensive discovery prefilter' },
          { score: null, tier: 'PREFILTER_REJECT', components: {}, metrics: prefilter.metrics, reasons: prefilter.reasons },
          'PREFILTER_REJECT');
        logDecision('PREFILTER', p.baseToken.symbol, p.chainId, prefilter.reasons.join('; '));
        continue;
      }

      if (secChecks >= 6) break;
      secChecks++;
      await sleep(250);
      const pairObj = { id: key, chainId: p.chainId.toLowerCase(), address: p.baseToken.address };
      const sec = await auditSecurity(pairObj);
      const intelligence = scoreCandidate(p, sec);
      const holders = pairObj.chainId === 'solana' ? await inspectSolanaHolders(pairObj.address, p.pairAddress) : { holderDistribution: { known: false, reason: 'holder RPC not implemented for this chain' }, creatorSignals: { known: false, warnings: [], reason: 'Solana-only creator analysis' } };
      const holderData=holders.holderDistribution,creatorData=holders.creatorSignals;
      const rpcAuditIncomplete = pairObj.chainId === 'solana' && (holderData?.known === false || creatorData?.known === false);
      if (rpcAuditIncomplete) {
        intelligence.tier='REJECT'; intelligence.hardReject=true;
        intelligence.reasons.push('RPC_AUDIT_INCOMPLETE: holderDistribution=' + (holderData?.reason || (holderData?.known === false ? 'unknown' : 'known')) + '; creatorSignals=' + (creatorData?.reason || (creatorData?.known === false ? 'unknown' : 'known')));
      }
      let walletSignal=portfolio.smartMoneySignals?.[String(p.baseToken.address||'')];
      let signalAt=Number(walletSignal?.at||walletSignal?.latest||0);
      let freshTrackedBuy=walletSignal?.signal==='TRACKED_WALLET_BUY'&&['standard-wss-wallet-events','worker-gated'].includes(walletSignal?.source)&&signalAt>0&&Date.now()-signalAt>=0&&Date.now()-signalAt<=3*60*1000&&Array.isArray(walletSignal.walletAddresses)&&walletSignal.walletAddresses.length>=1;
      let hardGate={pass:true,reasons:[]},bundleGate={pass:true,reason:'not-applicable'};
      if(pairObj.chainId==='solana'){
        hardGate=evaluateSolanaHardSecurityGates({mintAuthority:creatorData?.mintAuthority,freezeAuthority:creatorData?.freezeAuthority,holderDistribution:holderData,creatorSignals:creatorData,tokenProgramId:creatorData?.tokenProgramId,tokenExtensions:creatorData?.tokenExtensions});
        if(!hardGate.pass){intelligence.tier='REJECT';intelligence.hardReject=true;intelligence.reasons.push(...hardGate.reasons);}
        // Launch-bundle analysis is required for both legacy and wallet-originated entries.
        if(sec.pass&&hardGate.pass){
          bundleGate=await checkLaunchBundle({pairAddress:p.pairAddress,address:p.baseToken.address},holderData?.totalSupplyRaw);
          if(!bundleGate.pass){intelligence.tier='REJECT';intelligence.hardReject=true;intelligence.reasons.push(bundleGate.reason);}
        }
        const mintForGate=String(p.baseToken.address||''),gatePass=sec.pass&&hardGate.pass&&bundleGate.pass;
        const gateReasons=[...(sec.pass?[]:[sec.reason]),...hardGate.reasons,...(bundleGate.pass?[]:[bundleGate.reason])];
        const gatePublished=await publishV6Gate(mintForGate,gatePass,gateReasons);
        // D1 wallet confluence can qualify a WATCH-tier token too, but never bypasses security gates.
        if(gatePass&&gatePublished)await fetchSmartMoneySignal(mintForGate);else if(portfolio.smartMoneySignals)delete portfolio.smartMoneySignals[mintForGate];
        walletSignal=portfolio.smartMoneySignals?.[mintForGate];
        signalAt=Number(walletSignal?.at||walletSignal?.latest||0);
        freshTrackedBuy=walletSignal?.signal==='TRACKED_WALLET_BUY'&&['standard-wss-wallet-events','worker-gated'].includes(walletSignal?.source)&&signalAt>0&&Date.now()-signalAt>=0&&Date.now()-signalAt<=3*60*1000&&Array.isArray(walletSignal.walletAddresses)&&walletSignal.walletAddresses.length>=1;
      }
      const antiChaseFlags = [];
      const change5m = Number(p.priceChange?.m5);
      const turnover1h = Number(p.volume?.h1) / Math.max(1, Number(p.liquidity?.usd));
      if (Number.isFinite(change5m) && change5m > 25) antiChaseFlags.push('extreme 5m price expansion >25%');
      if (Number.isFinite(turnover1h) && turnover1h > 5 && Number(p.txns?.h1?.buys || 0) + Number(p.txns?.h1?.sells || 0) >= 20) antiChaseFlags.push('high 1h turnover vs liquidity');
      const auditSafeForAntiChase = holderData?.known === true && creatorData?.known === true && hardGate.pass;
      if (antiChaseFlags.length) {
        intelligence.warnings = [...new Set([...(intelligence.warnings || []), ...antiChaseFlags])];
        if (!auditSafeForAntiChase) {
          intelligence.tier='REJECT'; intelligence.hardReject=true;
          intelligence.reasons.push('ANTI_CHASE_UNSAFE: flagged entry without confirmed-safe holder and creator audits: ' + antiChaseFlags.join(', '));
        } else {
          intelligence.score = Math.max(0, Number(intelligence.score || 0) - 10 * antiChaseFlags.length);
          intelligence.reasons.push('ANTI_CHASE_PENALTY: -' + (10 * antiChaseFlags.length) + ' points for ' + antiChaseFlags.join(', '));
        }
      }
      intelligence.smartMoneyConfluence=freshTrackedBuy;
      const legacyDiscoveryQualified=intelligence.tier==='RESEARCH'&&sec.pass&&hardGate.pass&&bundleGate.pass;
      // Wallet-originated selection is a separate, smaller-risk route.
      // It may qualify a clean WATCH-tier score, but never a REJECT/WEAK score,
      // any score reason, failed security/creator/bundle gate, or stale signal.
      const walletSignalQualified=freshTrackedBuy&&sec.pass&&['WATCH','RESEARCH'].includes(intelligence.tier)&&intelligence.reasons.length===0&&intelligence.score>=65&&hardGate.pass&&bundleGate.pass;
      const walletOnlyQualified=walletSignalQualified&&!legacyDiscoveryQualified;
      await recordResearch(p,sec,intelligence,rpcAuditIncomplete?'RPC_AUDIT_INCOMPLETE':walletOnlyQualified?'WALLET_SIGNAL':intelligence.tier,holders);
      if(!legacyDiscoveryQualified&&!walletSignalQualified){
        logDecision('SKIPPED',p.baseToken.symbol,pairObj.chainId,
          `candidate blocked: legacyResearch=${legacyDiscoveryQualified}, verifiedWalletSignal=${walletSignalQualified}; score ${intelligence.score}/100 [${intelligence.tier}], hardReject=${!!intelligence.hardReject}, security=${sec.pass}, creator/bundle=${hardGate.pass&&bundleGate.pass}`);
        continue;
      }
      const entrySignal=freshTrackedBuy?walletSignal:{signal:'LEGACY_DISCOVERY',source:'legacy-dexscreener-selection',walletAddresses:[]};
      const selectionSource=walletOnlyQualified?'tracked-wallet':'legacy-discovery';
      logDecision('SELECTED',p.baseToken.symbol,pairObj.chainId,'entry selected by '+selectionSource+'; live security, creator and bundle gates passed');
      if (portfolio.autoTradeEnabled === false || process.env.DRY_RUN === 'true' || Number(portfolio.breaker?.pauseUntil || 0) > Date.now()) {
        logDecision('PAUSED', p.baseToken.symbol, pairObj.chainId, portfolio.breaker?.reason || 'new entries disabled');
        continue;
      }
      const equityUsd=portfolio.cashUsd+portfolio.openPositions.reduce((sum,x)=>sum+Number(x.lastPrice||x.buyPrice)*Number(x.remainingTokens??x.tokens),0);
      const entryFee=estimatedNetworkFeeUsd(pairObj.chainId);const usableCash=Math.max(0,portfolio.cashUsd-entryFee);const mintAddress=String(p.baseToken.address);const smartMoneySignal=!!portfolio.smartMoneySignals?.[mintAddress];const walletSignalCount=walletSignalQualified?Number(walletSignal.walletAddresses.length):0;const sizeUsd=calculatePositionSize({equityUsd,poolLiquidityUsd:liq,score:intelligence.score,cashUsd:usableCash,tier:walletOnlyQualified?'WALLET_SIGNAL':intelligence.tier,smartMoneyConfluence:freshTrackedBuy,walletSignalCount});if(!(sizeUsd>0)){logDecision('SKIPPED',p.baseToken.symbol,pairObj.chainId,'position size below usable cash/liquidity cap');continue;}const ex=await paperExecution.buy({usd:sizeUsd,pair:p,security:sec,decimals:holderData?.decimals});const totalCost=sizeUsd+entryFee;portfolio.cashUsd-=totalCost;
      portfolio.openPositions.unshift({
        id: 'pos_' + Date.now(), pairId: key, chainId: pairObj.chainId, pairAddress: p.pairAddress,
        address: p.baseToken.address, symbol: p.baseToken.symbol.toUpperCase(), name: p.baseToken.name || p.baseToken.symbol,
        entryTime: Date.now(), entrySpotPrice: Number(p.priceUsd), buyPrice: ex.effPrice, tokens: ex.tokens, tokenDecimals: holderData?.decimals ?? null,
        costUsd:totalCost,originalCostUsd:totalCost,remainingCostUsd:totalCost,remainingTokens:ex.tokens,partialTpDone:false,realizedPartialPnlUsd:0,partialExitProceedsUsd:0,partialExits:[],maxNetPnlPct:0,entrySlippagePct:Number.isFinite(Number(ex.impactRate))?Number(ex.impactRate)*100:null,buyFeeAndImpactUsd:ex.feeUsd+ex.impactUsd,entryLiquidityUsd:liq,buyTaxRate:Number(sec.buyTaxRate||0),sellTaxRate:Number(sec.sellTaxRate||0),entryQuoteSource:ex.quoteSource,entryQuoteFallback:!!ex.quoteFallback,
        lastPrice: Number(p.priceUsd), lastLiquidityUsd: liq, peakPrice: Number(p.priceUsd), trailArmed: false, securitySummary: sec.reason
      });
      held.add(key);
      logDecision('BOUGHT',p.baseToken.symbol,pairObj.chainId,`${sizeUsd.toFixed(2)} @ ${ex.effPrice} | Liq ${Math.round(liq).toLocaleString()} | ${sec.reason}`);
      await sendTelegram(formatBuyReceipt(portfolio.openPositions[0], { price: ex.effPrice, tokens: ex.tokens, costUsd: totalCost, liquidityUsd: liq, security: sec.reason, signal: entrySignal }));
    }
  }

  portfolio.rpcTelemetry = rpcGuard.telemetry();
  portfolio.edgeProof = computeEdgeProof(portfolio.closedTrades || []);
  lastPollIso = nowIso();
  lastError = '';
  await saveState();
  await syncPortfolioToCloudflare();

  if (Date.now() - lastHourlySummaryMs >= 3600000) {
    const summaryStart = lastHourlySummaryMs || (Date.now() - 3600000);
    const summaryEnd = Date.now();
    lastHourlySummaryMs = summaryEnd;
    await sendTelegram(formatHourlyOverview(summaryStart, summaryEnd));
  }
}

async function pollCycle(){await monitorPositions({discover:true});await updateCircuitBreaker();await monitorResearchSnapshots();}

// GitHub Actions mode: one scan per scheduled job; portfolio state is committed by workflow.

async function updateCircuitBreaker(){
 const now=Date.now(),equity=portfolio.cashUsd+portfolio.openPositions.reduce((sum,p)=>sum+Number(p.lastPrice||p.buyPrice)*Number(p.remainingTokens??p.tokens),0);
 const snaps=(portfolio.dailyEquitySnapshots||[]).filter(x=>now-Number(x.ts)<=86400000);snaps.push({ts:now,equity});portfolio.dailyEquitySnapshots=snaps;
 const base=Number(snaps[0]?.equity||equity),pnl=equity-base,old=portfolio.breaker||{},decision=checkCircuitBreakers({realizedUnrealizedPnlUsd:pnl,dailyStartingEquityUsd:base,now,breaker:old,consecutiveRiskExits});
 let pauseUntil=Number(old.pauseUntil||0),reason=old.reason||null;
 if(decision.dailyDrawdownPct<=-10&&!(reason==='DAILY_DRAWDOWN_10'&&pauseUntil>now)){pauseUntil=now+12*3600000;reason='DAILY_DRAWDOWN_10';}
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
  await rpcGuard.load();
  const runnerLock=makeStateLock();
  if(process.env.SOLANA_RPC_WSS){
    try{
      const walletConfig=JSON.parse(await fs.readFile(process.env.SMART_WALLETS_FILE||'smart_wallets.json','utf8'));
      const walletRecords=Array.isArray(walletConfig.wallets)?walletConfig.wallets.filter(x=>x&&x.status==='ACTIVE'&&typeof x.address==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.address.trim())).slice(0,50):[];
      const wallets=walletRecords.map(x=>x.address);
      if(wallets.length<15)console.warn('Single-wallet entry mode is active; only '+wallets.length+' ACTIVE tracked wallets are available, so wallet coverage is limited.');
      eventListener=new SolanaEventListener({
        wallets,
        onError:error=>{lastError=error.message;console.error('Solana event source: '+error.message);},
        onMint:async event=>{
          try{const tx=await rpcGuard.rpc(getSolanaRpcEndpoints(),'getTransaction',[event.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}],{credits:1});for(const mint of await extractMintsFromTransaction(tx)){eventMintQueue.add(mint);if(eventMintQueue.size>2000)eventMintQueue.delete(eventMintQueue.values().next().value);}portfolio.eventDiscoveryRequested=true;console.log('Migration/pool event queued signature='+event.signature+' mintCount='+eventMintQueue.size);}
          catch(error){console.error('Migration transaction lookup failed; no mint inferred: '+error.message);}
        },
        onWalletLog:async event=>{
          try{
            const tx=await rpcGuard.rpc(getSolanaRpcEndpoints(),'getTransaction',[event.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}],{credits:1});
            if(!(tx?.meta?.logMessages||[]).some(line=>/swap/i.test(line)))return;
            const txTime=Number(tx.blockTime)*1000;
            const eventTimeValid=Number.isFinite(txTime)&&txTime>0&&txTime<=Date.now()+60000;
            const reconstructed=reconstructSolSwap(tx,event.wallet);
            for(const mint of extractWalletTokenBuys(tx,event.wallet)){
              if([USDC_MINT,'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB','So11111111111111111111111111111111111111112'].includes(mint))continue;
              const verifiedBuy=eventTimeValid&&reconstructed?.swap?.side==='BUY'&&reconstructed.swap.mint===mint;
              if(verifiedBuy){
                const signal=smartMoneyConfluence(event.wallet,mint,txTime);
                if(signal){
                  portfolio.smartMoneySignals=portfolio.smartMoneySignals||{};
                  portfolio.smartMoneySignals[mint]={signal:'TRACKED_WALLET_BUY',wallets:signal.wallets,walletAddresses:signal.walletAddresses,source:'standard-wss-wallet-events',at:txTime,latest:txTime,signature:event.signature,slot:Number(tx.slot||reconstructed.swap.slot||0),swapAccounting:'verified-single-mint-sol-leg'};
                  logDecision('TRACKED_WALLET_BUY',mint,'solana','verified swap buy from tracked wallet; signal timestamp uses on-chain blockTime and expires after 3 minutes');
                }
              }else{
                logDecision('WALLET_EVENT_UNVERIFIED',mint,'solana',!eventTimeValid?'on-chain blockTime missing/invalid; no buy signal':'swap legs ambiguous or reconstructed as non-buy; no buy signal');
              }
              eventMintQueue.add(mint);if(eventMintQueue.size>2000)eventMintQueue.delete(eventMintQueue.values().next().value);
              portfolio.eventDiscoveryRequested=true;
            }
          }catch(error){console.error('Smart-wallet transaction lookup failed; no signal inferred: '+error.message);}
        }
      }).start();
      console.log('Standard Solana WebSocket triggers active; tracked wallets='+wallets.length);
    }catch(error){console.error('Solana event listener not started: '+error.message);}
  }else console.warn('SOLANA_RPC_WSS not configured; migration and wallet event triggers disabled.');

  const fastPositionLoop=async()=>{
    while(true){
      try{if(portfolio.openPositions.length)await runnerLock(()=>monitorPositions({discover:false}));}
      catch(error){lastError=error?.message||String(error);console.error('Fast position monitor error: '+lastError);await saveState();}
      await sleep(CONFIG.MONITOR_SEC*1000);
    }
  };
  const discoveryControlLoop=async()=>{
    let lastDiscovery=0,lastResearch=0,lastTelegram=0,lastBreaker=0;
    while(true){
      try{
        const now=Date.now();
        if(now-lastTelegram>=5000){await pollTelegramCommands();lastTelegram=Date.now();}
        if(now-lastBreaker>=30000){await runnerLock(()=>updateCircuitBreaker());lastBreaker=Date.now();}
        if(now-lastDiscovery>=CONFIG.DISCOVERY_SEC*1000||portfolio.eventDiscoveryRequested){portfolio.eventDiscoveryRequested=false;await runnerLock(async()=>{await updateCircuitBreaker();if(rpcGuard.telemetry().throttled){logDecision('RPC_BUDGET_THROTTLE','SYSTEM','solana','projected monthly RPC credits exceed 800,000; discovery paused, open-position monitor remains active');await monitorPositions({discover:false});}else await monitorPositions({discover:true});});lastDiscovery=Date.now();}
        if(now-lastResearch>=60000){await runnerLock(()=>monitorResearchSnapshots());lastResearch=Date.now();}
      }catch(error){lastError=error?.message||String(error);console.error('Discovery/control loop error: '+lastError);await saveState();}
      await sleep(1000);
    }
  };
  console.log('Path 2 persistent mode: independent 10s position loop (idle with zero positions) + 180s discovery loop.');
  await Promise.all([fastPositionLoop(),discoveryControlLoop()]);
}
async function main(){
 if(process.env.LIVE_TRADING==='true')throw new Error('LIVE_TRADING=true is blocked: live swap builder/Sender integration has not passed verification. Paper adapter remains the only active execution path.');
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
 if(process.env.RUN_MODE==='persistent'){console.log('Persistent mode: 10s position monitor / 180s discovery scanner.');await persistentRunner();return;}
 try{await pollCycle();failures=0;console.log('Completed one paper-trading scan.');}
 catch(err){failures++;lastError=err?.message||String(err);console.error('[ERROR] '+lastError);await saveState();process.exitCode=1;}
}

main().catch(err => {
  console.error(`[${nowIso()}] Fatal error: ${err?.stack || err}`);
  process.exitCode = 1;
});
