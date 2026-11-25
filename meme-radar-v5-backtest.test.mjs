import test from 'node:test';
import assert from 'node:assert/strict';
import { backtestSnapshots } from './meme-radar-v5-backtest.mjs';

const snapshots = [
  { recordedAt: '2026-01-01T00:00:00.000Z', token: 'A', symbol: 'AAA', priceUsd: 1, score: 90, decision: 'RESEARCH' },
  { recordedAt: '2026-01-01T01:00:00.000Z', token: 'A', symbol: 'AAA', priceUsd: 1.2, score: 20, decision: 'WATCH' },
  { recordedAt: '2026-01-01T00:00:00.000Z', token: 'B', symbol: 'BBB', priceUsd: 2, score: 90, decision: 'RESEARCH' },
  { recordedAt: '2026-01-01T01:00:00.000Z', token: 'B', symbol: 'BBB', priceUsd: 1, score: 20, decision: 'WATCH' }
];

test('backtest uses only entries with later horizon snapshots', () => {
  const result = backtestSnapshots(snapshots, { minimumScore: 80, horizonMinutes: 60, roundTripFeeRate: 0 });
  assert.equal(result.trades, 2);
  assert.equal(result.winRatePct, 50);
  assert.equal(result.snapshotsUsed, 4);
});

test('backtest applies round-trip fees and reports compounded return', () => {
  const result = backtestSnapshots(snapshots, { minimumScore: 80, horizonMinutes: 60, roundTripFeeRate: 0.01 });
  assert.ok(result.results[0].netReturnPct < result.results[0].grossReturnPct);
  assert.ok(Number.isFinite(result.compoundedReturnPct));
});

test('missing future snapshots are not fabricated', () => {
  const result = backtestSnapshots([snapshots[0]], { horizonMinutes: 60 });
  assert.equal(result.trades, 0);
  assert.equal(result.missingExitSnapshots, 1);
  assert.equal(result.winRatePct, null);
});

test('backtest is deterministic and handles empty input', () => {
  const a = backtestSnapshots(snapshots);
  const b = backtestSnapshots(snapshots);
  assert.deepEqual(a, b);
  assert.equal(backtestSnapshots([]).trades, 0);
});

test('staged replay takes partial profit then exits runner on trailing stop',()=>{
 const rows=[
  {token:'runner',symbol:'RUN',recordedAt:'2026-01-01T00:00:00.000Z',priceUsd:1,liquidityUsd:100000,score:92,tier:'RESEARCH',security:{pass:true},decision:'RESEARCH'},
  {token:'runner',symbol:'RUN',recordedAt:'2026-01-01T00:05:00.000Z',priceUsd:1.5,liquidityUsd:100000,score:92,tier:'RESEARCH',security:{pass:true},decision:'SNAPSHOT'},
  {token:'runner',symbol:'RUN',recordedAt:'2026-01-01T00:10:00.000Z',priceUsd:1.25,liquidityUsd:100000,score:92,tier:'RESEARCH',security:{pass:true},decision:'SNAPSHOT'}
 ];
 const result=backtestSnapshots(rows,{startingEquityUsd:1000});
 assert.equal(result.trades,1);
 assert.equal(result.results[0].partialTpDone,true);
 assert.equal(result.results[0].finalExitReason,'RUNNER_TRAILING');
 assert.ok(result.results[0].netPnlUsd>0);
 assert.ok(typeof result.profitFactor==='number'||result.profitFactor==='Infinity');
 assert.equal(typeof result.pnlExcludingLargestTradeUsd,'number');
});
