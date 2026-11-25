/**
 * Historical snapshot replay for the V5 staged paper-exit engine.
 * Only observed snapshots are used. No synthetic candles or interpolated marks.
 */
const finite=v=>Number.isFinite(Number(v))?Number(v):0;
const pct=(price,entry,size,options)=>{
 const gross=price/entry;
 const entryFee=Math.max(0,finite(options.entryFeeRate??0.003));
 const sellFee=Math.max(0,finite(options.sellFeeRate??0.003));
 const fixed=Math.max(0,finite(options.fixedFeeUsd??0.35));
 const fixedPct=size>0?fixed/size:0;
 return (gross*(1-entryFee)*(1-sellFee)-1-fixedPct)*100;
};
export function backtestSnapshots(rows,options={}){
 const minScore=finite(options.minimumScore??80),maxOpen=Math.max(1,Math.floor(finite(options.maxOpenPositions??5)));
 const cooldownMs=Math.max(0,finite(options.tokenCooldownMinutes??60))*60000;
 const maxHoldMs=Math.max(1,finite(options.maxHoldHours??24))*3600000;
 const sl= Math.abs(finite(options.stopLossPct??18)),tp=finite(options.partialTakeProfitPct??40);
 const trail=finite(options.runnerTrailDropPct??15),wide=finite(options.runnerWideTrailDropPct??20);
 const maxEntryLiqDrop=finite(options.liquidityDropFromEntryPct??35),maxCheckDrop=finite(options.liquidityDropPerCheckPct??20);
 const startEquity=Math.max(1,finite(options.startingEquityUsd??1000));
 const baseFraction=Math.max(0,finite(options.baseRiskFraction??0.06)),poolCap=Math.max(0,finite(options.poolLiquidityCapFraction??0.0035));
 const clean=(Array.isArray(rows)?rows:[]).map(r=>({...r,ts:Date.parse(r.recordedAt),price:finite(r.priceUsd),liq:finite(r.liquidityUsd),score:finite(r.score),token:String(r.token||r.pairAddress||'')}))
  .filter(r=>Number.isFinite(r.ts)&&r.price>0&&r.liq>0&&r.token).sort((a,b)=>a.ts-b.ts);
 const positions=new Map(),lastEntry=new Map(),trades=[];let cash=startEquity,missingExitSnapshots=0,entryCount=0;
 const equityAt=()=>cash+[...positions.values()].reduce((sum,p)=>sum+p.remainingCost*(p.lastPrice/p.entryPrice),0);
 for(const row of clean){
  let pos=positions.get(row.token);
  if(pos){
   pos.lastPrice=row.price;const peak=Math.max(pos.peakPrice,row.price),gainPeak=(peak/pos.entryPrice-1)*100,dropPeak=(peak-row.price)/peak*100;
   const net=pct(row.price,pos.entryPrice,pos.originalSize,options),entryDrop=pos.entryLiquidity>0?(pos.entryLiquidity-row.liq)/pos.entryLiquidity*100:0,checkDrop=pos.lastLiquidity>0?(pos.lastLiquidity-row.liq)/pos.lastLiquidity*100:0;
   const age=row.ts-pos.entryTs;let reason=null;
   if(entryDrop>maxEntryLiqDrop)reason='LIQ_DROP_ENTRY';else if(checkDrop>maxCheckDrop)reason='LIQ_DROP_CHECK';
   else if(!pos.partial&&net<=-sl)reason='STOP_LOSS';
   else if(pos.partial&&net<=2)reason='BREAKEVEN_STOP';
   else if(pos.partial&&gainPeak>=tp&&dropPeak>=(gainPeak>100?wide:trail))reason='RUNNER_TRAILING';
   else if(age>=maxHoldMs)reason='MAX_HOLD';
   if(!pos.partial&&net>=tp){
    const realizedPct=pct(row.price,pos.entryPrice,pos.originalSize,options);
    const soldCost=pos.originalSize*0.5;cash+=soldCost*(1+realizedPct/100);pos.realizedPnlUsd=soldCost*realizedPct/100;
    pos.partial=true;pos.remainingCost=soldCost;pos.partialAt=row.recordedAt;pos.partialNetPct=realizedPct;pos.peakPrice=peak;
   }else if(reason){
    const finalNetPct=pct(row.price,pos.entryPrice,pos.originalSize,options),pnl=pos.realizedPnlUsd+pos.remainingCost*finalNetPct/100;
    cash+=pos.remainingCost*(1+finalNetPct/100);
    const trade={token:pos.token,symbol:pos.symbol,entryTime:pos.entryTime,exitTime:row.recordedAt,entryPrice:pos.entryPrice,exitPrice:row.price,entryScore:pos.score,entrySizeUsd:pos.originalSize,partialTpDone:pos.partial,partialExitTime:pos.partialAt||null,partialNetReturnPct:pos.partialNetPct??null,finalExitReason:reason,netPnlUsd:pnl,netReturnPct:pos.originalSize?pnl/pos.originalSize*100:0,quoteFallback:!!(pos.entryQuoteFallback||row.quoteFallback)};
    trades.push(trade);positions.delete(row.token);lastEntry.set(row.token,row.ts);
   }
   pos.peakPrice=peak;pos.lastLiquidity=row.liq;continue;
  }
  if(row.score<minScore||row.decision==='REJECT'||row.decision==='PREFILTER_REJECT'||row.tier==='REJECT'||row.tier==='PREFILTER_REJECT'||row.security?.pass===false)continue;
  if(row.tier&&row.tier!=='RESEARCH')continue;
  if(row.ts-(lastEntry.get(row.token)??-Infinity)<cooldownMs)continue;
  if(positions.size>=maxOpen)continue;
  const equity=equityAt(),tierMult=row.score>=90?1:row.score>=80?0.8:0;
  const size=Math.min(equity*baseFraction*tierMult,row.liq*poolCap,cash);
  if(!(size>0))continue;
  cash-=size;positions.set(row.token,{token:row.token,symbol:row.symbol||'UNKNOWN',entryTime:row.recordedAt,entryTs:row.ts,entryPrice:row.price,entryLiquidity:row.liq,lastLiquidity:row.liq,lastPrice:row.price,peakPrice:row.price,score:row.score,originalSize:size,remainingCost:size,partial:false,realizedPnlUsd:0,entryQuoteFallback:!!row.entryQuoteFallback});entryCount++;
 }
 missingExitSnapshots=[...positions.values()].length;
 const equityCurve=[startEquity];let equity=startEquity,peak=startEquity,maxDrawdownPct=0;
 for(const t of trades){equity+=t.netPnlUsd;peak=Math.max(peak,equity);maxDrawdownPct=Math.max(maxDrawdownPct,(peak-equity)/peak*100);equityCurve.push(equity);}
 const pnl=trades.map(t=>t.netPnlUsd),wins=pnl.filter(x=>x>0),losses=pnl.filter(x=>x<0),grossWin=wins.reduce((a,b)=>a+b,0),grossLoss=Math.abs(losses.reduce((a,b)=>a+b,0));
 const largest=pnl.length?Math.max(...pnl):0;
 return {mode:'observed-snapshot-staged-exit-replay',options:{minimumScore:minScore,maxOpenPositions:maxOpen,partialTakeProfitPct:tp,stopLossPct:sl,runnerTrailDropPct:trail,runnerWideTrailDropPct:wide,liquidityDropFromEntryPct:maxEntryLiqDrop,liquidityDropPerCheckPct:maxCheckDrop,baseRiskFraction:baseFraction,poolLiquidityCapFraction:poolCap},snapshotsUsed:clean.length,entryCount,trades:trades.length,openAtEnd:missingExitSnapshots,missingExitSnapshots,winRatePct:trades.length?wins.length/trades.length*100:null,profitFactor:grossLoss?grossWin/grossLoss:(grossWin>0?null:null),netPnlUsd:pnl.reduce((a,b)=>a+b,0),pnlExcludingLargestTradeUsd:pnl.reduce((a,b)=>a+b,0)-largest,largestTradePnlUsd:trades.length?largest:null,maxDrawdownPct,endingEquityUsd:startEquity+pnl.reduce((a,b)=>a+b,0),results:trades};
}
export async function readJsonlSnapshots(filePath,fsModule){if(!fsModule)fsModule=await import('node:fs/promises');const content=await fsModule.readFile(filePath,'utf8').catch(e=>{if(e.code==='ENOENT')return'';throw e;});return content.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});}
