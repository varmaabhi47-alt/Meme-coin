/**
 * Pure confluence evaluator shared by Worker and unit tests.
 * Independent wallet groups must buy the same mint at qualifying size in
 * distinct slots inside the rolling window, and a recent passing token gate
 * is mandatory.
 */
export function evaluateSmartMoneyConfluence({wallets=[],buys=[],gate=null,now=Date.now(),windowMs=15*60*1000,gateMaxAgeMs=5*60*1000,minConfluence=2}={}){
  const required=Math.max(2,Math.min(3,Number.isFinite(Number(minConfluence))?Math.floor(Number(minConfluence)):2));
  const active=new Map((wallets||[]).filter(w=>w.status==='ACTIVE').map(w=>[String(w.address),w]));
  const eligible=(buys||[]).filter(row=>{
    const wallet=String(row.wallet||''),w=active.get(wallet),at=Number(row.occurred_at),amount=Number(row.sol_amount),median=Number(w?.median_buy_sol);
    return !!w&&Number.isFinite(at)&&at<=now&&at>=now-windowMs&&Number.isFinite(amount)&&amount>0&&Number.isFinite(median)&&median>0&&amount>=median*0.5;
  }).sort((a,b)=>Number(b.occurred_at)-Number(a.occurred_at));
  const byGroup=new Map();
  for(const row of eligible){const w=active.get(String(row.wallet)),group=String(w?.correlation_group||row.correlation_group||row.wallet);if(!byGroup.has(group))byGroup.set(group,row);}
  const independent=[...byGroup.values()],slots=new Set(independent.map(r=>Number(r.slot)).filter(Number.isFinite));
  const checkedAt=Number(gate?.checked_at),gateFresh=!!gate&&(gate.passed===true||Number(gate.passed)===1)&&Number.isFinite(checkedAt)&&checkedAt<=now&&now-checkedAt<=gateMaxAgeMs;
  const ready=independent.length>=required&&slots.size>=required&&gateFresh;
  return {wallets:new Set(independent.map(r=>String(r.wallet))).size,walletAddresses:[...new Set(independent.map(r=>String(r.wallet)))],independentGroups:independent.length,distinctSlots:slots.size,required,gateFresh,signal:ready?'SMART_MONEY_CONFLUENCE':null,latest:Math.max(0,...independent.map(r=>Number(r.occurred_at)||0)),reasons:[...(independent.length<required?['insufficient-independent-wallets']:[]),...(slots.size<required?['insufficient-distinct-slots']:[]),...(!gateFresh?['token-gate-missing-stale-or-failed']:[])]};
}
