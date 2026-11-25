import test from 'node:test';
import assert from 'node:assert/strict';
import {attributeWalletOutcomes,summarizeWalletOutcomes} from './curator-outcomes.mjs';

test('attributes independent 15m/60m/4h price outcomes to wallet buy event',()=>{
  const t=Date.parse('2026-01-01T00:00:00Z');
  const buys=[{wallet:'W1',mint:'M1',signature:'S1',occurred_at:t,sol_amount:0.4}];
  const research=[
    {token:'M1',recordedAt:new Date(t+1000).toISOString(),priceUsd:2},
    {token:'M1',recordedAt:new Date(t+15*60000+1000).toISOString(),priceUsd:3},
    {token:'M1',recordedAt:new Date(t+60*60000+1000).toISOString(),priceUsd:1},
    {token:'M1',recordedAt:new Date(t+240*60000+1000).toISOString(),priceUsd:4}
  ];
  const result=attributeWalletOutcomes(buys,research);
  assert.equal(result.length,1);assert.equal(result[0].outcomes['15m'].returnPct,50);
  assert.equal(result[0].outcomes['60m'].returnPct,-50);assert.equal(result[0].outcomes['4h'].returnPct,100);
});
test('missing entry or horizon price remains null, not fabricated zero',()=>{
  const t=Date.parse('2026-01-01T00:00:00Z');
  const result=attributeWalletOutcomes([{wallet:'W',mint:'M',occurred_at:t}],[]);
  assert.equal(result[0].entryPriceUsd,null);
  assert.equal(result[0].outcomes['15m'],null);
});
test('deduplicates repeated webhook event by wallet/signature/mint',()=>{
  const t=Date.parse('2026-01-01T00:00:00Z'),buy={wallet:'W',mint:'M',signature:'S',occurred_at:t};
  const research=[{token:'M',recordedAt:new Date(t+1000).toISOString(),priceUsd:1}];
  assert.equal(attributeWalletOutcomes([buy,buy],research).length,1);
});
test('wallet summary computes hit rate separately per horizon',()=>{
  const rows=[{wallet:'W',rug:false,outcomes:{'15m':{returnPct:2},'60m':{returnPct:-1},'4h':null}},{wallet:'W',rug:true,outcomes:{'15m':{returnPct:-2},'60m':{returnPct:1},'4h':null}}];
  const s=summarizeWalletOutcomes(rows)[0];
  assert.equal(s.horizons['15m'].hitRatePct,50);assert.equal(s.horizons['60m'].hitRatePct,50);assert.equal(s.horizons['4h'].samples,0);assert.equal(s.rugEntries,1);
});
