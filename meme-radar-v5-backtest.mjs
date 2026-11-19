/**
 * Offline research backtester for MEME.RADAR v5 JSONL snapshots.
 * No exchange connectivity and no order execution.
 */
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export function backtestSnapshots(rows, options = {}) {
  const threshold = finite(options.minimumScore ?? 80);
  const horizonMs = Math.max(1, finite(options.horizonMinutes ?? 60)) * 60000;
  const feeRate = Math.max(0, Math.min(0.25, finite(options.roundTripFeeRate ?? 0.006)));
  const cooldownMs = Math.max(0, finite(options.tokenCooldownMinutes ?? 60)) * 60000;
  const clean = (Array.isArray(rows) ? rows : [])
    .map(row => ({ ...row, ts: Date.parse(row.recordedAt), price: finite(row.priceUsd), score: finite(row.score), token: String(row.token || row.pairAddress || '') }))
    .filter(row => Number.isFinite(row.ts) && row.price > 0 && row.token)
    .sort((a, b) => a.ts - b.ts);
  const lastEntryByToken = new Map();
  const trades = [];
  let missingExitSnapshots = 0;

  for (let i = 0; i < clean.length; i++) {
    const entry = clean[i];
    if (entry.score < threshold || entry.decision === 'REJECT') continue;
    if (entry.ts - (lastEntryByToken.get(entry.token) ?? -Infinity) < cooldownMs) continue;
    const exit = clean.slice(i + 1).find(row => row.token === entry.token && row.ts >= entry.ts + horizonMs);
    if (!exit) { missingExitSnapshots++; continue; }
    const grossReturn = exit.price / entry.price - 1;
    const netReturn = (1 + grossReturn) * (1 - feeRate) - 1;
    trades.push({
      token: entry.token, symbol: entry.symbol || 'UNKNOWN',
      entryTime: entry.recordedAt, exitTime: exit.recordedAt,
      entryPrice: entry.price, exitPrice: exit.price,
      score: entry.score, grossReturnPct: grossReturn * 100,
      netReturnPct: netReturn * 100
    });
    lastEntryByToken.set(entry.token, entry.ts);
  }

  let equity = 1, peak = 1, maxDrawdownPct = 0;
  for (const trade of trades) {
    equity *= 1 + trade.netReturnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
  }
  const returns = trades.map(trade => trade.netReturnPct).sort((a, b) => a - b);
  const sum = returns.reduce((total, value) => total + value, 0);
  const median = returns.length ? (returns.length % 2 ? returns[(returns.length - 1) / 2] : (returns[returns.length / 2 - 1] + returns[returns.length / 2]) / 2) : null;
  return {
    mode: 'offline-historical-snapshot-backtest',
    options: { minimumScore: threshold, horizonMinutes: horizonMs / 60000, roundTripFeeRate: feeRate, tokenCooldownMinutes: cooldownMs / 60000 },
    snapshotsUsed: clean.length, trades: trades.length, missingExitSnapshots,
    winRatePct: trades.length ? trades.filter(trade => trade.netReturnPct > 0).length / trades.length * 100 : null,
    averageNetReturnPct: trades.length ? sum / trades.length : null,
    medianNetReturnPct: median,
    compoundedReturnPct: (equity - 1) * 100,
    maxDrawdownPct,
    results: trades
  };
}

export async function readJsonlSnapshots(filePath, fsModule = await import('node:fs/promises')) {
  const content = await fsModule.readFile(filePath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return content.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
