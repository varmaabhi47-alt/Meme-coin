/**
 * Select research-listed Solana mints only when their own observed paper-trade
 * rows show positive net PnL. Never use aggregate portfolio PnL as per-mint proof.
 */
export function selectWinningResearchMints(researchRows=[],closedTrades=[],{minSamples=5}={}){
  const aliases=new Map(),eligible=new Set();
  for(const row of researchRows||[]){
    const mint=String(row.token??row.mint??''),chain=String(row.chainId??'').toLowerCase();
    if(chain!=='solana'||!mint||!row.pairAddress||row.security?.pass!==true)continue;
    eligible.add(mint);aliases.set(mint,mint);aliases.set(String(row.pairAddress),mint);
  }
  const totals=new Map();
  for(const trade of closedTrades||[]){
    if(String(trade.chainId??'').toLowerCase()!=='solana')continue;
    const id=String(trade.address??trade.token??trade.mint??trade.pairAddress??''),mint=aliases.get(id)|| (eligible.has(id)?id:null);
    const pnl=Number(trade.netPnlUsd);
    if(!mint||!Number.isFinite(pnl))continue;
    const row=totals.get(mint)||{samples:0,netPnlUsd:0};row.samples++;row.netPnlUsd+=pnl;totals.set(mint,row);
  }
  return [...eligible].filter(mint=>{const row=totals.get(mint);return !!row&&row.samples>=minSamples&&row.netPnlUsd>0;});
}

/**
 * Bounded discovery fallback: recent, explicitly security-checked RESEARCH
 * snapshots may seed candidate discovery. These mints do NOT qualify wallets;
 * every discovered wallet still has to pass the full live RPC curator gates.
 */
export function selectRecentPassingResearchMints(rows=[],{now=Date.now(),maxAgeMs=7*24*60*60*1000,maxMints=3}={}){
  const latest=new Map();
  for(const row of rows||[]){
    const mint=String(row.token??row.mint??''),chain=String(row.chainId??'').toLowerCase();
    const at=Date.parse(row.recordedAt??'');
    if(chain!=='solana'||!mint||!row.pairAddress||row.security?.pass!==true||row.security?.checked!==true||String(row.decision??'').toUpperCase()!=='RESEARCH')continue;
    if(!Number.isFinite(at)||at>now||now-at>maxAgeMs)continue;
    const prior=latest.get(mint);
    if(!prior||at>Date.parse(prior.recordedAt))latest.set(mint,row);
  }
  return [...latest.values()].sort((a,b)=>Date.parse(b.recordedAt)-Date.parse(a.recordedAt)).slice(0,Math.max(0,maxMints)).map(row=>String(row.token??row.mint));
}
