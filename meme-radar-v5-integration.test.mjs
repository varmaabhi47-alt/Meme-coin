import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreCandidate,
  detectBasicMarketWarnings,
  evaluateDiscoveryPrefilter,
  calculateTopHolderConcentration,
  analyzeCreatorSignals,
  analyzeNarrativeFootprint,
  summarizePaperLearning,
  calculateJupiterQuoteExit
} from './meme-radar-v5-intelligence.mjs';
import { backtestSnapshots } from './meme-radar-v5-backtest.mjs';

// Sanitized DexScreener-shaped fixture: realistic field names and nesting,
// deliberately static so CI is reproducible and makes no external API calls.
const dexPair = {
  chainId: 'solana',
  dexId: 'raydium',
  pairAddress: 'FixturePair111111111111111111111111111111',
  baseToken: { address: 'FixtureMint11111111111111111111111111111', name: 'Fixture Meme', symbol: 'FIX' },
  priceUsd: '0.000042',
  fdv: 1800000,
  liquidity: { usd: 180000 },
  volume: { h1: 42000, h24: 650000 },
  txns: { m5: { buys: 60, sells: 40 }, h1: { buys: 210, sells: 130 }, h24: { buys: 2400, sells: 1800 } },
  priceChange: { m5: 2.4, h1: 8.1, h24: 19.5 },
  pairCreatedAt: 1760000000000,
  info: {
    websites: [{ label: 'Website', url: 'https://fixture.example' }],
    socials: [
      { type: 'twitter', url: 'https://x.com/fixture' },
      { type: 'telegram', url: 'https://t.me/fixture' },
      { type: 'discord', url: 'https://discord.gg/fixture' }
    ]
  }
};

test('integration: DexScreener-shaped healthy pair passes discovery and scores only after security pass', () => {
  const prefilter = evaluateDiscoveryPrefilter(dexPair, {
    MIN_LIQUIDITY_USD: 75000, MAX_TRADE_TO_LIQ_PCT: 0.5,
    MIN_LIQ_FDV_PCT: 5, MIN_SELLS_1H: 10,
    MIN_VOLUME_24H: 50000, MIN_BUY_RATIO_PCT: 55, TRADE_SIZE_USD: 100
  });
  assert.equal(prefilter.pass, true, prefilter.reasons.join('; '));
  const failedAudit = scoreCandidate(dexPair, { pass: false });
  assert.equal(failedAudit.tier, 'REJECT');
  assert.equal(failedAudit.hardReject, true);
  const passedAudit = scoreCandidate(dexPair, { pass: true });
  assert.notEqual(passedAudit.tier, 'REJECT');
  assert.ok(passedAudit.score >= 0 && passedAudit.score <= 100);
});

test('integration: market warnings flag suspicious real-shaped activity and missing pair age', () => {
  const warnings = detectBasicMarketWarnings({
    ...dexPair,
    pairCreatedAt: null,
    liquidity: { usd: 5000 },
    volume: { h1: 60000 },
    txns: { h1: { buys: 8, sells: 30 } },
    priceChange: { m5: 42 }
  });
  assert.ok(warnings.includes('high 1h turnover vs liquidity'));
  assert.ok(warnings.includes('sell pressure exceeds buys'));
  assert.ok(warnings.includes('extreme 5m price expansion'));
  assert.ok(warnings.includes('pair age unavailable'));
});

test('integration: absent or malformed market metrics fail discovery rather than being treated as safe', () => {
  const result = evaluateDiscoveryPrefilter({ baseToken: dexPair.baseToken });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes('liquidity unavailable'));
  assert.ok(result.reasons.includes('24h buy ratio unavailable'));
});

test('integration: holder concentration and creator signals preserve uncertainty', () => {
  const unknown = calculateTopHolderConcentration([{ amount: 'not-a-number' }], '0');
  assert.equal(unknown.known, false);
  const signals = analyzeCreatorSignals({ mintAuthority: null, freezeAuthority: null, holderOwners: [] });
  assert.equal(signals.mintAuthority, null);
  assert.equal(signals.authoritySignatureCount, null);
  assert.deepEqual(signals.warnings, []);
});

test('integration: public-profile metadata is counted, but sentiment and engagement remain unverified', () => {
  const result = analyzeNarrativeFootprint(dexPair);
  assert.equal(result.websiteCount, 1);
  assert.equal(result.socialLinkCount, 3);
  assert.equal(result.sentimentAnalyzed, false);
  assert.equal(result.engagementVerified, false);
});

test('integration: Jupiter malformed or empty route output is rejected for fallback handling', () => {
  assert.throws(() => calculateJupiterQuoteExit({
    quote: { outAmount: '0' }, tokens: 1000000, spotPrice: 0.000042
  }));
  assert.throws(() => calculateJupiterQuoteExit({
    quote: { outAmount: 'bad' }, tokens: 1000000, spotPrice: 0.000042
  }));
});

test('integration: learning stays insufficient until minimum completed paper-trade sample', () => {
  const result = summarizePaperLearning([
    { netPnlUsd: 1.2, netPnlPct: 1.2, exitTime: 1 },
    { netPnlUsd: -0.5, netPnlPct: -0.5, exitTime: 2 }
  ]);
  assert.equal(result.evidence, 'INSUFFICIENT_SAMPLE');
  assert.equal(result.autoTuningEnabled, false);
});

test('integration: historical backtest does not invent an exit when later snapshot is absent', () => {
  const result = backtestSnapshots([{
    token: 'fixture-token', recordedAt: '2026-01-01T00:00:00.000Z',
    priceUsd: 1, score: 90, decision: 'RESEARCH'
  }], { horizonMinutes: 60 });
  assert.equal(result.trades, 0);
  assert.equal(result.missingExitSnapshots, 1);
});
