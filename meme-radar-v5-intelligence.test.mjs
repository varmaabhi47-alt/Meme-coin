import test from 'node:test';
import * as requireHolderModule from './meme-radar-v5-intelligence.mjs';
import assert from 'node:assert/strict';
import {
  scoreCandidate, estimateConstantProductImpact,
  calculatePaperBuy, calculatePaperSell, detectBasicMarketWarnings
} from './meme-radar-v5-intelligence.mjs';

const healthyPair = {
  liquidity: { usd: 250000 },
  volume: { h1: 180000, h24: 900000 },
  fdv: 2000000,
  txns: { h1: { buys: 180, sells: 100 }, h24: { buys: 1600, sells: 1100 } },
  priceChange: { m5: 3, h1: 12 },
  pairCreatedAt: Date.now() - 86400000
};

test('security failure is always a hard reject', () => {
  const result = scoreCandidate(healthyPair, { pass: false });
  assert.equal(result.hardReject, true);
  assert.equal(result.tier, 'REJECT');
  assert.ok(result.reasons.includes('security audit not passed'));
});

test('healthy candidate gets a deterministic, bounded score', () => {
  const a = scoreCandidate(healthyPair, { pass: true });
  const b = scoreCandidate(healthyPair, { pass: true });
  assert.equal(a.score, b.score);
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.equal(a.version, '5.0.0');
});

test('low liquidity and thin activity are rejected', () => {
  const result = scoreCandidate({ liquidity: { usd: 1000 }, volume: { h24: 10 }, txns: {}, fdv: 100000, priceChange: {} }, { pass: true });
  assert.equal(result.tier, 'REJECT');
  assert.ok(result.reasons.some(x => x.includes('liquidity')));
});

test('impact rises as trade size rises and falls as liquidity rises', () => {
  const small = estimateConstantProductImpact(100, 100000);
  const large = estimateConstantProductImpact(1000, 100000);
  const deep = estimateConstantProductImpact(100, 1000000);
  assert.ok(large.impactRate > small.impactRate);
  assert.ok(deep.impactRate < small.impactRate);
});

test('paper buy and sell include fees and positive quantities', () => {
  const buy = calculatePaperBuy(100, 1, 100000);
  const sell = calculatePaperSell(buy.tokens, 1.1, 100000);
  assert.ok(buy.tokens > 0);
  assert.ok(buy.feeUsd > 0);
  assert.ok(sell.netProceeds > 0);
  assert.ok(sell.feeUsd > 0);
});

test('invalid execution inputs fail closed', () => {
  assert.throws(() => calculatePaperBuy(0, 1, 1000));
  assert.throws(() => calculatePaperSell(1, 1, 0));
});

test('basic manipulation warnings detect extreme turnover and sell pressure', () => {
  const warnings = detectBasicMarketWarnings({
    liquidity: { usd: 10000 }, volume: { h1: 90000 },
    txns: { h1: { buys: 10, sells: 30 } }, priceChange: { m5: 40 }
  });
  assert.ok(warnings.length >= 3);
});

test('top holder concentration is calculated from raw token account balances', () => {
  const { calculateTopHolderConcentration } = requireHolderModule;
  const result = calculateTopHolderConcentration([{amount:'400'},{amount:'300'},{amount:'100'},{amount:'100'},{amount:'50'},{amount:'50'}], '2000');
  assert.equal(result.known, true);
  assert.equal(result.top5Pct, 47.5);
  assert.equal(result.top10Pct, 50);
});

test('holder concentration returns unknown for missing supply', () => {
  const { calculateTopHolderConcentration } = requireHolderModule;
  assert.equal(calculateTopHolderConcentration([], '0').known, false);
});
