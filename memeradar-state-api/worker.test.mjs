import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

function mockDb(){
 let row={id:'main',payload:JSON.stringify({cashUsd:100,startingBankroll:100,openPositions:[],closedTrades:[],cooldowns:{},decisionLog:[]}),version:9,updated_at:'2026-11-25T09:00:00.000Z'};
 const buys=new Set();
 return {get row(){return row;},prepare(sql){let args=[];return{bind(...values){args=values;return this;},async first(){
   if(sql.includes('SELECT payload, version, updated_at'))return row;
   if(sql.includes('SELECT version,updated_at'))return{version:row.version,updated_at:row.updated_at};
   if(sql.includes('SELECT COUNT(DISTINCT wallet)'))return{wallets:2,latest:Date.now()};
   return null;
  },async run(){
   if(sql.startsWith('UPDATE portfolio_state')){const [payload,updated,id,version,updatedAt]=args;if(row.version===version&&row.updated_at===updatedAt){row={...row,payload,updated_at:updated,version:version+1};return{meta:{changes:1}};}return{meta:{changes:0}};}
   if(sql.startsWith('INSERT OR IGNORE INTO smart_wallet_buys')){const key=args.join('|');const before=buys.size;buys.add(key);return{meta:{changes:buys.size>before?1:0}};}
   return{meta:{changes:1}};
  },async all(){if(sql.includes("FROM curated_smart_wallets WHERE status='ACTIVE'"))return{results:[{address:'WALLET_A',median_buy_sol:0.5,correlation_group:'group-a'}]};return{results:[]};}};}};
}

test('Worker GET /state requires bearer auth and POST checks version plus updated_at',async()=>{
 const DB=mockDb(),env={DB,BOT_SYNC_SECRET:'secret'};
 const denied=await worker.fetch(new Request('https://worker.test/state'),env);assert.equal(denied.status,401);
 const read=await worker.fetch(new Request('https://worker.test/state',{headers:{Authorization:'Bearer secret'}}),env);assert.equal(read.status,200);assert.equal((await read.json()).version,9);
 const payload={cashUsd:95,startingBankroll:100,openPositions:[],closedTrades:[],cooldowns:{},decisionLog:[]};
 const write=await worker.fetch(new Request('https://worker.test/state',{method:'POST',headers:{Authorization:'Bearer secret','Content-Type':'application/json'},body:JSON.stringify({portfolio:payload,version:9,updated_at:'2026-11-25T09:00:00.000Z'})}),env);assert.equal(write.status,200);assert.equal((await write.json()).version,10);
 const stale=await worker.fetch(new Request('https://worker.test/state',{method:'POST',headers:{Authorization:'Bearer secret','Content-Type':'application/json'},body:JSON.stringify({portfolio:payload,version:9,updated_at:'2026-11-25T09:00:00.000Z'})}),env);assert.equal(stale.status,409);
});

test('Helius webhook requires configured auth header and accepts only allowlisted swap buys',async()=>{
 const DB=mockDb(),env={DB,HELIUS_WEBHOOK_SECRET:'Bearer webhook-secret'};
 const body=[{type:'SWAP',signature:'sig-buy',slot:123,timestamp:Date.now()/1000,tokenTransfers:[{toUserAccount:'WALLET_A',mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',tokenAmount:25}],nativeTransfers:[{fromUserAccount:'WALLET_A',toUserAccount:'DEX',amount:500000000}]}];
 const denied=await worker.fetch(new Request('https://worker.test/webhook/helius',{method:'POST',body:JSON.stringify(body)}),env);assert.equal(denied.status,401);
 const accepted=await worker.fetch(new Request('https://worker.test/webhook/helius',{method:'POST',headers:{Authorization:'Bearer webhook-secret','Content-Type':'application/json'},body:JSON.stringify(body)}),env);assert.equal(accepted.status,200);assert.equal((await accepted.json()).stored,1);
});
