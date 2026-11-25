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
    this.creditCost = creditCost; this.fetchImpl = fetchImpl; this.lastCall = 0; this.rateTail = Promise.resolve();
    this.cache = new Map(); this.usage = { month: new Date().toISOString().slice(0, 7), calls: 0, estimatedCredits: 0, daily: {}, lastAt: null };
  }
  async load() {
    try { const x = JSON.parse(await fs.readFile(this.stateFile, 'utf8')); if (x.month === this.usage.month) this.usage = { ...this.usage, ...x, daily: x.daily || {} }; } catch {}
    try { const rows=JSON.parse(await fs.readFile(this.stateFile+'.cache','utf8')); for(const [key,row] of Object.entries(rows)) if(row&&now()-row.at<this.cacheMs)this.cache.set(key,row); } catch {}
  }
  async save() { await fs.writeFile(this.stateFile, JSON.stringify(this.usage), 'utf8'); }
  async rateLimit(count=1) {
    const run=this.rateTail.then(async()=>{const minGap=Math.max(1,Number(count)||1)*1000/this.maxRps;const wait=Math.max(0,minGap-(now()-this.lastCall));if(wait)await sleep(wait);this.lastCall=now();});
    this.rateTail=run.catch(()=>{});await run;
  }
  async cached(key, fn) {
    const row = this.cache.get(key);
    if (row && now() - row.at < this.cacheMs) return row.value;
    for(const [oldKey,oldRow] of this.cache)if(now()-oldRow.at>=this.cacheMs)this.cache.delete(oldKey);
    const value = await fn(); this.cache.set(key, { at: now(), value });
    try { await fs.writeFile(this.stateFile+'.cache',JSON.stringify(Object.fromEntries(this.cache)),'utf8'); } catch {}
    return value;
  }
  async rpc(endpoint, method, params = [], { credits = this.creditCost, cacheKey = null } = {}) {
    if (!endpoint) throw new Error('SOLANA_RPC_HTTP is not configured');
    if (cacheKey) return this.cached(cacheKey, () => this.rpc(endpoint, method, params, { credits }));
    const projected = this.usage.estimatedCredits + Number(credits || 0);
    if (projected * (30 / Math.max(1, new Date().getDate())) > this.monthlyLimit) {
      this.usage.budgetThrottled=true;await this.save();throw Object.assign(new Error('RPC_CREDIT_THROTTLE: projected monthly usage exceeds budget'), { code: 'RPC_BUDGET' });
    }
    let attempt = 0;
    while (true) {
      await this.rateLimit(1);
      try {
        const response = await this.fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: now(), method, params }) });
        if (response.status === 429) throw Object.assign(new Error('Solana RPC HTTP 429'), { status: 429 });
        if (!response.ok) throw new Error('Solana RPC HTTP ' + response.status);
        const body = await response.json(); if (body.error) throw new Error('Solana RPC ' + body.error.code + ': ' + body.error.message);
        this.usage.calls++; this.usage.estimatedCredits += Number(credits || 0); this.usage.daily[new Date().toISOString().slice(0,10)]=(this.usage.daily[new Date().toISOString().slice(0,10)]||0)+Number(credits||0); this.usage.lastAt = new Date().toISOString();
        await this.save(); return body.result;
      } catch (error) {
        if (error.status !== 429 || attempt >= 5) throw error;
        await sleep(Math.min(30_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250)); attempt++;
      }
    }
  }
  async batch(endpoint, requests, { credits = requests.length } = {}) {
    const all=[]; for(let i=0;i<requests.length;i+=this.maxRps){const chunk=requests.slice(i,i+this.maxRps);all.push(...await this.batchChunk(endpoint,chunk,{credits:chunk.length}));} return all.sort((a,b)=>Number(a?.slot||0)-Number(b?.slot||0));
  }
  async batchChunk(endpoint, requests, { credits = requests.length } = {}) {
    if (!endpoint) throw new Error('SOLANA_RPC_HTTP is not configured');
    const projected=this.usage.estimatedCredits+Number(credits||0);
    if(projected*30/Math.max(1,new Date().getDate())>this.monthlyLimit){this.usage.budgetThrottled=true;await this.save();throw Object.assign(new Error('RPC_CREDIT_THROTTLE: projected monthly usage exceeds budget'),{code:'RPC_BUDGET'});}
    let attempt=0;
    while(true){
      await this.rateLimit(requests.length);
      try{
        const response=await this.fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(requests)});
        if(response.status===429)throw Object.assign(new Error('Solana RPC HTTP 429'),{status:429});
        if(!response.ok)throw new Error('Solana RPC HTTP '+response.status);
        const data=await response.json();if(!Array.isArray(data))throw new Error('Solana RPC batch response was not an array');
        const errors=data.filter(x=>x.error);if(errors.length)throw new Error('Solana RPC batch error: '+errors[0].error.message);
        this.usage.calls++;this.usage.estimatedCredits+=Number(credits||0);this.usage.daily[new Date().toISOString().slice(0,10)]=(this.usage.daily[new Date().toISOString().slice(0,10)]||0)+Number(credits||0);this.usage.lastAt=new Date().toISOString();await this.save();
        return data.sort((a,b)=>Number(a.id)-Number(b.id)).map(x=>x.result);
      }catch(error){if(error.status!==429||attempt>=5)throw error;await sleep(Math.min(30000,500*2**attempt)+Math.floor(Math.random()*250));attempt++;}
    }
  }
  telemetry() { const today=new Date().toISOString().slice(0,10);return { ...this.usage, dailyEstimatedCredits:Number(this.usage.daily?.[today]||0), projectedMonthlyCredits: Math.round(this.usage.estimatedCredits * 30 / Math.max(1, new Date().getDate())), throttled: this.usage.budgetThrottled===true || this.usage.estimatedCredits * 30 / Math.max(1, new Date().getDate()) > this.monthlyLimit }; }
}

export function createSmartMoneyConfluence({ windowMs = 15 * 60_000 } = {}) {
  const buys = new Map();
  return (wallet, mint, at = now()) => {
    if (!wallet || !mint) return null;
    for(const [oldMint,oldRows] of buys){const fresh=oldRows.filter(x=>at-x.at<=windowMs);if(fresh.length)buys.set(oldMint,fresh);else buys.delete(oldMint);}
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
    this.subscriptions.clear(); this.nextId=1;
    this.socket = new this.WebSocketImpl(this.wsUrl);
    this.socket.addEventListener('open', () => {
      this.subscribeLogs(this.pumpProgramId, 'pump-migration');
      for (const program of this.raydiumProgramIds) this.subscribeLogs(program, 'raydium-pool-init');
      for (const wallet of this.wallets) this.subscribeLogs(wallet, 'smart-wallet');
    });
    this.socket.addEventListener('message', event => { try { this.handle(JSON.parse(String(event.data))); } catch (e) { this.onError(e); } });
    this.socket.addEventListener('error', () => this.onError(new Error('Solana WebSocket connection error')));
    this.socket.addEventListener('close', () => { if (!this.closed) { this.onError(new Error('Solana WebSocket closed; reconnecting in 5 seconds')); setTimeout(() => { if (!this.closed) this.start(); }, 5000); } });
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
  const pre = tx?.meta?.preTokenBalances || [], post = tx?.meta?.postTokenBalances || [];
  return [...new Set([...pre, ...post].map(x => x.mint).filter(Boolean))];
}

export function computeEdgeProof(trades = []) {
  const valid=trades.filter(t=>Number.isFinite(Number(t.netPnlUsd)));
  const wins=valid.filter(t=>Number(t.netPnlUsd)>0),losses=valid.filter(t=>Number(t.netPnlUsd)<0);
  const grossWin=wins.reduce((s,t)=>s+Number(t.netPnlUsd),0),grossLoss=Math.abs(losses.reduce((s,t)=>s+Number(t.netPnlUsd),0));
  const largestWinningTrade=wins.reduce((best,t)=>Number(t.netPnlUsd)>Number(best?.netPnlUsd??-Infinity)?t:best,null);
  const adjusted=largestWinningTrade?valid.filter(t=>t!==largestWinningTrade):valid;
  const adjustedWins=adjusted.filter(t=>Number(t.netPnlUsd)>0).reduce((s,t)=>s+Number(t.netPnlUsd),0);
  const adjustedLosses=Math.abs(adjusted.filter(t=>Number(t.netPnlUsd)<0).reduce((s,t)=>s+Number(t.netPnlUsd),0));
  const adjustedProfitFactor=adjustedLosses?adjustedWins/adjustedLosses:(adjustedWins>0?null:0);
  let equity=1,peak=1,maxDrawdownPct=0;
  for(const trade of valid){const ret=Number(trade.netPnlPct);if(Number.isFinite(ret))equity*=Math.max(0,1+ret/100);peak=Math.max(peak,equity);if(peak>0)maxDrawdownPct=Math.max(maxDrawdownPct,(peak-equity)/peak*100);}
  return {closedTrades:valid.length,winRatePct:valid.length?wins.length/valid.length*100:null,profitFactor:grossLoss?grossWin/grossLoss:(grossWin>0?null:0),maxDrawdownPct,netPnlUsd:valid.reduce((s,t)=>s+Number(t.netPnlUsd),0),outlierAdjustedPnlUsd:adjusted.reduce((s,t)=>s+Number(t.netPnlUsd),0),outlierAdjustedProfitFactor:adjustedProfitFactor,largestWinningTradePnlUsd:largestWinningTrade?Number(largestWinningTrade.netPnlUsd):null,EDGE_VERIFIED:valid.length>=100&&adjustedWins>adjustedLosses&&adjustedWins>0};
}

export function extractWalletTokenBuys(tx, wallet) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const index = keys.findIndex(x => (typeof x === 'string' ? x : x.pubkey) === wallet);
  if (index < 0) return [];
  const before = new Map((tx?.meta?.preTokenBalances || []).filter(x => x.owner === wallet && Number(x.accountIndex) >= 0).map(x => [x.mint, Number(x.uiTokenAmount?.uiAmountString || 0)]));
  const after = new Map((tx?.meta?.postTokenBalances || []).filter(x => x.owner === wallet && Number(x.accountIndex) >= 0).map(x => [x.mint, Number(x.uiTokenAmount?.uiAmountString || 0)]));
  return [...after].filter(([mint, amount]) => amount > (before.get(mint) || 0)).map(([mint]) => mint);
}
