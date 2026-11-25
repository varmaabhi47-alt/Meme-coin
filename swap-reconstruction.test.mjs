import test from 'node:test';
import assert from 'node:assert/strict';
import {reconstructSolSwap} from './swap-reconstruction.mjs';

const DEX='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const wallet='wallet',mint='mintA',pool='pool';
function baseTx({preSol=1_000_000_000,postSol=499_000_000,fee=1_000_000,preToken=0,postToken=100,extra=[]}={}) {
  return {slot:22,blockTime:1700000000,signature:'sig',transaction:{message:{staticAccountKeys:[wallet,pool],instructions:[{programId:DEX,accounts:[1],data:''},...extra]}},meta:{fee,preBalances:[preSol,0],postBalances:[postSol,0],preTokenBalances:[{owner:wallet,mint,uiTokenAmount:{uiAmountString:String(preToken)}}],postTokenBalances:[{owner:wallet,mint,uiTokenAmount:{uiAmountString:String(postToken)}}],innerInstructions:[]}};
}

test('reconstructs one unambiguous SOL buy with fee removed from payer delta',()=>{
  const {swap,reason}=reconstructSolSwap(baseTx(),wallet);
  assert.equal(reason,null);assert.equal(swap.side,'BUY');assert.equal(swap.solAmount,0.5);assert.equal(swap.tokenAmount,100);
});
test('rejects multiple token legs instead of assigning full SOL delta to each mint',()=>{
  const tx=baseTx();tx.meta.postTokenBalances.push({owner:wallet,mint:'mintB',uiTokenAmount:{uiAmountString:'7'}});
  const result=reconstructSolSwap(tx,wallet);assert.equal(result.swap,null);assert.match(result.reason,/multiple token legs/);
});
test('rejects an unrelated system transfer in the same transaction',()=>{
  const tx=baseTx({extra:[{programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source:wallet,destination:'outside',lamports:250000000}}}]});
  const result=reconstructSolSwap(tx,wallet);assert.equal(result.swap,null);assert.match(result.reason,/unrelated SOL transfer/);
});
test('rejects compiled SystemProgram transfer unrelated to the DEX accounts',()=>{
  const tx=baseTx();
  tx.transaction.message.staticAccountKeys.push('outside');
  tx.meta.preBalances.push(0);tx.meta.postBalances.push(0);
  tx.transaction.message.instructions.push({programId:'11111111111111111111111111111111',accounts:[0,2],data:'3Bxs411Dtc7pkFQj'});
  const result=reconstructSolSwap(tx,wallet);assert.equal(result.swap,null);assert.match(result.reason,/unrelated SOL transfer/);
});
test('rejects unresolved versioned transaction lookup addresses',()=>{
  const tx=baseTx();tx.transaction.message.addressTableLookups=[{accountKey:'table',writableIndexes:[0],readonlyIndexes:[]}];
  const result=reconstructSolSwap(tx,wallet);assert.equal(result.swap,null);assert.match(result.reason,/unresolved address lookup/);
});
test('rejects non-SOL or same-direction flows conservatively',()=>{
  const result=reconstructSolSwap(baseTx({postSol:1_100_000_000}),wallet);assert.equal(result.swap,null);assert.match(result.reason,/do not oppose/);
});
