/**
 * MEME.RADAR V5 risk/execution primitives.
 * Pure helpers; all prices and liquidity must originate from live provider data.
 */
export const EXIT_RULES = Object.freeze({
  partialTakeProfitNetPct: 40,
  partialTakeProfitFraction: 0.5,
  breakevenNetPct: 2,
  runnerTrailDropPct: 15,
  runnerTrailDropAbove100Pct: 20,
  runnerWideTrailGainPct: 100,
  stopLossNetPct: -18,
  liquidityDropFromEntryPct: 35,
  liquidityDropPerCheckPct: 20,
  maxHoldHours: 24
});

export function netReturnPct(position, markPrice, friction = 0) {
  const entry = Number(position?.buyPrice);
  const cost = Number(position?.remainingCostUsd ?? position?.costUsd);
  const qty = Number(position?.remainingTokens ?? position?.tokens);
  const mark = Number(markPrice);
  if (!(entry > 0 && cost > 0 && qty > 0 && mark > 0)) return null;
  return ((qty * mark * (1 - Math.max(0, Number(friction))) - cost) / cost) * 100;
}

/** Return actions for one position mark. Mutates position state only after caller confirms simulated fill. */
export function evaluatePositionRisk(position, options = {}) {
  const { markPrice, liquidityUsd, now = Date.now(), frictionRate = 0, netPnlPctOverride } = options;
  const price = Number(markPrice), liq = Number(liquidityUsd);
  if (!(price > 0) || !Number.isFinite(liq) || liq < 0) return { action: 'HOLD_STALE', reason: 'live mark/liquidity unavailable' };
  const entryLiq = Number(position.entryLiquidityUsd);
  const previousLiq = Number(position.lastLiquidityUsd);
  const dropEntry = entryLiq > 0 ? (liq <= 0 ? 100 : (entryLiq - liq) / entryLiq * 100) : 0;
  const dropCheck = previousLiq > 0 ? (liq <= 0 ? 100 : (previousLiq - liq) / previousLiq * 100) : 0;
  const entry = Number(position.buyPrice);
  const peak = Math.max(Number(position.peakPrice || entry), price);
  const gainPeak = entry > 0 ? (peak / entry - 1) * 100 : 0;
  const dropPeak = peak > 0 ? (peak - price) / peak * 100 : 0;
  const override=Number(netPnlPctOverride);
  const netPct=Number.isFinite(override)?override:netReturnPct(position,price,frictionRate);
  if (dropEntry > EXIT_RULES.liquidityDropFromEntryPct) return { action: 'EXIT_ALL', reason: 'LIQ_DROP_ENTRY', netPct, dropEntryPct: dropEntry, dropCheckPct: dropCheck, peakPrice: peak };
  if (dropCheck > EXIT_RULES.liquidityDropPerCheckPct) return { action: 'EXIT_ALL', reason: 'LIQ_DROP_CHECK', netPct, dropEntryPct: dropEntry, dropCheckPct: dropCheck, peakPrice: peak };
  const remainingFraction = Number(position.remainingFraction ?? 1);
  if (!position.partialTpDone && netPct !== null && netPct >= EXIT_RULES.partialTakeProfitNetPct) {
    return { action: 'PARTIAL_EXIT', reason: 'PARTIAL_TP_40', fraction: EXIT_RULES.partialTakeProfitFraction, netPct, peakPrice: peak };
  }
  if (position.partialTpDone && netPct !== null && netPct <= EXIT_RULES.breakevenNetPct) {
    return { action: 'EXIT_ALL', reason: 'BREAKEVEN_STOP', netPct, peakPrice: peak };
  }
  if (!position.partialTpDone && netPct !== null && netPct <= EXIT_RULES.stopLossNetPct) {
    return { action: 'EXIT_ALL', reason: 'STOP_LOSS', netPct, peakPrice: peak };
  }
  const holdHours = (now - Number(position.entryTime || now)) / 3600000;
  if (holdHours >= EXIT_RULES.maxHoldHours) return { action: 'EXIT_ALL', reason: 'MAX_HOLD', netPct, peakPrice: peak };
  if (position.partialTpDone && gainPeak >= EXIT_RULES.partialTakeProfitNetPct) {
    const trailPct = gainPeak > EXIT_RULES.runnerWideTrailGainPct ? EXIT_RULES.runnerTrailDropAbove100Pct : EXIT_RULES.runnerTrailDropPct;
    if (dropPeak * 1 >= trailPct) return { action: 'EXIT_ALL', reason: 'RUNNER_TRAILING', netPct, peakPrice: peak, trailDropPct: trailPct };
  }
  return { action: 'HOLD', netPct, peakPrice: peak, dropEntryPct: dropEntry, dropCheckPct: dropCheck };
}

export function calculatePositionSize({ equityUsd, poolLiquidityUsd, score, cashUsd, tier = 'RESEARCH', smartMoneyConfluence = false }) {
  const equity = Number(equityUsd), liquidity = Number(poolLiquidityUsd), cash = Number(cashUsd);
  if (!(equity > 0 && liquidity > 0 && cash > 0)) return 0;
  if (String(tier).toUpperCase() !== 'RESEARCH') return 0;
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore) || numericScore < 80) return 0;
  const scoreMultiplier = numericScore >= 90 ? 1 : 0.8;
  const base = equity * 0.06 * scoreMultiplier;
  return Math.max(0, Math.min(base, liquidity * 0.0035, cash));
}

export function checkCircuitBreakers({ realizedUnrealizedPnlUsd, dailyStartingEquityUsd, now = Date.now(), breaker = {}, consecutiveRiskExits = 0 }) {
  const dailyPct = Number(dailyStartingEquityUsd) > 0 ? Number(realizedUnrealizedPnlUsd) / Number(dailyStartingEquityUsd) * 100 : 0;
  if (dailyPct <= -12) return { pauseBuys: true, reason: 'DAILY_DRAWDOWN_12', pauseUntil: Math.max(Number(breaker.pauseUntil || 0), now + 12 * 3600000), dailyDrawdownPct: dailyPct };
  if (Number(consecutiveRiskExits) >= 3) return { pauseBuys: true, reason: 'CONSECUTIVE_RISK_EXITS', pauseUntil: Math.max(Number(breaker.pauseUntil || 0), now + 2 * 3600000), dailyDrawdownPct: dailyPct };
  return { pauseBuys: Number(breaker.pauseUntil || 0) > now, reason: breaker.reason || null, pauseUntil: Number(breaker.pauseUntil || 0), dailyDrawdownPct: dailyPct };
}

export function parseTelegramCommand(text) {
  const match = String(text || '').trim().match(/^\/(status|positions|pause|resume|kill)(?:@\w+)?$|^\/close(?:@\w+)?\s+([A-Za-z0-9._-]{1,32})$/i);
  if (!match) return null;
  if (/^\/close/i.test(String(text).trim())) return { command: 'close', symbol: match[2].toUpperCase() };
  return { command: String(text).trim().split(/[ @]/)[0].slice(1).toLowerCase() };
}

export function makeStateLock() {
  let tail = Promise.resolve();
  return async function withLock(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

export function dueResearchIntervals(entryTime, observedAt) {
  const elapsed = Number(observedAt) - Number(entryTime);
  return [5, 15, 30, 60, 240].filter(minutes => elapsed >= minutes * 60000);
}

export function computeTradeMetrics(trades = []) {
  const valid=trades.filter(t=>Number.isFinite(Number(t.netPnlUsd))),pnl=valid.map(t=>Number(t.netPnlUsd));
  const wins=pnl.filter(x=>x>0),losses=pnl.filter(x=>x<0),grossWins=wins.reduce((a,b)=>a+b,0),grossLosses=Math.abs(losses.reduce((a,b)=>a+b,0));
  let equity=1,peak=1,maxDrawdownPct=0;
  for(const trade of valid){const ret=Number(trade.netPnlPct);if(Number.isFinite(ret))equity*=Math.max(0,1+ret/100);peak=Math.max(peak,equity);if(peak>0)maxDrawdownPct=Math.max(maxDrawdownPct,(peak-equity)/peak*100);}
  const largestWinning=valid.reduce((best,t)=>Number(t.netPnlUsd)>Number(best?.netPnlUsd??-Infinity)&&Number(t.netPnlUsd)>0?t:best,null);
  const adjusted=largestWinning?valid.filter(t=>t!==largestWinning):valid;
  const adjustedWins=adjusted.filter(t=>Number(t.netPnlUsd)>0).reduce((a,t)=>a+Number(t.netPnlUsd),0),adjustedLosses=Math.abs(adjusted.filter(t=>Number(t.netPnlUsd)<0).reduce((a,t)=>a+Number(t.netPnlUsd),0));
  return {tradeCount:pnl.length,winRatePct:pnl.length?wins.length/pnl.length*100:null,profitFactor:grossLosses?grossWins/grossLosses:(grossWins>0?Infinity:null),maxDrawdownPct,netPnlUsd:pnl.reduce((a,b)=>a+b,0),outlierAdjustedPnlUsd:adjusted.reduce((a,t)=>a+Number(t.netPnlUsd),0),outlierAdjustedProfitFactor:adjustedLosses?adjustedWins/adjustedLosses:(adjustedWins>0?Infinity:null),EDGE_VERIFIED:pnl.length>=100&&adjustedWins>adjustedLosses&&adjustedWins>0};
}
