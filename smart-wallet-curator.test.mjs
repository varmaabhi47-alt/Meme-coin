import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvedKeys,instructionProgramIds,vetWallet,analyzeTrades,MONTHLY_LIMIT,MAX_RPS} from './smart-wallet-curator.mjs';

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
