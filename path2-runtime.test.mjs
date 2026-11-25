import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmartMoneyConfluence, computeEdgeProof, RpcCreditGuard } from './path2-runtime.mjs';

test('smart-money confluence requires two distinct wallets within 15 minutes',()=>{
 const signal=createSmartMoneyConfluence();
 assert.equal(signal('A','M',1000),null);
 assert.equal(signal('A','M',2000),null);
 assert.equal(signal('B','M',3000).signal,'SMART_MONEY_CONFLUENCE');
 assert.equal(signal('C','N',4000),null);
});
test('edge gate stays false below 100 closed trades',()=>{
 const proof=computeEdgeProof(Array.from({length:99},(_,i)=>({netPnlUsd:i%2?2:-1})));
 assert.equal(proof.closedTrades,99); assert.equal(proof.EDGE_VERIFIED,false);
});
test('RPC guard hard limits configured RPS to six',()=>{
 const guard=new RpcCreditGuard({maxRps:10}); assert.equal(guard.maxRps,6);
});
