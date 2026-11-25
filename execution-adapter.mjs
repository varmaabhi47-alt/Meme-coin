/**
 * Execution boundary. Paper mode is the only enabled adapter by default.
 * Live adapter requires an externally supplied signer + Sender client so no
 * secret key is ever stored in this repository or in browser code.
 */
export class PaperExecutionAdapter {
  constructor({ quoteExit, quoteEntry } = {}) { this.quoteExit = quoteExit; this.quoteEntry = quoteEntry; this.mode = 'paper'; }
  async buy(order) { if (!this.quoteEntry) throw new Error('Paper entry quote provider missing'); return this.quoteEntry(order); }
  async sell(order) { if (!this.quoteExit) throw new Error('Paper exit quote provider missing'); return this.quoteExit(order); }
}

export class SolanaLiveExecutionAdapter {
  constructor({ signer, buildJupiterSwap, sendViaHeliusSender, confirmationKey = process.env.LIVE_CONFIRMATION_KEY, enabled = process.env.LIVE_TRADING === 'true', maxTradeSol = Number(process.env.MAX_TRADE_SOL || 0.05), maxDailySol = Number(process.env.MAX_DAILY_SOL || 0.25), telegramChatId = process.env.TELEGRAM_CHAT_ID } = {}) {
    this.enabled = enabled && Boolean(confirmationKey); this.confirmationKey = confirmationKey; this.signer = signer; this.buildJupiterSwap = buildJupiterSwap; this.sendViaHeliusSender = sendViaHeliusSender;
    this.maxTradeSol = Math.max(0, maxTradeSol); this.maxDailySol = Math.max(0, maxDailySol); this.dailySpentSol = 0; this.day = new Date().toISOString().slice(0,10); this.telegramChatId = String(telegramChatId || ''); this.killed = false;
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
    const tx = await this.buildJupiterSwap({ ...order, amountSol: amount, dynamicSlippage: true, tightSlippageBps: 50, sandwichProtectionAccount: 'jitodontfront111111111111111111111111111111' });
    const signed = await this.signer.signTransaction(tx);
    const signature = await this.sendViaHeliusSender(signed);
    this.dailySpentSol += amount; return { signature, amountSol: amount, live: true };
  }
  async sell(order, options = {}) { this.assertEnabled(options.chatId); const tx = await this.buildJupiterSwap({ ...order, dynamicSlippage: true, tightSlippageBps: 50, sandwichProtectionAccount: 'jitodontfront111111111111111111111111111111' }); const signed = await this.signer.signTransaction(tx); return { signature: await this.sendViaHeliusSender(signed), live: true }; }
  handleTelegramCommand(command, chatId) { if (String(chatId) !== this.telegramChatId) return false; if (command === '/kill') { this.killed = true; return true; } return false; }
}
