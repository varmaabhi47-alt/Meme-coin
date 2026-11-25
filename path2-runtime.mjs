/**
 * Path 2 low-cost event and RPC safety primitives.
 * No price generation or provider error masking. Standard Solana JSON-RPC only.
 */
import fs from 'node:fs/promises';

const now = () => Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class RpcCreditGuard {
  constructor({ maxRps = 6, cacheMs = 15 * 60_000, stateFile = 'rpc-usage.json', monthlyLimit = 800_000, creditCost = 1, fetchImpl = fetch } = {}) {
    this.maxRps = Math.min(6, Math.max(1, Number(maxRps) || 6));
    this.cacheMs = cacheMs; this.stateFile = stateFile; this.monthlyLimit = monthlyLimit;
    this.creditCost = creditCost; this.fetchImpl = fetchImpl; this.lastCall = 0;
    this.cache = new Map(); this.usage = { month: new Date().toISOString().slice(0, 7), calls: 0, estimatedCredits: 0, lastAt: null };
  }
  async load() {
    try { const x = JSON.parse(await fs.readFile(this.stateFile, 'utf8')); if (x.month === this.usage.month) this.usage = x; } catch {}
  }
  async save() { await fs.writeFile(this.stateFile, JSON.stringify(this.usage), 'utf8'); }
  async cached(key, fn) {
    const row = this.cache.get(key);
    if (row && now() - row.at < this.cacheMs) return row.value;
    const value = await fn(); this.cache.set(key, { at: now(), value }); return value;
  }
  async rpc(endpoint, method, params = [], { credits = this.creditCost, cacheKey = null } = {}) {
    if (!endpoint) throw new Error('SOLANA_RPC_HTTP is not configured');
    if (cacheKey) return this.cached(cacheKey, () => this.rpc(endpoint, method, params, { credits }));
    const projected = this.usage.estimatedCredits + Number(credits || 0);
    if (projected * (30 / Math.max(1, new Date().getDate())) > this.monthlyLimit) {
      throw Object.assign(new Error('RPC_CREDIT_THROTTLE: projected monthly usage exceeds budget'), { code: 'RPC_BUDGET' });
    }
    const minGap = 1000 / this.maxRps;
    const wait = Math.max(0, minGap - (now() - this.lastCall)); if (wait) await sleep(wait);
    let attempt = 0;
    while (true) {
      this.lastCall = now();
      try {
        const response = await this.fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: now(), method, params }) });
        if (response.status === 429) throw Object.assign(new Error('Solana RPC HTTP 429'), { status: 429 });
        if (!response.ok) throw new Error('Solana RPC HTTP ' + response.status);
        const body = await response.json(); if (body.error) throw new Error('Solana RPC ' + body.error.code + ': ' + body.error.message);
        this.usage.calls++; this.usage.estimatedCredits += Number(credits || 0); this.usage.lastAt = new Date().toISOString();
        await this.save(); return body.result;
      } catch (error) {
        if (error.status !== 429 || attempt >= 5) throw error;
        await sleep(Math.min(30_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250)); attempt++;
      }
    }
  }
  telemetry() { return { ...this.usage, projectedMonthlyCredits: Math.round(this.usage.estimatedCredits * 30 / Math.max(1, new Date().getDate())), throttled: this.usage.estimatedCredits * 30 / Math.max(1, new Date().getDate()) > this.monthlyLimit }; }
}

export function createSmartMoneyConfluence({ windowMs = 15 * 60_000 } = {}) {
  const buys = new Map();
  return (wallet, mint, at = now()) => {
    if (!wallet || !mint) return null;
    const key = String(mint); const rows = (buys.get(key) || []).filter(x => at - x.at <= windowMs && x.wallet !== wallet);
    rows.push({ wallet: String(wallet), at }); buys.set(key, rows);
    const distinct = [...new Set(rows.map(x => x.wallet))];
    return distinct.length >= 2 ? { signal: 'SMART_MONEY_CONFLUENCE', mint: key, wallets: distinct.length, windowMinutes: 15, at } : null;
  };
}

/** A WebSocket source is event-only: no polling or reconnect spin. */
export class SolanaEventListener {
  constructor({ wsUrl = process.env.SOLANA_RPC_WSS, wallets = [], pumpProgramId = process.env.PUMPFUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', raydiumProgramIds = (process.env.RAYDIUM_PROGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean), onMint = () => {}, onWalletLog = () => {}, onError = console.error, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.wsUrl = wsUrl; this.wallets = wallets.slice(0, 30); this.pumpProgramId = pumpProgramId;
    this.raydiumProgramIds = raydiumProgramIds; this.onMint = onMint; this.onWalletLog = onWalletLog; this.onError = onError; this.WebSocketImpl = WebSocketImpl;
    this.socket = null; this.nextId = 1; this.subscriptions = new Map(); this.closed = false;
  }
  start() {
    if (!this.wsUrl) throw new Error('SOLANA_RPC_WSS missing; event listener not started');
    if (!this.WebSocketImpl) throw new Error('WebSocket API unavailable; use Node 22+');
    this.socket = new this.WebSocketImpl(this.wsUrl);
    this.socket.addEventListener('open', () => {
      this.subscribeLogs(this.pumpProgramId, 'pump-migration');
      for (const program of this.raydiumProgramIds) this.subscribeLogs(program, 'raydium-pool-init');
      for (const wallet of this.wallets) this.subscribeLogs(wallet, 'smart-wallet');
    });
    this.socket.addEventListener('message', event => { try { this.handle(JSON.parse(String(event.data))); } catch (e) { this.onError(e); } });
    this.socket.addEventListener('error', () => this.onError(new Error('Solana WebSocket connection error')));
    this.socket.addEventListener('close', () => { if (!this.closed) this.onError(new Error('Solana WebSocket closed; restart process to reconnect')); });
    return this;
  }
  subscribeLogs(address, kind) {
    if (!address) return;
    const id = this.nextId++; this.subscriptions.set(id, { address, kind });
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [address] }, { commitment: 'confirmed' }] }));
  }
  handle(message) {
    if (message.id && message.result) { this.subscriptions.set(Number(message.result), this.subscriptions.get(Number(message.id)) || { kind: 'unknown' }); return; }
    const value = message.params?.result?.value; if (!value) return;
    const logs = Array.isArray(value.logs) ? value.logs : [];
    const signature = value.signature; const sub = this.subscriptions.get(Number(message.params.subscription)) || {};
    if (value.err) return;
    if (sub.kind === 'smart-wallet') { this.onWalletLog({ wallet: sub.address, signature, slot: message.params.result.context?.slot, logs }); return; }
    const joined = logs.join(' ').toLowerCase();
    const pumpMigration = sub.kind === 'pump-migration' && /migrat|complete.*bonding|graduate/.test(joined);
    const raydiumInit = sub.kind === 'raydium-pool-init' && /initialize|init.*pool|create.*pool/.test(joined);
    if (pumpMigration || raydiumInit) this.onMint({ trigger: pumpMigration ? 'pump-migration' : 'raydium-pool-init', signature, slot: message.params.result.context?.slot, program: sub.address, logs });
  }
  stop() { this.closed = true; try { this.socket?.close(); } catch {} }
}

export async function extractMintsFromTransaction(tx) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const accounts = keys.map(x => typeof x === 'string' ? x : x.pubkey).filter(Boolean);
  const pre = tx?.meta?.preTokenBalances || [], post = tx?.meta?.postTokenBalances || [];
  const changed = new Set([...pre, ...post].map(x => x.mint).filter(Boolean));
  return [...changed].filter(mint => !accounts.includes(mint) || accounts.includes(mint));
}

export function computeEdgeProof(trades = []) {
  const valid = trades.filter(t => Number.isFinite(Number(t.netPnlUsd)));
  const wins = valid.filter(t => Number(t.netPnlUsd) > 0), losses = valid.filter(t => Number(t.netPnlUsd) < 0);
  const grossWin = wins.reduce((s, t) => s + Number(t.netPnlUsd), 0), grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.netPnlUsd), 0));
  const largest = valid.reduce((best, t) => Number(t.netPnlUsd) > Number(best?.netPnlUsd ?? -Infinity) ? t : best, null);
  const adjusted = valid.filter(t => t !== largest);
  const adjustedWins = adjusted.filter(t => Number(t.netPnlUsd) > 0).reduce((s,t)=>s+Number(t.netPnlUsd),0);
  const adjustedLosses = Math.abs(adjusted.filter(t => Number(t.netPnlUsd) < 0).reduce((s,t)=>s+Number(t.netPnlUsd),0));
  return { closedTrades: valid.length, winRatePct: valid.length ? wins.length / valid.length * 100 : null, profitFactor: grossLoss ? grossWin / grossLoss : (grossWin ? null : 0), maxDrawdownPct: null, outlierAdjustedPnlUsd: adjusted.reduce((s,t)=>s+Number(t.netPnlUsd),0), outlierAdjustedProfitFactor: adjustedLosses ? adjustedWins / adjustedLosses : (adjustedWins ? null : 0), EDGE_VERIFIED: valid.length >= 100 && adjustedWins > adjustedLosses && adjustedWins > 0 };
}
