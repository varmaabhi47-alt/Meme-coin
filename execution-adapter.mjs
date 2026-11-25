/**
 * Execution boundary. Paper mode is the only enabled adapter by default.
 * Live adapter requires an externally supplied signer + Sender client so no
 * secret key is ever stored in this repository or in browser code.
 */
export function validateJitodontfrontReadonly(transaction) {
  const address = 'jitodontfront111111111111111111111111111111';
  const message = transaction?.message || transaction?.compileMessage?.();
  const keys = message?.staticAccountKeys || message?.accountKeys;
  if (!Array.isArray(keys)) return false;
  const index = keys.findIndex(key => (typeof key === 'string' ? key : key?.toBase58?.()) === address);
  if (index < 0) return false;
  if (typeof message.isAccountWritable === 'function') return message.isAccountWritable(index) === false;
  const header = message.header;
  if (!header) return false;
  const signed = Number(header.numRequiredSignatures || 0);
  const readonlySigned = Number(header.numReadonlySignedAccounts || 0);
  const readonlyUnsigned = Number(header.numReadonlyUnsignedAccounts || 0);
  return index < signed ? index >= signed - readonlySigned : index >= keys.length - readonlyUnsigned;
}

export async function sendViaHeliusSender(signedTransaction, { endpoint = process.env.HELIUS_SENDER_ENDPOINT || 'https://sender.helius-rpc.com/fast', fetchImpl = fetch } = {}) {
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== 'https:' || endpointUrl.hostname !== 'sender.helius-rpc.com' || endpointUrl.pathname !== '/fast') throw new Error('Helius Sender endpoint must be the verified HTTPS /fast endpoint');
  const bytes=typeof signedTransaction==='string'?signedTransaction:Buffer.from(signedTransaction.serialize?signedTransaction.serialize():signedTransaction).toString('base64');
  const response=await fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:Date.now().toString(),method:'sendTransaction',params:[bytes,{encoding:'base64',skipPreflight:true,maxRetries:0}]})});
  if(!response.ok)throw new Error('Helius Sender HTTP '+response.status);
  const body=await response.json();if(body.error)throw new Error('Helius Sender: '+body.error.message);if(!body.result)throw new Error('Helius Sender returned no signature');return body.result;
}

export class PaperExecutionAdapter {
  constructor({ quoteExit, quoteEntry } = {}) { this.quoteExit = quoteExit; this.quoteEntry = quoteEntry; this.mode = 'paper'; }
  async buy({ usd, pair, security, decimals }) { if (!this.quoteEntry) throw new Error('Paper entry quote provider missing'); return this.quoteEntry(usd, pair, security, decimals); }
  async sell({ position, price, liquidity }) { if (!this.quoteExit) throw new Error('Paper exit quote provider missing'); return this.quoteExit(position, price, liquidity); }
}

export class SolanaLiveExecutionAdapter {
  constructor({ signer, buildJupiterSwap, sendViaHeliusSender: sender = sendViaHeliusSender, confirmationKey = process.env.LIVE_CONFIRMATION_KEY, enabled = process.env.LIVE_TRADING === 'true', maxTradeSol = Number(process.env.MAX_TRADE_SOL || 0.05), maxDailySol = Number(process.env.MAX_DAILY_SOL || 0.25), telegramChatId = process.env.TELEGRAM_CHAT_ID } = {}) {
    this.enabled = enabled && Boolean(confirmationKey); this.confirmationKey = confirmationKey; this.signer = signer; this.buildJupiterSwap = buildJupiterSwap; this.sendViaHeliusSender = sender;
    this.maxTradeSol = Math.min(0.05, Math.max(0, maxTradeSol)); this.maxDailySol = Math.min(0.25, Math.max(0, maxDailySol)); this.dailySpentSol = 0; this.day = new Date().toISOString().slice(0,10); this.telegramChatId = String(telegramChatId || ''); this.killed = false;
  }
  assertEnabled(chatId) {
    if (!this.enabled || process.env.LIVE_TRADING !== 'true' || !this.confirmationKey) throw new Error('Live execution disabled: LIVE_TRADING and LIVE_CONFIRMATION_KEY are both required');
    if (!this.signer || !this.buildJupiterSwap || !this.sendViaHeliusSender) throw new Error('Live adapter requires signer, Jupiter transaction builder and Helius Sender client');
    if (this.killed) throw new Error('LIVE_KILL_SWITCH: new buys halted and live adapter locked');
    if (chatId != null && String(chatId) !== this.telegramChatId) throw new Error('Unauthorized Telegram control');
  }
  async buy({ amountSol, ...order }, { chatId } = {}) {
    this.assertEnabled(chatId);
    const day = new Date().toISOString().slice(0,10); if (day !== this.day) { this.day = day; this.dailySpentSol = 0; }
    const amount = Number(amountSol);
    if (!(amount > 0) || amount > this.maxTradeSol || this.dailySpentSol + amount > this.maxDailySol) throw new Error('LIVE_SAFETY_CAP: SOL per-trade/daily cap exceeded');
    const built = await this.buildJupiterSwap({ ...order, amountSol: amount, dynamicSlippage: true, tightSlippageBps: 50, sandwichProtectionAccount: 'jitodontfront111111111111111111111111111111', requireReadOnlySandwichAccount: true });
    if(!built?.transaction||built.dynamicSlippageApplied!==true||!validateJitodontfrontReadonly(built.transaction))throw new Error('Live swap builder must return a transaction with dynamic slippage applied and jitodontfront verified read-only in the compiled message');
    const signed = await this.signer.signTransaction(built.transaction);
    const signature = await this.sendViaHeliusSender(signed);
    this.dailySpentSol += amount; return { signature, amountSol: amount, live: true };
  }
  async sell(order, options = {}) { this.assertEnabled(options.chatId); const built = await this.buildJupiterSwap({ ...order, dynamicSlippage: true, tightSlippageBps: 50, sandwichProtectionAccount: 'jitodontfront111111111111111111111111111111', requireReadOnlySandwichAccount: true }); if(!built?.transaction||built.dynamicSlippageApplied!==true||!validateJitodontfrontReadonly(built.transaction))throw new Error('Live swap builder must return a transaction with dynamic slippage applied and jitodontfront verified read-only in the compiled message'); const signed = await this.signer.signTransaction(built.transaction); return { signature: await this.sendViaHeliusSender(signed), live: true }; }
  async handleTelegramCommand(command, chatId, { flattenOpenPositions } = {}) { if (String(chatId) !== this.telegramChatId) return false; if (command === '/kill') { this.killed = true; if (this.enabled && typeof flattenOpenPositions === 'function') await flattenOpenPositions(); return true; } return false; }
}
