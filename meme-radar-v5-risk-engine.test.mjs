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
 assert.equal(evaluatePositionRisk(p,{markPrice:1,liquidityUsd:69000}).reason,'LIQ_DROP_ENTRY');
 assert.equal(evaluatePositionRisk(p,{markPrice:1,liquidityUsd:84000}).reason,'LIQ_DROP_CHECK');
 assert.equal(evaluatePositionRisk(p,{markPrice:1,liquidityUsd:0}).reason,'LIQ_DROP_ENTRY');
});
test('risk-adjusted size uses score tier and pool cap',()=>{
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:85,cashUsd:100}),37.5);
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:10000,score:95,cashUsd:100}),30);
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

test('net live exit quote overrides spot-only PnL for TP/SL decisions',()=>{
 const p={buyPrice:1,tokens:10,remainingTokens:10,costUsd:10,remainingCostUsd:10,entryLiquidityUsd:100000,lastLiquidityUsd:100000,entryTime:Date.now(),peakPrice:1};
 const risk=evaluatePositionRisk(p,{markPrice:1.5,liquidityUsd:100000,netPnlPctOverride:-20});
 assert.equal(risk.action,'EXIT_ALL');assert.equal(risk.reason,'STOP_LOSS');
});

test('daily drawdown and three consecutive risk exits pause new entries',()=>{
 const daily=checkCircuitBreakers({realizedUnrealizedPnlUsd:-121,dailyStartingEquityUsd:1000,now:1000,breaker:{},consecutiveRiskExits:0});
 assert.equal(daily.pauseBuys,true);assert.ok(daily.pauseUntil>=1000+12*3600000);
 const streak=checkCircuitBreakers({realizedUnrealizedPnlUsd:0,dailyStartingEquityUsd:1000,now:1000,breaker:{},consecutiveRiskExits:3});
 assert.equal(streak.pauseBuys,true);assert.ok(streak.pauseUntil>=1000+2*3600000);
});

test('smart-money conviction receives full five-percent base and 0.30% pool cap',()=>{
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:90,cashUsd:100,tier:'RESEARCH',smartMoneyConfluence:true}),50);
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:90,cashUsd:100,tier:'WATCH'}),0);
});
