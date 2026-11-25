import test from 'node:test';
import * as requireHolderModule from './meme-radar-v5-intelligence.mjs';
import assert from 'node:assert/strict';
import {
  scoreCandidate, estimateConstantProductImpact,
  calculatePaperBuy, calculatePaperSell, calculateJupiterQuoteExit, evaluateDiscoveryPrefilter, analyzeNarrativeFootprint, summarizePaperLearning, detectBasicMarketWarnings, analyzeCreatorSignals, summarizeCrossTokenClusters, evaluateSolanaHardSecurityGates
} from './meme-radar-v5-intelligence.mjs';

const healthyPair = {
  liquidity: { usd: 250000 },
  volume: { h1: 180000, h24: 900000 },
  fdv: 2000000,
  txns: { m5: { buys: 60, sells: 40 }, h1: { buys: 180, sells: 100 }, h24: { buys: 1600, sells: 1100 } },
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
  assert.equal(a.version, '5.1.0');
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


test('creator signal analysis detects authority-holder overlap and reused mint authority', () => {
  const result = analyzeCreatorSignals({
    mintAuthority: 'CreatorWalletAddress111111111111111111111',
    freezeAuthority: null,
    authoritySignatureCount: 520,
    holderOwners: ['CreatorWalletAddress111111111111111111111', 'HolderWalletAddress222222222222222222222', 'HolderWalletAddress222222222222222222222'],
    priorAuthorityRows: [{ token: 'old-token', creatorSignals: { mintAuthority: 'CreatorWalletAddress111111111111111111111' } }]
  });
  assert.equal(result.authorityHolderOverlap.length, 1);
  assert.equal(result.reusedMintAuthorityTokens, 1);
  assert.equal(result.repeatedHolderOwners.length, 1);
  assert.ok(result.warnings.length >= 3);
});

test('creator signal analysis does not invent missing authority data', () => {
  const result = analyzeCreatorSignals();
  assert.equal(result.mintAuthority, null);
  assert.equal(result.freezeAuthority, null);
  assert.equal(result.authoritySignatureCount, null);
  assert.equal(result.reusedMintAuthorityTokens, 0);
});


test('cross-token clusters group repeated RPC-observed authorities and owners', () => {
  const rows = [
    { token: 'token-A', creatorSignals: { mintAuthority: 'WalletAuthority111111111111111111111', holderOwnerAddresses: ['SharedHolder111111111111111111111'] } },
    { token: 'token-B', creatorSignals: { mintAuthority: 'WalletAuthority111111111111111111111', holderOwnerAddresses: ['SharedHolder111111111111111111111'] } },
    { token: 'token-C', creatorSignals: { mintAuthority: 'DifferentWallet111111111111111111111' } }
  ];
  const clusters = summarizeCrossTokenClusters(rows);
  assert.equal(clusters.length, 2);
  assert.ok(clusters.some(x => x.signalType === 'mint-authority' && x.tokenCount === 2));
  assert.ok(clusters.some(x => x.signalType === 'holder-owner' && x.tokenCount === 2));
});

test('cross-token clustering ignores one-token and malformed observations', () => {
  assert.deepEqual(summarizeCrossTokenClusters([
    { token: 'only-one', creatorSignals: { mintAuthority: 'WalletAuthority111111111111111111111' } },
    { token: null, creatorSignals: { mintAuthority: 'AnotherWallet111111111111111111111' } }
  ]), []);
});


test('discovery prefilter explains every failed cheap gate', () => {
  const result = evaluateDiscoveryPrefilter({ liquidity: { usd: 1000 }, fdv: 100000, volume: { h24: 10 }, txns: { h1: { sells: 0 }, h24: { buys: 0, sells: 0 } } });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes('liquidity below minimum'));
  assert.ok(result.reasons.includes('24h buy ratio unavailable'));
  assert.equal(result.metrics.buyRatioPct, null);
});

test('discovery prefilter passes a candidate meeting configured thresholds', () => {
  const result = evaluateDiscoveryPrefilter({ liquidity: { usd: 100000 }, fdv: 1000000, volume: { h24: 100000 }, pairCreatedAt: Date.now() - 3600000, priceChange: { m5: 3, h1: 10 }, txns: { m5: { buys: 60, sells: 40 }, h1: { sells: 20 }, h24: { buys: 70, sells: 30 } } });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('Jupiter quote-only output converts raw USDC units into paper exit proceeds', () => {
  const result = calculateJupiterQuoteExit({
    quote: { outAmount: '9750000', router: 'metis', transaction: null },
    tokens: 1000, spotPrice: 0.01, outputDecimals: 6
  });
  assert.equal(result.netProceeds, 9.75);
  assert.equal(result.effectivePrice, 0.00975);
  assert.equal(result.model, 'jupiter-route-quote');
  assert.equal(result.quoteOnly, true);
  assert.equal(result.router, 'metis');
});

test('Jupiter quote parser fails closed on missing, malformed or zero output', () => {
  assert.throws(() => calculateJupiterQuoteExit({ quote: {}, tokens: 100, spotPrice: 1 }));
  assert.throws(() => calculateJupiterQuoteExit({ quote: { outAmount: 'abc' }, tokens: 100, spotPrice: 1 }));
  assert.throws(() => calculateJupiterQuoteExit({ quote: { outAmount: '0' }, tokens: 100, spotPrice: 1 }));
});

test('Engine 5 scores observable website and social footprint without claiming sentiment', () => {
  const result = analyzeNarrativeFootprint({
    baseToken: { name: 'Example Token', symbol: 'EX' },
    info: {
      websites: [{ url: 'https://example.org' }],
      socials: [{ type: 'twitter', url: 'https://x.com/example' }, { type: 'telegram', url: 'https://t.me/example' }]
    }
  });
  assert.equal(result.websiteCount, 1);
  assert.equal(result.socialLinkCount, 2);
  assert.equal(result.sentimentAnalyzed, false);
  assert.equal(result.engagementVerified, false);
  assert.equal(result.tier, 'BROAD_FOOTPRINT');
});

test('Engine 5 treats absent metadata as unknown/thin footprint, not a scam verdict', () => {
  const result = analyzeNarrativeFootprint({});
  assert.equal(result.tier, 'THIN_FOOTPRINT');
  assert.ok(result.flags.length >= 2);
});

test('Engine 6 reports descriptive paper-trade outcomes and sample sufficiency', () => {
  const small = summarizePaperLearning([
    { netPnlUsd: 2, netPnlPct: 2, exitTime: 1 },
    { netPnlUsd: -1, netPnlPct: -1, exitTime: 2 }
  ]);
  assert.equal(small.sampleSize, 2);
  assert.equal(small.evidence, 'INSUFFICIENT_SAMPLE');
  assert.equal(small.autoTuningEnabled, false);
  const enough = summarizePaperLearning(Array.from({ length: 20 }, (_, i) => ({
    netPnlUsd: i % 2 ? -1 : 2, netPnlPct: i % 2 ? -1 : 2, exitTime: i + 1
  })));
  assert.equal(enough.evidence, 'SAMPLE_AVAILABLE');
  assert.equal(enough.sampleSize, 20);
});

test('Solana hard security gates reject active authorities, concentration, overlap and reused authority',()=>{
 const result=evaluateSolanaHardSecurityGates({
  mintAuthority:'MintAuthorityAddress111111111111111111111',
  freezeAuthority:'FreezeAuthorityAddress222222222222222222222',
  holderDistribution:{known:true,top5Pct:30,top10Pct:45},
  creatorSignals:{authorityHolderOverlap:['MintAuthorityAddress111111111111111111111'],reusedMintAuthorityTokens:2}
 });
 assert.equal(result.pass,false);
 assert.ok(result.reasons.length>=5);
});
