/**
 * MEME.RADAR authoritative D1 state API.
 * Authenticates all state reads/writes and uses optimistic version checks.
 * Bind DB to the existing D1 database and retain BOT_SYNC_SECRET as a secret.
 */
const cors = {
  "Access-Control-Allow-Origin": "https://memeradar-v4.pages.dev",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store"
};
const responseHeaders=request=>{const origin=request.headers.get("Origin")||"";const allowed=origin==="https://memeradar-v4.pages.dev"||origin.endsWith(".memeradar-v4.pages.dev");return {...cors,"Access-Control-Allow-Origin":allowed?origin:"https://memeradar-v4.pages.dev","Vary":"Origin"};};
const json=(body,status=200,request=null)=>Response.json(body,{status,headers:request?responseHeaders(request):cors});
async function getConfluence(env,mint){
  const active=await env.DB.prepare("SELECT address,median_buy_sol,correlation_group FROM curated_smart_wallets WHERE status='ACTIVE'").all();
  const meta=new Map((active.results||[]).map(w=>[w.address,w]));
  const rows=await env.DB.prepare("SELECT wallet,slot,occurred_at,sol_amount,correlation_group FROM smart_wallet_buys WHERE mint=? AND occurred_at>=? ORDER BY occurred_at DESC").bind(mint,Date.now()-15*60*1000).all();
  const eligible=(rows.results||[]).filter(r=>{const w=meta.get(r.wallet);return w&&Number(w.median_buy_sol)>0&&Number(r.sol_amount)>=Number(w.median_buy_sol)*0.5;});
  const byGroup=new Map();for(const r of eligible){const g=String(meta.get(r.wallet)?.correlation_group||r.correlation_group||r.wallet);if(!byGroup.has(g))byGroup.set(g,r);}
  const unique=[...byGroup.values()],slots=new Set(unique.map(r=>Number(r.slot))),minimum=Math.max(2,Math.min(3,Number(env.SMART_WALLET_MIN_CONFLUENCE||2)));
  const gate=await env.DB.prepare("SELECT passed,checked_at,reasons FROM token_gate_status WHERE mint=?").bind(mint).first();
  const gateFresh=!!gate&&Number(gate.passed)===1&&Date.now()-Number(gate.checked_at)<=5*60*1000;
  const ready=unique.length>=minimum&&slots.size>=minimum&&gateFresh;
  return {mint,wallets:new Set(unique.map(r=>r.wallet)).size,independentGroups:unique.length,distinctSlots:slots.size,required:minimum,gateFresh,signal:ready?"SMART_MONEY_CONFLUENCE":null,latest:Math.max(0,...unique.map(r=>Number(r.occurred_at||0)))};
}
function authorized(request,env){const expected=String(env.BOT_SYNC_SECRET||"");return expected.length>0&&(request.headers.get("Authorization")||"")===`Bearer ${expected}`;}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
    if(url.pathname==="/health"&&request.method==="GET")return json({service:"MEME.RADAR state API",status:"ok",storage:"Cloudflare D1",trading:"paper-only"});
    if(url.pathname==="/public-state"&&request.method==="GET"){
      const row=await env.DB.prepare("SELECT payload,version,updated_at FROM portfolio_state WHERE id=?").bind("main").first();
      if(!row)return json({ok:true,portfolio:null,version:0,updated_at:null},200,request);
      let raw;try{raw=JSON.parse(row.payload);}catch{return json({error:"corrupt_state_json"},500,request);}
      const cleanText=v=>String(v??"").split("").filter(ch=>{const n=ch.charCodeAt(0);return n>=32&&n!==127;}).join("").replace(/<[^>]*>/g,"").slice(0,160);
      const portfolio={
        cashUsd:Number(raw.cashUsd||0),startingBankroll:Number(raw.startingBankroll||0),maxOpenPositions:Number(raw.maxOpenPositions||raw.config?.maxOpenPositions||5),
        autoTradeEnabled:!!raw.autoTradeEnabled,
        openPositions:(Array.isArray(raw.openPositions)?raw.openPositions:[]).map(p=>({
          id:cleanText(p.id),pairId:cleanText(p.pairId),chainId:cleanText(p.chainId),pairAddress:cleanText(p.pairAddress),address:cleanText(p.address),
          symbol:cleanText(p.symbol),name:cleanText(p.name),entryTime:Number(p.entryTime||0),entrySpotPrice:Number(p.entrySpotPrice||0),
          buyPrice:Number(p.buyPrice||0),tokens:Number(p.tokens||0),remainingTokens:Number(p.remainingTokens??p.tokens??0),
          costUsd:Number(p.costUsd||0),remainingCostUsd:Number(p.remainingCostUsd??p.costUsd??0),realizedPartialPnlUsd:Number(p.realizedPartialPnlUsd||0),
          partialTpDone:!!p.partialTpDone,partialExits:Array.isArray(p.partialExits)?p.partialExits:[],partialExitProceedsUsd:Number(p.partialExitProceedsUsd||0),partialFeesImpactUsd:Number(p.partialFeesImpactUsd||0),breakevenStopNetPct:Number(p.breakevenStopNetPct||0),entryQuoteSource:cleanText(p.entryQuoteSource),entryQuoteFallback:!!p.entryQuoteFallback,buyTaxRate:Number(p.buyTaxRate||0),sellTaxRate:Number(p.sellTaxRate||0),entryLiquidityUsd:Number(p.entryLiquidityUsd||0),
          lastPrice:Number(p.lastPrice||0),lastLiquidityUsd:Number(p.lastLiquidityUsd||0),peakPrice:Number(p.peakPrice||0),lastRiskCheckAt:Number(p.lastRiskCheckAt||0),dataStale:!!p.dataStale,stale:!!p.dataStale,dataStaleReason:cleanText(p.dataStaleReason),emergencyNoLiquidity:!!p.emergencyNoLiquidity
        })),
        closedTrades:(Array.isArray(raw.closedTrades)?raw.closedTrades:[]).map(t=>({
          id:cleanText(t.id),symbol:cleanText(t.symbol),chainId:cleanText(t.chainId),address:cleanText(t.address),
          entryTime:Number(t.entryTime||0),exitTime:Number(t.exitTime||0),buyPrice:Number(t.buyPrice||0),sellPrice:Number(t.sellPrice||0),
          tokensBought:Number(t.tokensBought||0),tokensSold:Number(t.tokensSold||0),costUsd:Number(t.costUsd||0),exitValueUsd:Number(t.exitValueUsd||0),
          feesImpactUsd:Number(t.feesImpactUsd||0),netPnlUsd:Number(t.netPnlUsd||0),netPnlPct:Number(t.netPnlPct||0),entryQuoteFallback:!!t.entryQuoteFallback,exitQuoteSource:cleanText(t.exitQuoteSource),finalExitValueUsd:Number(t.finalExitValueUsd||0),
          realizedPartialPnlUsd:Number(t.realizedPartialPnlUsd||0),partialExits:Array.isArray(t.partialExits)?t.partialExits:[],quoteFallback:!!t.quoteFallback,exitReason:cleanText(t.exitReason)
        })),
        rpcTelemetry:raw.rpcTelemetry||null,edgeProof:raw.edgeProof||null,
        cooldowns:raw.cooldowns||{},decisionLog:(Array.isArray(raw.decisionLog)?raw.decisionLog:[]).slice(0,150).map(d=>({ts:Number(d.ts||0),timeStr:cleanText(d.timeStr),action:cleanText(d.action),symbol:cleanText(d.symbol),chainId:cleanText(d.chainId),reason:cleanText(d.reason)}))
      };
      return json({ok:true,portfolio,version:Number(row.version||0),updated_at:row.updated_at},200,request);
    }
    if(url.pathname==="/webhook/helius"&&request.method==="POST"){
      const expected=String(env.HELIUS_WEBHOOK_SECRET||""),supplied=request.headers.get("Authorization")||"";
      if(!expected||supplied.length!==expected.length)return json({error:"unauthorized_webhook"},401,request);
      let authDiff=0;for(let i=0;i<expected.length;i++)authDiff|=expected.charCodeAt(i)^supplied.charCodeAt(i);if(authDiff!==0)return json({error:"unauthorized_webhook"},401,request);
      const raw=await request.text();let events;try{events=JSON.parse(raw);}catch{return json({error:"invalid_json"},400,request);}if(!Array.isArray(events))events=[events];
      const active=await env.DB.prepare("SELECT address,median_buy_sol,correlation_group FROM curated_smart_wallets WHERE status='ACTIVE'").all();
      const meta=new Map((active.results||[]).map(w=>[w.address,w]));if(!meta.size)return json({error:"curated_active_wallets_empty"},409,request);
      let stored=0,underSize=0;
      for(const event of events){
        if(String(event?.type||"").toUpperCase()!=="SWAP"||event?.transactionError)continue;
        const transfers=Array.isArray(event.tokenTransfers)?event.tokenTransfers:[],walletBuy=transfers.filter(t=>meta.has(String(t.toUserAccount||""))&&t.mint&&Number(t.tokenAmount||0)>0);
        for(const transfer of walletBuy){
          const wallet=String(transfer.toUserAccount),mint=String(transfer.mint),signature=String(event.signature||""),w=meta.get(wallet);
          if(!signature||!mint||!(Number(w.median_buy_sol)>0))continue;
          const native=Array.isArray(event.nativeTransfers)?event.nativeTransfers:[];
          const solAmount=native.filter(t=>String(t.fromUserAccount||"")===wallet).reduce((sum,t)=>sum+Math.max(0,Number(t.amount||0))/1e9,0);
          if(solAmount<Number(w.median_buy_sol)*0.5){underSize++;continue;}
          const group=String(w.correlation_group||wallet),timestamp=Number(event.timestamp||Date.now()/1000)*1000;
          const write=await env.DB.prepare("INSERT OR IGNORE INTO smart_wallet_buys(wallet,mint,signature,slot,occurred_at,sol_amount,correlation_group) VALUES(?,?,?,?,?,?,?)")
            .bind(wallet,mint,signature,Number(event.slot||0),Math.floor(timestamp),solAmount,group).run();stored+=Number(write.meta?.changes||0);
        }
      }
      await env.DB.prepare("DELETE FROM smart_wallet_buys WHERE occurred_at<?").bind(Date.now()-24*60*60*1000).run();
      const recent=await env.DB.prepare("SELECT DISTINCT mint FROM smart_wallet_buys WHERE occurred_at>=?").bind(Date.now()-15*60*1000).all();
      const confluence=[];for(const row of recent.results||[]){const result=await getConfluence(env,row.mint);if(result.signal)confluence.push({signal:result.signal,...result});}
      return json({ok:true,stored,underSize,confluence,gateRequired:true},200,request);
    }
    if(url.pathname==="/smart-wallets"&&request.method==="POST"){
      if(!authorized(request,env))return json({error:"unauthorized"},401,request);
      let body;try{body=await request.json();}catch{return json({error:"invalid_json"},400,request);}
      if(!Array.isArray(body?.wallets))return json({error:"wallets_array_required"},400,request);
      const wallets=body.wallets;if(wallets.filter(w=>w.status==="ACTIVE").length>50)return json({error:"active_wallet_cap_50"},400,request);
      const valid=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;for(const w of wallets){if(!valid.test(String(w.address||""))||!["ACTIVE","WATCH","MUTED"].includes(w.status)||!Number.isFinite(Number(w.median_buy_sol))||Number(w.median_buy_sol)<0)return json({error:"invalid_wallet_metadata"},400,request);}
      await env.DB.prepare("UPDATE curated_smart_wallets SET status='WATCH',updated_at=? WHERE status='ACTIVE'").bind(Date.now()).run();
      for(const w of wallets){await env.DB.prepare("INSERT INTO curated_smart_wallets(address,label,status,median_buy_sol,confidence_score,correlation_group,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET label=excluded.label,status=excluded.status,median_buy_sol=excluded.median_buy_sol,confidence_score=excluded.confidence_score,correlation_group=excluded.correlation_group,updated_at=excluded.updated_at")
        .bind(w.address,String(w.label||"").slice(0,80),w.status,Number(w.median_buy_sol||0),Number(w.confidence_score||0),String(w.correlation_group||"").slice(0,120),Date.now()).run();}
      return json({ok:true,received:wallets.length,active:wallets.filter(w=>w.status==="ACTIVE").length},200,request);
    }
    if(url.pathname==="/v6-gates"&&request.method==="POST"){
      if(!authorized(request,env))return json({error:"unauthorized"},401,request);
      let body;try{body=await request.json();}catch{return json({error:"invalid_json"},400,request);}
      const mint=String(body?.mint||"");if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)||typeof body?.passed!=="boolean")return json({error:"mint_and_boolean_pass_required"},400,request);
      const reasons=Array.isArray(body.reasons)?body.reasons.map(x=>String(x).slice(0,120)).slice(0,20):[];
      await env.DB.prepare("INSERT INTO token_gate_status(mint,passed,checked_at,reasons) VALUES(?,?,?,?) ON CONFLICT(mint) DO UPDATE SET passed=excluded.passed,checked_at=excluded.checked_at,reasons=excluded.reasons").bind(mint,body.passed?1:0,Date.now(),JSON.stringify(reasons)).run();
      return json({ok:true,mint,passed:body.passed,checked_at:Date.now()},200,request);
    }
    if(url.pathname==="/smart-money"&&request.method==="GET"){
      if(!authorized(request,env))return json({error:"unauthorized"},401,request);
      const mint=String(url.searchParams.get("mint")||"");
      if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint))return json({error:"invalid_mint"},400,request);
      return json({ok:true,...await getConfluence(env,mint)},200,request);
    }
    if(url.pathname!=="/state")return json({error:"not_found"},404);
    if(!authorized(request,env))return json({error:"unauthorized"},401);
    if(request.method==="GET"){
      const row=await env.DB.prepare("SELECT payload, version, updated_at FROM portfolio_state WHERE id=?").bind("main").first();
      if(!row)return json({ok:true,portfolio:null,version:0,updated_at:null});
      let portfolio;try{portfolio=JSON.parse(row.payload);}catch{return json({error:"corrupt_state_json"},500);}
      return json({ok:true,portfolio,state:portfolio,version:Number(row.version||0),updated_at:row.updated_at});
    }
    if(request.method!=="POST")return json({error:"method_not_allowed"},405);
    let body;try{body=await request.json();}catch{return json({error:"invalid_json"},400);}
    if(!body||!body.portfolio||typeof body.portfolio!=="object"||Array.isArray(body.portfolio)||!Number.isSafeInteger(Number(body.version))||Number(body.version)<0||!(body.updated_at===null||typeof body.updated_at==="string"))return json({error:"portfolio_version_and_updated_at_required"},400);
    const serialized=JSON.stringify(body.portfolio);if(serialized.length>2_000_000)return json({error:"state_too_large"},413);
    const expected=Number(body.version),updatedAt=new Date().toISOString();
    const result=await env.DB.prepare("UPDATE portfolio_state SET payload=?, updated_at=?, version=version+1 WHERE id=? AND version=? AND updated_at IS ?").bind(serialized,updatedAt,"main",expected,body.updated_at).run();
    if(!result.meta?.changes){const row=await env.DB.prepare("SELECT version,updated_at FROM portfolio_state WHERE id=?").bind("main").first();return json({success:false,error:"version_conflict",version:Number(row?.version||0),updated_at:row?.updated_at||null},409);}
    return json({success:true,version:expected+1,updated_at:updatedAt});
  }
};