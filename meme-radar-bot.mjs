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
import { scoreCandidate, calculatePaperBuy, calculatePaperSell, detectBasicMarketWarnings, calculateTopHolderConcentration, analyzeCreatorSignals, summarizeCrossTokenClusters, evaluateDiscoveryPrefilter, calculateJupiterQuoteExit } from './meme-radar-v5-intelligence.mjs';

const CONFIG = {
  FEED_URL: 'https://api.dexscreener.com/token-profiles/latest/v1',
  CHAIN_FILTER: "all",
  SUPPORTED_CHAINS: ['solana', 'base', 'ethereum', 'bsc', 'arbitrum'],
  EVM_CHAIN_IDS: { ethereum: '1', bsc: '56', base: '8453', arbitrum: '42161' },
  POLL_SEC: 30,
  DEX_FEE_RATE: 0.003,
  JUPITER_API_KEY: process.env.JUPITER_API_KEY || '',
  JUPITER_QUOTE_ENABLED: process.env.JUPITER_QUOTE_ENABLED !== 'false',
  BACKOFF_STEPS: [10, 20, 40, 60],

  // Synced Strategy & Liquidity Gate Settings
  STARTING_BANKROLL: 1000,
  TRADE_SIZE_USD: 100,
  MAX_OPEN_POSITIONS: 5,
  TP_PCT: 40,
  SL_PCT: 18,
  TRAIL_ARM_PCT: 20,
  TRAIL_DROP_PCT: 12,
  MAX_HOLD_HOURS: 24,
  COOLDOWN_MINS: 60,
  MIN_LIQUIDITY_USD: 75000,
  MAX_TRADE_TO_LIQ_PCT: 0.5,
  MIN_LIQ_FDV_PCT: 5,
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
  try {
    const raw = await fs.readFile(CONFIG.PORTFOLIO_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    portfolio = { ...portfolio, ...parsed };
    lastHourlySummaryMs = Number(parsed.lastHourlySummaryMs || 0);
    console.log(`[${nowIso()}] Loaded ${CONFIG.PORTFOLIO_FILE} | Cash: $${portfolio.cashUsd.toFixed(2)} | Open: ${portfolio.openPositions.length} | Closed: ${portfolio.closedTrades.length}`);
  } catch {
    await saveState();
    console.log(`[${nowIso()}] Initialized fresh ${CONFIG.PORTFOLIO_FILE} with $${portfolio.cashUsd.toFixed(2)} USDC`);
  }
}

async function saveState() {
  portfolio.lastHourlySummaryMs = lastHourlySummaryMs;
  await fs.writeFile(CONFIG.PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2), 'utf8');
}

async function appendCsv(t) {
  let exists = true;
  try { await fs.access(CONFIG.CSV_FILE); } catch { exists = false; }
  if (!exists) {
    await fs.writeFile(CONFIG.CSV_FILE, 'EntryTime,ExitTime,Symbol,Chain,BuyPrice,TokensBought,CostUSD,EntryLiqUSD,SellPrice,ExitValueUSD,FeesImpactUSD,NetPnLUSD,NetPnLPct,ExitReason\n', 'utf8');
  }
  const line = [
    new Date(t.entryTime).toISOString(), new Date(t.exitTime).toISOString(), t.symbol, t.chainId,
    t.buyPrice, t.tokensBought, t.costUsd.toFixed(2), Math.round(t.entryLiquidityUsd),
    t.sellPrice, t.exitValueUsd.toFixed(2), t.feesImpactUsd.toFixed(2), t.netPnlUsd.toFixed(2),
    t.netPnlPct.toFixed(2), t.exitReason
  ].join(',') + '\n';
  await fs.appendFile(CONFIG.CSV_FILE, line, 'utf8');
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

async function calcPaperExit(pos, price, liq) {
  const fallback = () => ({ ...calcSell(pos.tokens, price, liq), quoteSource: 'constant-product-fallback' });
  if (!CONFIG.JUPITER_QUOTE_ENABLED || pos.chainId !== 'solana' ||
      !pos.address || pos.tokenDecimals == null || !Number.isInteger(Number(pos.tokenDecimals))) return fallback();
  const decimals = Number(pos.tokenDecimals);
  if (decimals < 0 || decimals > 18) return fallback();
  const cacheKey = String(pos.address);
  const cached = jupiterQuoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 8000) return cached.value;
  try {
    const rawAmount = BigInt(Math.floor(Number(pos.tokens) * (10 ** decimals))).toString();
    if (rawAmount === '0') return fallback();
    const waitMs = Math.max(0, 2100 - (Date.now() - lastJupiterRequestMs));
    if (waitMs) await sleep(waitMs);
    const params = new URLSearchParams({ inputMint: pos.address, outputMint: USDC_MINT, amount: rawAmount });
    lastJupiterRequestMs = Date.now();
    const headers = CONFIG.JUPITER_API_KEY ? { 'x-api-key': CONFIG.JUPITER_API_KEY } : {};
    const quote = await fetchJsonStrict(`https://api.jup.ag/swap/v2/order?${params}`, 9000, headers);
    const result = calculateJupiterQuoteExit({ quote, tokens: pos.tokens, spotPrice: price, outputDecimals: 6 });
    const value = {
      effPrice: result.effectivePrice, impactUsd: result.impactUsd, impactRate: result.impactRate,
      feeUsd: result.feeUsd, netProceeds: result.netProceeds, model: result.model,
      quoteSource: 'jupiter', router: result.router
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

async function inspectSolanaHolders(tokenAddress) {
  const rpc = async (method, params, id) => {
    const response = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Solana RPC error');
    return data.result;
  };
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
      ...calculateTopHolderConcentration(accounts, supply?.value?.amount),
      decimals: supply?.value?.decimals ?? null,
      source: 'Solana public RPC'
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
    return { holderDistribution, creatorSignals };
  } catch (error) {
    return {
      holderDistribution: { known: false, reason: error.message, source: 'Solana public RPC' },
      creatorSignals: { known: false, warnings: [], reason: error.message }
    };
  }
}

async function recordResearch(pair, security, analysis, decision, holders = null) {
  const row = {
    schemaVersion: 1, recordedAt: nowIso(), token: pair.baseToken?.address || pair.address || null,
    symbol: pair.baseToken?.symbol || pair.symbol || 'UNKNOWN', chainId: pair.chainId || null,
    pairAddress: pair.pairAddress || null, priceUsd: Number(pair.priceUsd || 0),
    liquidityUsd: Number(pair.liquidity?.usd || 0), volume24hUsd: Number(pair.volume?.h24 || 0),
    security: { pass: security?.pass === true, checked: security?.checked !== false && !!security, reason: security?.reason || 'not checked' },
    score: analysis?.score ?? null, tier: analysis?.tier || 'UNSCORED',
    components: analysis?.components || {}, metrics: analysis?.metrics || {}, reasons: analysis?.reasons || [],
    warnings: detectBasicMarketWarnings(pair), holderDistribution: holders?.holderDistribution || holders, creatorSignals: holders?.creatorSignals || null, decision
  };
  await fs.appendFile(CONFIG.RESEARCH_FILE, JSON.stringify(row) + '\n', 'utf8');
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
      const out = { ts: Date.now(), pass, reason };
      secCache.set(key, out);
      return out;
    } catch (e) {
      return { ts: Date.now(), pass: false, reason: `Skipped: Security API unreachable (RugCheck: ${e.message})` };
    }
  } else if (CONFIG.EVM_CHAIN_IDS[pair.chainId]) {
    const id = CONFIG.EVM_CHAIN_IDS[pair.chainId];
    try {
      const gp = await fetchJsonStrict(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${pair.address}`, 9000);
      const d = gp?.result?.[pair.address.toLowerCase()];
      if (!d) return { ts: Date.now(), pass: false, reason: 'GoPlus REJECT: Unindexed contract' };
      const bt = Number(d.buy_tax || 0), st = Number(d.sell_tax || 0);
      const pass = d.is_honeypot !== '1' && d.cannot_sell_all !== '1' && bt <= 0.05 && st <= 0.05;
      const reason = pass ? `GoPlus PASS (Tax ${(bt*100).toFixed(1)}%/${(st*100).toFixed(1)}%)` : `GoPlus REJECT (honey=${d.is_honeypot}, sellTax=${(st*100).toFixed(1)}%)`;
      const out = { ts: Date.now(), pass, reason };
      secCache.set(key, out);
      return out;
    } catch (e) {
      return { ts: Date.now(), pass: false, reason: `Skipped: Security API unreachable (GoPlus: ${e.message})` };
    }
  }
  return { ts: Date.now(), pass: false, reason: 'Unsupported chain' };
}

async function syncPortfolioToCloudflare() {
  const secret = process.env.MEMERADAR_SYNC_SECRET;
  if (!secret) {
    console.error(`[${nowIso()}] D1 sync skipped: MEMERADAR_SYNC_SECRET is missing.`);
    return false;
  }
  try {
    const response = await fetch('https://memeradar-state-api.varmaabhi47.workers.dev/state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`
      },
      body: JSON.stringify({ portfolio })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) {
      throw new Error(result.error || result.message || `HTTP ${response.status}`);
    }
    console.log(`[${nowIso()}] D1 portfolio sync successful.`);
    return true;
  } catch (err) {
    console.error(`[${nowIso()}] D1 portfolio sync failed: ${err.message}`);
    process.exitCode = 1;
    return false;
  }
}

async function pollCycle() {
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
    if (!lp || !Number(lp.priceUsd) || !Number(lp.liquidity?.usd)) {
      pos.dataStale = true;
      pos.dataStaleReason = 'Pair missing or price/liquidity unavailable; no fabricated exit price used';
      logDecision('STALE', pos.symbol, pos.chainId, pos.dataStaleReason);
      continue;
    }
    pos.dataStale = false;
    pos.dataStaleReason = '';
    pos.lastPrice = Number(lp.priceUsd);
    pos.lastLiquidityUsd = Number(lp.liquidity?.usd || 0);
    if (pos.lastPrice > pos.peakPrice) pos.peakPrice = pos.lastPrice;
    if (CONFIG.TRAIL_ARM_PCT > 0 && ((pos.peakPrice - pos.buyPrice) / pos.buyPrice) * 100 >= CONFIG.TRAIL_ARM_PCT) pos.trailArmed = true;

    const ex = await calcPaperExit(pos, pos.lastPrice, pos.lastLiquidityUsd || pos.entryLiquidityUsd);
    const pnlPct = ((ex.netProceeds - pos.costUsd) / pos.costUsd) * 100;
    const holdHrs = (Date.now() - pos.entryTime) / 3600000;
    const dropPeak = pos.peakPrice > 0 ? ((pos.peakPrice - pos.lastPrice) / pos.peakPrice) * 100 : 0;
    const liqDrop = pos.entryLiquidityUsd > 0 ? ((pos.entryLiquidityUsd - pos.lastLiquidityUsd) / pos.entryLiquidityUsd) * 100 : 0;

    let reason = null;
    if (liqDrop > 60) reason = 'LIQ_DROP';
    else if (pnlPct >= CONFIG.TP_PCT) reason = 'TP';
    else if (pnlPct <= -CONFIG.SL_PCT) reason = 'SL';
    else if (pos.trailArmed && dropPeak >= CONFIG.TRAIL_DROP_PCT) reason = 'TRAILING';
    else if (holdHrs >= CONFIG.MAX_HOLD_HOURS) reason = 'MAX_HOLD';

    if (reason) {
      const netPnlUsd = ex.netProceeds - pos.costUsd;
      portfolio.cashUsd += ex.netProceeds;
      const trade = {
        id: 'tr_' + Date.now(), symbol: pos.symbol, chainId: pos.chainId, address: pos.address,
        entryTime: pos.entryTime, buyPrice: pos.buyPrice, tokensBought: pos.tokens, costUsd: pos.costUsd,
        entryLiquidityUsd: pos.entryLiquidityUsd, exitTime: Date.now(), sellPrice: ex.effPrice, exitQuoteSource: ex.quoteSource || 'constant-product-fallback', exitRouter: ex.router || null,
        exitValueUsd: ex.netProceeds, feesImpactUsd: pos.buyFeeAndImpactUsd + ex.feeUsd + ex.impactUsd,
        netPnlUsd, netPnlPct: pnlPct, exitReason: reason
      };
      portfolio.closedTrades.unshift(trade);
      portfolio.cooldowns[pos.pairId] = Date.now();
      portfolio.openPositions.splice(i, 1);
      await appendCsv(trade);
      logDecision('SOLD', pos.symbol, pos.chainId, `[${reason}] Net ${netPnlUsd >= 0 ? '+' : '-'}$${Math.abs(netPnlUsd).toFixed(2)} (${pnlPct.toFixed(1)}%)`);
      await sendTelegram(`AUTO-SELL [${reason}]: ${pos.symbol} (${pos.chainId.toUpperCase()})\nBuy: $${pos.buyPrice} -> Sell: $${ex.effPrice}\nTokens: ${pos.tokens.toFixed(2)}\nNet PnL: ${netPnlUsd >= 0 ? '+' : '-'}$${Math.abs(netPnlUsd).toFixed(2)} (${pnlPct.toFixed(1)}%)\nNew Cash: $${portfolio.cashUsd.toFixed(2)}`);
    }
  }

  // 2. Scan Feed for New Auto-Buys
  if (portfolio.openPositions.length < CONFIG.MAX_OPEN_POSITIONS && portfolio.cashUsd >= CONFIG.TRADE_SIZE_USD) {
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
      if (portfolio.openPositions.length >= CONFIG.MAX_OPEN_POSITIONS || portfolio.cashUsd < CONFIG.TRADE_SIZE_USD) break;
      if (held.has(key)) continue;
      if (Date.now() - (portfolio.cooldowns[key] || 0) < CONFIG.COOLDOWN_MINS * 60000) continue;

      const liq = Number(p.liquidity?.usd || 0);
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
      const holders = pairObj.chainId === 'solana' ? await inspectSolanaHolders(pairObj.address) : { holderDistribution: { known: false, reason: 'holder RPC not implemented for this chain' }, creatorSignals: { known: false, warnings: [], reason: 'Solana-only creator analysis' } };
      const holderData = holders.holderDistribution;
      const creatorData = holders.creatorSignals;
      if (holderData?.known && holderData.top10Pct >= 70) intelligence.reasons.push(`top 10 token accounts hold ${holderData.top10Pct.toFixed(2)}% (manual review; LP/custody not excluded)`);
      // Creator/cluster warnings remain separate from the numerical score and tier.\n      
      await recordResearch(p, sec, intelligence, intelligence.tier, holders);
      if (!sec.pass || intelligence.tier !== 'RESEARCH') {
        logDecision('SKIPPED', p.baseToken.symbol, pairObj.chainId,
          `V5 ${intelligence.score}/100 [${intelligence.tier}] ${[...intelligence.reasons, ...detectBasicMarketWarnings(p)].join('; ') || sec.reason}`);
        continue;
      }

      const ex = calcBuy(CONFIG.TRADE_SIZE_USD, Number(p.priceUsd), liq);
      portfolio.cashUsd -= CONFIG.TRADE_SIZE_USD;
      portfolio.openPositions.unshift({
        id: 'pos_' + Date.now(), pairId: key, chainId: pairObj.chainId, pairAddress: p.pairAddress,
        address: p.baseToken.address, symbol: p.baseToken.symbol.toUpperCase(), name: p.baseToken.name || p.baseToken.symbol,
        entryTime: Date.now(), entrySpotPrice: Number(p.priceUsd), buyPrice: ex.effPrice, tokens: ex.tokens, tokenDecimals: holderData?.decimals ?? null,
        costUsd: CONFIG.TRADE_SIZE_USD, buyFeeAndImpactUsd: ex.feeUsd + ex.impactUsd, entryLiquidityUsd: liq,
        lastPrice: Number(p.priceUsd), lastLiquidityUsd: liq, peakPrice: Number(p.priceUsd), trailArmed: false, securitySummary: sec.reason
      });
      held.add(key);
      logDecision('BOUGHT', p.baseToken.symbol, pairObj.chainId, `$${CONFIG.TRADE_SIZE_USD} @ $${ex.effPrice} | Liq $${Math.round(liq).toLocaleString()} | ${sec.reason}`);
      await sendTelegram(`AUTO-BUY: ${p.baseToken.symbol} (${pairObj.chainId.toUpperCase()})\nPrice: $${ex.effPrice} | Tokens: ${ex.tokens.toFixed(2)}\nCost: $${CONFIG.TRADE_SIZE_USD} | Liq: $${Math.round(liq).toLocaleString()}\nSecurity: ${sec.reason}`);
    }
  }

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

// GitHub Actions mode: one scan per scheduled job; portfolio state is committed by workflow.
async function main() {
  await loadState();
  if (process.env.TELEGRAM_TEST === 'true') {
    const delivered = await sendTelegram('MEME.RADAR: Telegram connection test. Your bot can send notifications successfully. Paper trading only.');
    if (!delivered) process.exitCode = 1;
  }
  try {
    await pollCycle();
    failures = 0;
    console.log(`[${nowIso()}] Completed one paper-trading scan.`);
  } catch (err) {
    failures++;
    lastError = err?.message || String(err);
    console.error(`[${nowIso()}] [ERROR] ${lastError}`);
    await saveState();
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`[${nowIso()}] Fatal error: ${err?.stack || err}`);
  process.exitCode = 1;
});
