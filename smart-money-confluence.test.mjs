import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSmartMoneyConfluence} from './smart-money-confluence.mjs';
const now=Date.now(),gate={passed:1,checked_at:now-1000};
const wallets=[{address:'A',status:'ACTIVE',median_buy_sol:1,correlation_group:'G1'},{address:'B',status:'ACTIVE',median_buy_sol:1,correlation_group:'G2'},{address:'C',status:'ACTIVE',median_buy_sol:1,correlation_group:'G3'},{address:'W',status:'WATCH',median_buy_sol:1}];
const buys=[{wallet:'A',mint:'M',slot:100,occurred_at:now-60000,sol_amount:0.5},{wallet:'B',mint:'M',slot:101,occurred_at:now-30000,sol_amount:0.7}];
test('requires independent active wallets, size threshold, distinct slots and fresh passing gate',()=>{
  const r=evaluateSmartMoneyConfluence({wallets,buys,gate,now,minConfluence:2});
  assert.equal(r.signal,'SMART_MONEY_CONFLUENCE');assert.equal(r.independentGroups,2);assert.equal(r.distinctSlots,2);
});
test('same correlation group counts once and cannot create fake confluence',()=>{
  const r=evaluateSmartMoneyConfluence({wallets,buys:[...buys,{wallet:'C',mint:'M',slot:102,occurred_at:now-10000,sol_amount:0.8}],gate,now,minConfluence:3});
  assert.equal(r.signal,null);assert.equal(r.independentGroups,2);assert.ok(r.reasons.includes('insufficient-independent-wallets'));
});
test('same block slot is not independent confluence',()=>{
  const r=evaluateSmartMoneyConfluence({wallets,buys:buys.map(x=>({...x,slot:100})),gate,now,minConfluence:2});
  assert.equal(r.signal,null);assert.equal(r.distinctSlots,1);
});
test('rejects stale, failed, future and missing gates',()=>{
  for(const bad of [{passed:1,checked_at:now-6*60*1000},{passed:0,checked_at:now},{passed:1,checked_at:now+1000},null]){
    assert.equal(evaluateSmartMoneyConfluence({wallets,buys,gate:bad,now}).signal,null);
  }
});
test('rejects WATCH wallets, undersized buys and old/future events',()=>{
  const rows=[{wallet:'W',mint:'M',slot:1,occurred_at:now-1000,sol_amount:5},{wallet:'A',mint:'M',slot:2,occurred_at:now-1000,sol_amount:0.49},{wallet:'B',mint:'M',slot:3,occurred_at:now-16*60*1000,sol_amount:1},{wallet:'C',mint:'M',slot:4,occurred_at:now+1000,sol_amount:1}];
  assert.equal(evaluateSmartMoneyConfluence({wallets,buys:rows,gate,now}).signal,null);
});
