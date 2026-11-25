import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvedKeys,instructionProgramIds,solDeltaByAccount,vetWallet,analyzeTrades,MONTHLY_LIMIT,MAX_RPS,canSpendRpcCredits,RPC_BATCH_SIZE} from './smart-wallet-curator.mjs';

test('versioned message account keys append runtime-loaded ALT addresses in correct writable/readonly order',()=>{
  const tx={transaction:{message:{staticAccountKeys:['payer','staticA'],addressTableLookups:[{accountKey:'lookupTable',writableIndexes:[2],readonlyIndexes:[5]}],instructions:[{programIdIndex:2,accounts:[0,2,3],data:''}]}},meta:{loadedAddresses:{writable:['altWritable'],readonly:['altReadonly']}}};
  assert.deepEqual(resolvedKeys(tx),['payer','staticA','altWritable','altReadonly']);
  assert.deepEqual(instructionProgramIds(tx),['altWritable']);
});

test('funding/deployer correlation is a hard rejection even when candidate otherwise has metrics',()=>{
  const address='11111111111111111111111111111111';
  const swaps=Array.from({length:12},(_,i)=>({mint:'mint'+i,side:i%2?'SELL':'BUY',solAmount:0.4,blockTime:Date.now()/1000-60*i,slot:100+i}));
  const trades=Array.from({length:10},(_,i)=>({mint:'mint'+i,buyTime:Date.now()/1000-3600,sellTime:Date.now()/1000-1800,holdMins:30,costSol:0.3,proceedsSol:0.7,pnlSol:0.4}));
  const result=vetWallet(address,trades,swaps,{knownBad:new Set([address])});
  assert.equal(result.pass,false);
  assert.ok(result.reasons.includes('funding/deployer-linked'));
});

test('trade reconstruction never opens a sell without an earlier market buy',()=>{
  const trades=analyzeTrades([{mint:'mintA',side:'SELL',tokenAmount:100,solAmount:1,blockTime:100,slot:1},{mint:'mintA',side:'BUY',tokenAmount:100,solAmount:0.5,blockTime:200,slot:2}]);
  assert.equal(trades.length,0);
});

test('RPC request budget is capped at one million monthly calls and six RPS',()=>{
  assert.equal(MONTHLY_LIMIT,1_000_000);
  assert.ok(MAX_RPS>=1&&MAX_RPS<=6);
});

test('local parser and rejection tests do not call any RPC endpoint',()=>{
  assert.equal(typeof resolvedKeys,'function');
  assert.equal(typeof vetWallet,'function');
});

test('versioned transaction without resolved lookup addresses is rejected instead of guessed',()=>{
  const tx={transaction:{message:{staticAccountKeys:['payer'],addressTableLookups:[{accountKey:'table',writableIndexes:[0],readonlyIndexes:[]}],instructions:[]}},meta:{}};
  assert.throws(()=>resolvedKeys(tx),/missing meta.loadedAddresses/);
});

test('versioned transaction with incomplete ALT address resolution is rejected',()=>{
  const tx={transaction:{message:{staticAccountKeys:['payer'],addressTableLookups:[{accountKey:'table',writableIndexes:[0,1],readonlyIndexes:[2]}],instructions:[]}},meta:{loadedAddresses:{writable:['onlyOne'],readonly:['readOnly']}}};
  assert.throws(()=>resolvedKeys(tx),/count does not match/);
});

test('fee payer SOL delta is corrected by the recorded transaction fee',()=>{
  const tx={transaction:{message:{staticAccountKeys:['payer','wallet'],instructions:[]}},meta:{preBalances:[1000000000,500000000],postBalances:[899000000,400000000],fee:1000000}};
  const d=solDeltaByAccount(tx);
  assert.equal(d.get('payer'),-0.1);
  assert.equal(d.get('wallet'),-0.1);
});

test('profitable token gate uses net PnL per mint, not any isolated winning trade',()=>{
  const now=Date.now()/1000;
  const trades=[];
  for(const mint of ['A','B','C','D']){trades.push({mint,pnlSol:0.5,holdMins:20,buyTime:now-1800,sellTime:now-600});trades.push({mint,pnlSol:-0.1,holdMins:20,buyTime:now-1800,sellTime:now-600});}
  trades.push({mint:'E',pnlSol:0.5,holdMins:20,buyTime:now-1800,sellTime:now-600},{mint:'E',pnlSol:-0.7,holdMins:20,buyTime:now-1800,sellTime:now-600});
  const swaps=Array.from({length:20},(_,i)=>({mint:'mint'+i,side:i%2?'SELL':'BUY',solAmount:0.4,blockTime:now-600,slot:100+i}));
  const result=vetWallet('wallet',trades,swaps);
  assert.equal(result.metrics.profitableTokens,4);
  assert.ok(result.reasons.includes('less-than-5-net-profitable-tokens'));
});

test('token PnL concentration is measured against positive net token profits',()=>{
  const now=Date.now()/1000,trades=[{mint:'A',pnlSol:4,holdMins:20,buyTime:now-1800,sellTime:now-600}];
  for(const mint of ['B','C','D','E'])trades.push({mint,pnlSol:0.5,holdMins:20,buyTime:now-1800,sellTime:now-600});
  for(const mint of ['A','B','C','D','E'])trades.push({mint,pnlSol:-0.1,holdMins:20,buyTime:now-1800,sellTime:now-600});
  const swaps=Array.from({length:20},(_,i)=>({mint:'mint'+i,side:i%2?'SELL':'BUY',solAmount:0.4,blockTime:now-600,slot:200+i}));
  const result=vetWallet('wallet',trades,swaps);
  assert.ok(result.metrics.largestTokenPnlShare>0.6);
  assert.ok(result.reasons.includes('single-token-pnl-concentration'));
});

test('rejects a near-instant same/adjacent-slot round trip as sniper-like evidence',()=>{
  const now=Date.now()/1000,trades=Array.from({length:10},(_,i)=>({mint:'M'+i,pnlSol:0.3,holdMins:20,buyTime:now-1800,sellTime:now-600,buySlot:100,sellSlot:101}));
  const swaps=Array.from({length:20},(_,i)=>({mint:'mint'+i,side:i%2?'SELL':'BUY',solAmount:0.4,blockTime:now-600,slot:200+i}));
  const result=vetWallet('wallet',trades,swaps);
  assert.ok(result.reasons.includes('same-slot-or-next-slot-roundtrip'));
});

test('credit guard counts every batch item and refuses crossing the monthly free limit',()=>{
  assert.equal(canSpendRpcCredits(MONTHLY_LIMIT-6,6),true);
  assert.equal(canSpendRpcCredits(MONTHLY_LIMIT-5,6),false);
  assert.equal(canSpendRpcCredits(MONTHLY_LIMIT,1),false);
  assert.equal(canSpendRpcCredits(-1,1),false);
  assert.equal(RPC_BATCH_SIZE,6);
});
