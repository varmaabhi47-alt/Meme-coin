import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePositionRisk,calculatePositionSize,checkCircuitBreakers,parseTelegramCommand,makeStateLock} from './meme-radar-v5-risk-engine.mjs';

test('V6 hard stop-loss triggers at -15% net PnL',()=>{
 const p={buyPrice:1,tokens:10,remainingTokens:10,costUsd:10,remainingCostUsd:10,entryLiquidityUsd:100000,lastLiquidityUsd:100000,entryTime:Date.now(),peakPrice:1};
 assert.equal(evaluatePositionRisk(p,{markPrice:0.85,liquidityUsd:100000,netPnlPctOverride:-15}).reason,'STOP_LOSS');
 assert.equal(evaluatePositionRisk(p,{markPrice:0.86,liquidityUsd:100000,netPnlPctOverride:-14}).action,'HOLD');
});
test('V6 trailing take-profit arms at +25% and exits on 10% drawdown from peak',()=>{
 const p={buyPrice:1,tokens:10,remainingTokens:10,costUsd:10,remainingCostUsd:10,entryLiquidityUsd:100000,lastLiquidityUsd:100000,entryTime:Date.now(),peakPrice:1.3,maxNetPnlPct:30};
 const hold=evaluatePositionRisk(p,{markPrice:1.18,liquidityUsd:100000,now:Date.now(),netPnlPctOverride:18});
 assert.equal(hold.action,'HOLD');
 const exit=evaluatePositionRisk(p,{markPrice:1.169,liquidityUsd:100000,now:Date.now(),netPnlPctOverride:16.9});
 assert.equal(exit.action,'EXIT_ALL');assert.equal(exit.reason,'TRAILING_TP');assert.equal(exit.trailDropPct,10);
});
test('V6 time stop exits after 45m if trade never reached +10% net',()=>{
 const p={buyPrice:1,tokens:10,remainingTokens:10,costUsd:10,remainingCostUsd:10,entryLiquidityUsd:100000,lastLiquidityUsd:100000,entryTime:Date.now()-46*60000,peakPrice:1.04,maxNetPnlPct:8};
 const exit=evaluatePositionRisk(p,{markPrice:1.01,liquidityUsd:100000,now:Date.now(),netPnlPctOverride:1});
 assert.equal(exit.action,'EXIT_ALL');assert.equal(exit.reason,'TIME_STOP');
 const kept=evaluatePositionRisk({...p,maxNetPnlPct:10},{markPrice:1.01,liquidityUsd:100000,now:Date.now(),netPnlPctOverride:1});
 assert.equal(kept.action,'HOLD');
});
test('emergency liquidity exits use entry and consecutive-check thresholds',()=>{
 const p={buyPrice:1,tokens:10,remainingTokens:10,costUsd:10,remainingCostUsd:10,entryLiquidityUsd:100000,lastLiquidityUsd:100000,entryTime:Date.now(),peakPrice:1};
 assert.equal(evaluatePositionRisk(p,{markPrice:1,liquidityUsd:64000}).reason,'LIQ_DROP_ENTRY');
 assert.equal(evaluatePositionRisk(p,{markPrice:1,liquidityUsd:79000}).reason,'LIQ_DROP_CHECK');
 assert.equal(evaluatePositionRisk(p,{markPrice:1,liquidityUsd:0}).reason,'LIQ_DROP_ENTRY');
});

test('liquidity emergency thresholds are strict: exactly 30% from entry or 15% per check holds',()=>{
 const base={buyPrice:1,tokens:10,remainingTokens:10,costUsd:10,remainingCostUsd:10,entryLiquidityUsd:100000,entryTime:Date.now(),peakPrice:1};
 const entryBoundary=evaluatePositionRisk({...base,lastLiquidityUsd:80000},{markPrice:1,liquidityUsd:70000});
 assert.equal(entryBoundary.action,'HOLD');assert.equal(entryBoundary.dropEntryPct,30);assert.equal(entryBoundary.dropCheckPct,12.5);
 const checkBoundary=evaluatePositionRisk({...base,lastLiquidityUsd:100000},{markPrice:1,liquidityUsd:85000});
 assert.equal(checkBoundary.action,'HOLD');assert.equal(checkBoundary.dropCheckPct,15);
});
test('risk-adjusted size uses score tier and pool cap',()=>{
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:85,cashUsd:100}),37.5);
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:10000,score:95,cashUsd:100}),30);
});
test('Telegram commands parse only supported command shapes',()=>{
 assert.deepEqual(parseTelegramCommand('/status'),{command:'status'});
 assert.deepEqual(parseTelegramCommand('/close PEPE'),{command:'close',symbol:'PEPE'});
 assert.equal(parseTelegramCommand('/buy PEPE'),null);
 assert.deepEqual(parseTelegramCommand('/kill'),{command:'kill'});
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
 assert.equal(daily.pauseBuys,true);assert.equal(daily.reason,'DAILY_DRAWDOWN_10');assert.ok(daily.pauseUntil>=1000+12*3600000);
 const belowLimit=checkCircuitBreakers({realizedUnrealizedPnlUsd:-99,dailyStartingEquityUsd:1000,now:1000,breaker:{},consecutiveRiskExits:0});assert.equal(belowLimit.pauseBuys,false);
 const streak=checkCircuitBreakers({realizedUnrealizedPnlUsd:0,dailyStartingEquityUsd:1000,now:1000,breaker:{},consecutiveRiskExits:3});
 assert.equal(streak.pauseBuys,true);assert.ok(streak.pauseUntil>=1000+2*3600000);
});

test('smart-money uses five-percent base; standard research 0.75x and 0.30% pool cap',()=>{
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:90,cashUsd:100,tier:'RESEARCH',smartMoneyConfluence:true}),50);
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:90,cashUsd:100,tier:'WATCH'}),0);
});


test('wallet-signal entries use a lower score threshold and conservative wallet-count sizing',()=>{
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:64,cashUsd:100,tier:'WALLET_SIGNAL',smartMoneyConfluence:true,walletSignalCount:1}),0);
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:70,cashUsd:100,tier:'WALLET_SIGNAL',smartMoneyConfluence:true,walletSignalCount:1}),12.5);
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:70,cashUsd:100,tier:'WALLET_SIGNAL',smartMoneyConfluence:true,walletSignalCount:2}),25);
 assert.equal(calculatePositionSize({equityUsd:1000,poolLiquidityUsd:100000,score:70,cashUsd:100,tier:'WATCH',smartMoneyConfluence:true}),0);
});
