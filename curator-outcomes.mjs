/**
 * Attribute token-price research snapshots to observed smart-wallet buys.
 * Price outcomes are horizon-specific and never inferred from aggregate token
 * paperLearning fields. Missing horizon data stays null.
 */
const HORIZONS=[15,60,240];
const timeMs=value=>{
  const n=typeof value==='number'?value:Date.parse(value);
  if(!Number.isFinite(n))return null;
  return n<1e12?n*1000:n;
};
const priceOf=r=>Number(r.priceUsd??r.price_usd??NaN);
const mintOf=r=>String(r.token??r.mint??'');
function snapshotsByMint(rows){
  const map=new Map();
  for(const r of rows||[]){const mint=mintOf(r),time=timeMs(r.recordedAt??r.timestamp??r.time),price=priceOf(r);
    if(!mint||time===null||!Number.isFinite(price)||price<=0)continue;
    const list=map.get(mint)||[];list.push({time,price,raw:r});map.set(mint,list);
  }
  for(const list of map.values())list.sort((a,b)=>a.time-b.time);
  return map;
}
function pickEntry(list,buyTime){
  // Prefer a snapshot at/just after the event; a pre-entry stale price is not
  // used to pretend the observed wallet executed at that price.
  return list.find(x=>x.time>=buyTime&&x.time<=buyTime+2*60*1000)||null;
}
function pickHorizon(list,target,latestAllowed){
  return list.find(x=>x.time>=target&&x.time<=latestAllowed)||null;
}
export function attributeWalletOutcomes(buys,research,{max15mLagMin=10,max60mLagMin=30,max4hLagMin=60}={}){
  const byMint=snapshotsByMint(research),dedup=new Set(),outcomes=[];
  for(const buy of buys||[]){
    const wallet=String(buy.wallet??buy.address??''),mint=String(buy.mint??buy.token??''),signature=String(buy.signature??'');
    const boughtAt=timeMs(buy.occurred_at??buy.occurredAt??buy.timestamp);
    if(!wallet||!mint||boughtAt===null)continue;
    const id=signature?wallet+'|'+signature+'|'+mint:wallet+'|'+mint+'|'+boughtAt;
    if(dedup.has(id))continue;dedup.add(id);
    const list=byMint.get(mint)||[],entry=pickEntry(list,boughtAt);
    const row={wallet,mint,signature,entryTime:boughtAt,entryPriceUsd:entry?.price??null,solAmount:Number(buy.sol_amount??buy.solAmount??0),outcomes:{}};
    for(const mins of HORIZONS){
      const lag=mins===15?max15mLagMin:mins===60?max60mLagMin:max4hLagMin;
      const sample=entry?pickHorizon(list,boughtAt+mins*60*1000,boughtAt+(mins+lag)*60*1000):null;
      row.outcomes[mins+'m']=sample&&entry?{observedAt:sample.time,priceUsd:sample.price,returnPct:(sample.price/entry.price-1)*100}:null;
    }
    const explicitRug=list.some(x=>x.time>=boughtAt&&x.time<=boughtAt+4*60*60*1000&&
      (x.raw.rugPull===true||x.raw.outcome==='RUG'||x.raw.security?.rug===true));
    row.rug=explicitRug;
    outcomes.push(row);
  }
  return outcomes;
}
export function summarizeWalletOutcomes(outcomes){
  const grouped=new Map();
  for(const o of outcomes||[]){const list=grouped.get(o.wallet)||[];list.push(o);grouped.set(o.wallet,list);}
  return [...grouped].map(([wallet,rows])=>{
    const result={wallet,observations:rows.length,rugEntries:rows.filter(x=>x.rug).length,horizons:{}};
    for(const h of HORIZONS){const vals=rows.map(x=>x.outcomes?.[h+'m']?.returnPct).filter(Number.isFinite);
      result.horizons[h+'m']={samples:vals.length,hitRatePct:vals.length?vals.filter(x=>x>0).length/vals.length*100:null,meanReturnPct:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null};}
    return result;
  });
}
