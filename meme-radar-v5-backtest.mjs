/**
 * Historical snapshot replay for the V5 staged paper-exit engine.
 * Only observed snapshots are used. No synthetic candles or interpolated marks.
 */
const finite=v=>Number.isFinite(Number(v))?Number(v):0;
const pct=(price,entry,size,options,friction={})=>{
 const gross=price/entry;
 const sellFee=Math.max(0,finite(options.sellFeeRate??0.003));
 const sellTax=Math.max(0,finite(friction.sellTaxRate??friction.security?.sellTaxRate??options.sellTaxRate??0));
 const slip=(friction.quoteFallback||friction.entryQuoteFallback)?Math.max(0,finite(options.fallbackSlippagePct??8))/100:0;
 const liq=Math.max(0,finite(friction.liquidityUsd));
 const exitImpact=liq>0?Math.min(0.75,size/(2*liq)):0.75;
 const fixed=Math.max(0,finite(friction.networkFeeUsd??options.fixedFeeUsd??0.55));
 const fixedPct=size>0?fixed/size:0;
 return (gross*(1-exitImpact)*(1-sellFee)*(1-sellTax)*(1-slip)-1-fixedPct)*100;
};
export function backtestSnapshots(rows,options={}){
 const minScore=finite(options.minimumScore??80),maxOpen=Math.max(1,Math.floor(finite(options.maxOpenPositions??5)));
 const cooldownMs=Math.max(0,finite(options.tokenCooldownMinutes??60))*60000;
 const maxHoldMs=Math.max(1,finite(options.maxHoldHours??24))*3600000;
 const sl= Math.abs(finite(options.stopLossPct??18)),tp=finite(options.partialTakeProfitPct??40);
 const trail=finite(options.runnerTrailDropPct??15),wide=finite(options.runnerWideTrailDropPct??22);
 const maxEntryLiqDrop=finite(options.liquidityDropFromEntryPct??30),maxCheckDrop=finite(options.liquidityDropPerCheckPct??15);
 const startEquity=Math.max(1,finite(options.startingEquityUsd??1000));
 const baseFraction=Math.max(0,finite(options.baseRiskFraction??0.05)),poolCap=Math.max(0,finite(options.poolLiquidityCapFraction??0.003));
 const clean=(Array.isArray(rows)?rows:[]).map(r=>({...r,ts:Date.parse(r.recordedAt),price:finite(r.priceUsd),liq:finite(r.liquidityUsd),score:finite(r.score),token:String(r.token||r.pairAddress||'')}))
  .filter(r=>Number.isFinite(r.ts)&&r.price>0&&r.liq>0&&r.token).sort((a,b)=>a.ts-b.ts);
 const positions=new Map(),lastEntry=new Map(),trades=[];let cash=startEquity,missingExitSnapshots=0,entryCount=0,equityPeak=startEquity,maxDrawdownPct=0;const trackEquity=()=>{const e=equityAt();equityPeak=Math.max(equityPeak,e);maxDrawdownPct=Math.max(maxDrawdownPct,(equityPeak-e)/equityPeak*100);};
 const equityAt=()=>cash+[...positions.values()].reduce((sum,p)=>sum+p.remainingCost*(p.lastPrice/p.entryPrice),0);
 for(const row of clean){
  let pos=positions.get(row.token);
  if(pos){
   pos.lastPrice=row.price;const peak=Math.max(pos.peakPrice,row.price),gainPeak=(peak/pos.entryPrice-1)*100,dropPeak=(peak-row.price)/peak*100;
   const net=pct(row.price,pos.entryPrice,pos.remainingCost,options,row),entryDrop=pos.entryLiquidity>0?(pos.entryLiquidity-row.liq)/pos.entryLiquidity*100:0,checkDrop=pos.lastLiquidity>0?(pos.lastLiquidity-row.liq)/pos.lastLiquidity*100:0;
   const age=row.ts-pos.entryTs;let reason=null;
   if(entryDrop>maxEntryLiqDrop)reason='LIQ_DROP_ENTRY';else if(checkDrop>maxCheckDrop)reason='LIQ_DROP_CHECK';
   else if(!pos.partial&&net<=-sl)reason='STOP_LOSS';
   else if(pos.partial&&net<=2)reason='BREAKEVEN_STOP';
   else if(pos.partial&&gainPeak>=tp&&dropPeak>=(gainPeak>100?wide:trail))reason='RUNNER_TRAILING';
   else if(age>=maxHoldMs)reason='MAX_HOLD';
   if(!pos.partial&&net>=tp){
    const soldCost=pos.originalSize*0.5,realizedPct=pct(row.price,pos.entryPrice,soldCost,options,row);
    cash+=soldCost*(1+realizedPct/100);pos.realizedPnlUsd=soldCost*realizedPct/100;
    pos.partial=true;pos.remainingCost=soldCost;pos.partialAt=row.recordedAt;pos.partialNetPct=realizedPct;pos.peakPrice=peak;
   }else if(reason){
    const finalNetPct=pct(row.price,pos.entryPrice,pos.remainingCost,options,row),pnl=pos.realizedPnlUsd+pos.remainingCost*finalNetPct/100;
    cash+=pos.remainingCost*(1+finalNetPct/100);
    const trade={token:pos.token,symbol:pos.symbol,entryTime:pos.entryTime,exitTime:row.recordedAt,entryPrice:pos.entryPrice,exitPrice:row.price,entryScore:pos.score,entrySizeUsd:pos.originalSize,partialTpDone:pos.partial,partialExitTime:pos.partialAt||null,partialNetReturnPct:pos.partialNetPct??null,finalExitReason:reason,netPnlUsd:pnl,netReturnPct:pos.originalSize?pnl/pos.originalSize*100:0,quoteFallback:!!(pos.entryQuoteFallback||row.quoteFallback)};
    trades.push(trade);positions.delete(row.token);lastEntry.set(row.token,row.ts);
   }
   pos.peakPrice=peak;pos.lastLiquidity=row.liq;trackEquity();continue;
  }
  if(row.score<minScore||row.decision==='REJECT'||row.decision==='PREFILTER_REJECT'||row.tier==='REJECT'||row.tier==='PREFILTER_REJECT'||row.security?.pass!==true)continue;
  if(row.tier&&row.tier!=='RESEARCH')continue;
  if(row.decision!=='RESEARCH')continue;
  if(row.ts-(lastEntry.get(row.token)??-Infinity)<cooldownMs)continue;
  if(positions.size>=maxOpen)continue;
  const equity=equityAt(),tierMult=row.smartMoneyConfluence===true?1:0.75;
  const size=Math.min(equity*baseFraction*tierMult,row.liq*poolCap,cash);
  if(!(size>0))continue;
  const entryImpact=Math.min(0.75,size/(2*row.liq)),entryFee=Math.max(0,finite(options.entryFeeRate??0.003)),buyTax=Math.max(0,finite(row.buyTaxRate??row.security?.buyTaxRate??options.buyTaxRate??0)),entrySlip=row.entryQuoteFallback?Math.max(0,finite(options.fallbackSlippagePct??5))/100:0,entryGas=Math.max(0,finite(row.networkFeeUsd??options.fixedFeeUsd??0.35));
  const effectiveEntryPrice=row.price*(1+entryImpact)*(1+entryFee)*(1+buyTax)*(1+entrySlip)+entryGas/size;
  cash-=size;positions.set(row.token,{token:row.token,symbol:row.symbol||'UNKNOWN',entryTime:row.recordedAt,entryTs:row.ts,entryPrice:effectiveEntryPrice,entryLiquidity:row.liq,lastLiquidity:row.liq,lastPrice:row.price,peakPrice:row.price,score:row.score,originalSize:size,remainingCost:size,partial:false,realizedPnlUsd:0,entryQuoteFallback:!!row.entryQuoteFallback,buyTaxRate:buyTax,sellTaxRate:finite(row.sellTaxRate??row.security?.sellTaxRate??options.sellTaxRate??0),networkFeeUsd:entryGas});entryCount++;trackEquity();
 }
 missingExitSnapshots=[...positions.values()].length;
 const equityCurve=[startEquity];let equity=equityAt();equityCurve.push(equity);
 const pnl=trades.map(t=>t.netPnlUsd),wins=pnl.filter(x=>x>0),losses=pnl.filter(x=>x<0),grossWin=wins.reduce((a,b)=>a+b,0),grossLoss=Math.abs(losses.reduce((a,b)=>a+b,0));
 const largest=pnl.length?Math.max(0,...pnl):0;
 const largestIndex=pnl.length?pnl.indexOf(largest):-1,adjustedTrades=trades.filter((_,i)=>i!==largestIndex),adjustedWins=adjustedTrades.filter(t=>t.netPnlUsd>0).reduce((s,t)=>s+t.netPnlUsd,0),adjustedLosses=Math.abs(adjustedTrades.filter(t=>t.netPnlUsd<0).reduce((s,t)=>s+t.netPnlUsd,0)),outlierAdjustedProfitFactor=adjustedLosses?adjustedWins/adjustedLosses:(adjustedWins>0?'Infinity':null);
 return {mode:'observed-snapshot-staged-exit-replay',options:{minimumScore:minScore,maxOpenPositions:maxOpen,partialTakeProfitPct:tp,stopLossPct:sl,runnerTrailDropPct:trail,runnerWideTrailDropPct:wide,liquidityDropFromEntryPct:maxEntryLiqDrop,liquidityDropPerCheckPct:maxCheckDrop,baseRiskFraction:baseFraction,poolLiquidityCapFraction:poolCap},snapshotsUsed:clean.length,entryCount,trades:trades.length,openAtEnd:missingExitSnapshots,missingExitSnapshots,winRatePct:trades.length?wins.length/trades.length*100:null,profitFactor:grossLoss?grossWin/grossLoss:(grossWin>0?'Infinity':null),netPnlUsd:pnl.reduce((a,b)=>a+b,0),pnlExcludingLargestTradeUsd:pnl.reduce((a,b)=>a+b,0)-largest,outlierAdjustedPnlUsd:pnl.reduce((a,b)=>a+b,0)-largest,outlierAdjustedProfitFactor,EDGE_VERIFIED:trades.length>=100&&adjustedWins>adjustedLosses&&adjustedWins>0,largestTradePnlUsd:trades.length?largest:null,maxDrawdownPct,endingEquityUsd:equity,pnlFromClosedTradesUsd:pnl.reduce((a,b)=>a+b,0),results:trades};
}
export async function readJsonlSnapshots(filePath,fsModule){if(!fsModule)fsModule=await import('node:fs/promises');const content=await fsModule.readFile(filePath,'utf8').catch(e=>{if(e.code==='ENOENT')return'';throw e;});return content.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});}
