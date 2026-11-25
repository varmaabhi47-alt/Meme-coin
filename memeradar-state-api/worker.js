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
        cooldowns:raw.cooldowns||{},decisionLog:(Array.isArray(raw.decisionLog)?raw.decisionLog:[]).slice(0,150).map(d=>({ts:Number(d.ts||0),timeStr:cleanText(d.timeStr),action:cleanText(d.action),symbol:cleanText(d.symbol),chainId:cleanText(d.chainId),reason:cleanText(d.reason)}))
      };
      return json({ok:true,portfolio,version:Number(row.version||0),updated_at:row.updated_at},200,request);
    }
    if(url.pathname==="/webhook/helius"&&request.method==="POST"){
      const secret=String(env.HELIUS_WEBHOOK_SECRET||"");
      if(!secret)return json({error:"webhook_secret_not_configured"},503,request);
      const raw=await request.text();
      const supplied=request.headers.get("X-Helius-Signature")||"";
      const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
      const digest=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw)));
      const expected=[...digest].map(b=>b.toString(16).padStart(2,"0")).join("");
      if(supplied.length!==expected.length)return json({error:"invalid_signature"},401,request);
      // Fixed-length comparison without early exit.
      let diff=0;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^supplied.charCodeAt(i);
      if(diff!==0)return json({error:"invalid_signature"},401,request);
      let events;try{events=JSON.parse(raw);}catch{return json({error:"invalid_json"},400,request);}
      if(!Array.isArray(events))events=[events];
      const allow=new Set(String(env.SMART_WALLETS||"").split(",").map(x=>x.trim()).filter(Boolean));
      if(!allow.size)return json({error:"smart_wallet_allowlist_empty"},400,request);
      let stored=0;
      for(const event of events){
        if(String(event?.type||"").toUpperCase()!=="SWAP")continue;
        const transfers=Array.isArray(event.tokenTransfers)?event.tokenTransfers:[];
        const walletBuy=transfers.filter(t=>allow.has(String(t.toUserAccount||""))&&t.mint&&Number(t.tokenAmount||0)>0);
        for(const transfer of walletBuy){
          const wallet=String(transfer.toUserAccount),mint=String(transfer.mint),signature=String(event.signature||"");
          if(!signature||!mint)continue;
          const timestamp=Number(event.timestamp||Date.now()/1000)*1000;
          await env.DB.prepare("INSERT OR IGNORE INTO smart_wallet_buys(wallet,mint,signature,slot,occurred_at) VALUES(?,?,?,?,?)")
            .bind(wallet,mint,signature,Number(event.slot||0),Math.floor(timestamp)).run();
          stored++;
        }
      }
      const recent=await env.DB.prepare("SELECT mint,COUNT(DISTINCT wallet) AS wallets,MAX(occurred_at) AS latest FROM smart_wallet_buys WHERE occurred_at>=? GROUP BY mint HAVING COUNT(DISTINCT wallet)>=2")
        .bind(Date.now()-15*60*1000).all();
      return json({ok:true,stored,confluence:(recent.results||[]).map(x=>({signal:"SMART_MONEY_CONFLUENCE",mint:x.mint,wallets:Number(x.wallets),latest:Number(x.latest)}))},200,request);
    }
    if(url.pathname==="/smart-money"&&request.method==="GET"){
      if(!authorized(request,env))return json({error:"unauthorized"},401,request);
      const mint=String(url.searchParams.get("mint")||"");
      if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint))return json({error:"invalid_mint"},400,request);
      const row=await env.DB.prepare("SELECT COUNT(DISTINCT wallet) AS wallets,MAX(occurred_at) AS latest FROM smart_wallet_buys WHERE mint=? AND occurred_at>=?")
        .bind(mint,Date.now()-15*60*1000).first();
      const wallets=Number(row?.wallets||0);
      return json({ok:true,mint,wallets,signal:wallets>=2?"SMART_MONEY_CONFLUENCE":null,latest:Number(row?.latest||0)},200,request);
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