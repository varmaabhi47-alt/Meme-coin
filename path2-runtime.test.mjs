import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmartMoneyConfluence, computeEdgeProof, RpcCreditGuard, SolanaEventListener } from './path2-runtime.mjs';

test('smart-money confluence requires two distinct wallets; one wallet still emits a tracked buy',()=>{
 const signal=createSmartMoneyConfluence();
 assert.equal(signal('A','M',1000).signal,'TRACKED_WALLET_BUY');
 assert.equal(signal('A','M',2000).signal,'TRACKED_WALLET_BUY');
 const confirmed=signal('B','M',3000);assert.equal(confirmed.signal,'SMART_MONEY_CONFLUENCE');assert.deepEqual(confirmed.walletAddresses,['A','B']);
 assert.equal(signal('C','N',4000).signal,'TRACKED_WALLET_BUY');
});
test('edge gate stays false below 100 closed trades',()=>{
 const proof=computeEdgeProof(Array.from({length:99},(_,i)=>({netPnlUsd:i%2?2:-1})));
 assert.equal(proof.closedTrades,99); assert.equal(proof.EDGE_VERIFIED,false);
});
test('RPC guard hard limits configured RPS to six',()=>{
 const guard=new RpcCreditGuard({maxRps:10}); assert.equal(guard.maxRps,6);
});

test('outlier-adjusted edge proof excludes only the largest winning trade',()=>{
 const trades=Array.from({length:100},(_,i)=>({netPnlUsd:i===99?1000:2,netPnlPct:i===99?100:2}));
 const proof=computeEdgeProof(trades);
 assert.equal(proof.closedTrades,100);assert.equal(proof.EDGE_VERIFIED,true);
 assert.equal(proof.outlierAdjustedPnlUsd,198);assert.equal(proof.largestWinningTradePnlUsd,1000);
});

test('RPC guard retries HTTP 429 and counts observed calls/credits',async()=>{
 let calls=0;
 const guard=new RpcCreditGuard({stateFile:'/tmp/path2-rpc-guard-test.json',monthlyLimit:1000000,fetchImpl:async()=>{calls++;return calls===1?{status:429,ok:false}:{status:200,ok:true,json:async()=>({result:42})};}});
 assert.equal(await guard.rpc('https://rpc.invalid','getSlot',[],{credits:1}),42);
 assert.equal(calls,2);assert.equal(guard.telemetry().estimatedCredits,1);
});

test('RPC guard retries HTTP 5xx with exact status and succeeds without counting failed calls',async()=>{
 let calls=0;
 const guard=new RpcCreditGuard({stateFile:'/tmp/path2-rpc-5xx-test.json',monthlyLimit:1000000,fetchImpl:async()=>{calls++;return calls===1?{status:503,ok:false,statusText:'Service Unavailable'}:{status:200,ok:true,json:async()=>({result:'slot'})};}});
 assert.equal(await guard.rpc('https://rpc.invalid','getSlot',[],{credits:1}),'slot');
 assert.equal(calls,2);assert.equal(guard.telemetry().estimatedCredits,1);
});
test('standard WebSocket listener triggers only migration and configured pool-init logs',()=>{
 class FakeSocket{
  listeners={};sent=[];
  addEventListener(name,fn){this.listeners[name]=fn;}
  send(value){this.sent.push(JSON.parse(value));}
  emit(name,value){this.listeners[name]?.(value);}
  close(){}
 }
 const socket=new FakeSocket(),mints=[],errors=[];
 const listener=new SolanaEventListener({wsUrl:'wss://rpc.example',wallets:[],raydiumProgramIds:['RAY_PROGRAM'],WebSocketImpl:class{constructor(){return socket;}},onMint:x=>mints.push(x),onError:e=>errors.push(e)});
 listener.start();socket.emit('open');
 const pump=socket.sent[0],ray=socket.sent[1];
 socket.emit('message',{data:JSON.stringify({id:pump.id,result:101})});
 socket.emit('message',{data:JSON.stringify({id:ray.id,result:102})});
 socket.emit('message',{data:JSON.stringify({method:'logsNotification',params:{subscription:101,result:{context:{slot:1},value:{signature:'sig1',err:null,logs:['Program log: Trade']}}}})});
 socket.emit('message',{data:JSON.stringify({method:'logsNotification',params:{subscription:101,result:{context:{slot:2},value:{signature:'sig2',err:null,logs:['Program log: Migrate']}}}})});
 socket.emit('message',{data:JSON.stringify({method:'logsNotification',params:{subscription:101,result:{context:{slot:2},value:{signature:'sig2b',err:null,logs:['Program log: Trade Migrate']}}}})});
 socket.emit('message',{data:JSON.stringify({method:'logsNotification',params:{subscription:102,result:{context:{slot:3},value:{signature:'sig3',err:null,logs:['Program log: Initialize Pool']}}}})});
 assert.equal(mints.length,2);assert.equal(mints[0].trigger,'pump-migration');assert.equal(mints[1].trigger,'raydium-pool-init');listener.stop();
});

test('RPC audit cache reuses a successful mint audit for 15 minutes',async()=>{
 let calls=0;
 const guard=new RpcCreditGuard({stateFile:'/tmp/path2-rpc-cache-test.json',fetchImpl:async()=>{calls++;return {status:200,ok:true,json:async()=>({result:{observed:true}})};}});
 const first=await guard.rpc('https://rpc.invalid','getTokenSupply',['M'],{credits:1,cacheKey:'audit:M'});
 const second=await guard.rpc('https://rpc.invalid','getTokenSupply',['M'],{credits:1,cacheKey:'audit:M'});
 assert.deepEqual(first,{observed:true});assert.deepEqual(second,{observed:true});assert.equal(calls,1);assert.equal(guard.telemetry().estimatedCredits,1);
});

test('WebSocket listener retains up to 50 configured tracked wallets',()=>{
 const wallets=Array.from({length:60},(_,i)=>'wallet-'+i);
 const listener=new SolanaEventListener({wsUrl:'wss://rpc.example',wallets,WebSocketImpl:class{}});
 assert.equal(listener.wallets.length,50);
 assert.equal(listener.wallets[49],'wallet-49');
});
