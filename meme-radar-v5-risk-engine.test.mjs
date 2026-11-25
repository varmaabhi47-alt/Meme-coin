import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePositionRisk,calculatePositionSize,checkCircuitBreakers,parseTelegramCommand,makeStateLock} from './meme-radar-v5-risk-engine.mjs';

test('partial TP arms runner and fee-covered breakeven stop',()=>{
 const p={buyPrice:1,tokens:100,remainingTokens:100,costUsd:100,remainingCostUsd:100,entryLiquidityUsd:100000,lastLiquidityUsd:100000,entryTime:Date.now(),peakPrice:1,partialTpDone:false};
 const tp=evaluatePositionRisk(p,{markPrice:1.5,liquidityUsd:100000,now:Date.now()});
 assert.equal(tp.action,'PARTIAL_EXIT');
 p.partialTpDone=true;p.remainingTokens=50;p.remainingCostUsd=50;p.peakPrice=1.5;
 const stop=evaluatePositionRisk(p,{markPrice:1.01,liquidityUsd:100000,now:Date.now()});
 assert.equal(stop.action,'EXIT_ALL');assert.equal(stop.reason,'BREAKEVEN_STOP');
});
test('emergency liquidity exits use entry and consecutive-check thresholds',()=>{
 const p={buyPrice:1,tokens:10,remainingTokens:10,costUsd:10,remainingCostUsd:10,entryLiquidityUsd:100000,lastLiquidityUsd:100000,entryTime:Date.now(),peakPrice:1};
 assert.equal(evaluatePositionRisk(p,{markPrice:1,liquidityUsd:64000}).reason,'LIQ_DROP_ENTRY');
 assert.equal(evaluatePositionRisk(p,{markPrice:1,liquidityUsd:79000}).reason,'LIQ_DROP_CHECK');
});
test('risk-adjusted size uses score tier and pool cap',()=>{
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:85,cashUsd:100}),48);
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:10000,score:95,cashUsd:100}),35);
});
test('Telegram commands parse only supported command shapes',()=>{
 assert.deepEqual(parseTelegramCommand('/status'),{command:'status'});
 assert.deepEqual(parseTelegramCommand('/close PEPE'),{command:'close',symbol:'PEPE'});
 assert.equal(parseTelegramCommand('/buy PEPE'),null);
});
test('state lock serializes concurrent writes',async()=>{
 const lock=makeStateLock(),order=[];
 await Promise.all([lock(async()=>{order.push('a-start');await Promise.resolve();order.push('a-end');}),lock(async()=>{order.push('b');})]);
 assert.deepEqual(order,['a-start','a-end','b']);
});
