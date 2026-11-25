/**
 * Conservative SOL-pair swap reconstruction.
 * Never attributes the whole wallet balance delta when the transaction contains
 * unrelated wallet transfers or multiple token legs.
 */
const DEX_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
]);
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const keyString = k => typeof k === 'string' ? k : k?.pubkey?.toBase58?.() || k?.pubkey || k?.toBase58?.() || null;

function keysFor(tx) {
  const msg = tx?.transaction?.message || tx?.message;
  if (!msg) throw new Error('transaction message missing');
  const stat = (msg.staticAccountKeys || msg.accountKeys || []).map(keyString);
  const lookups = msg.addressTableLookups || [];
  const loaded = tx.meta?.loadedAddresses;
  if (lookups.length && !loaded) throw new Error('unresolved address lookup table');
  const writable = (loaded?.writable || []).map(keyString);
  const readonly = (loaded?.readonly || []).map(keyString);
  if (lookups.length &&
      (writable.length !== lookups.reduce((n,x)=>n+(x.writableIndexes||[]).length,0) ||
       readonly.length !== lookups.reduce((n,x)=>n+(x.readonlyIndexes||[]).length,0))) {
    throw new Error('incomplete address lookup table resolution');
  }
  return stat.concat(writable,readonly);
}
function allInstructions(tx) {
  const msg=tx.transaction?.message||tx.message;
  return [...(msg.instructions||msg.compiledInstructions||[]),
    ...(tx.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[])];
}
function programId(ix,keys) {
  if(ix.programId) return keyString(ix.programId);
  return keys[Number(ix.programIdIndex)]||null;
}
function accountSetFor(ix,keys) {
  return (ix.accounts||[]).map(a=>typeof a==='number'?keys[a]:keyString(a)).filter(Boolean);
}
function parsedSystemTransfer(ix,keys) {
  if(programId(ix,keys)!==SYSTEM_PROGRAM) return null;
  const parsed=ix.parsed;
  if(parsed?.type==='transfer'&&parsed.info) return parsed.info;
  return null;
}

/**
 * Returns a measured swap only when one token mint and one SOL leg are
 * unambiguous. Otherwise returns {swap:null,reason}.
 */
export function reconstructSolSwap(tx,wallet) {
  if(!tx?.meta||tx.meta.err) return {swap:null,reason:'transaction failed or metadata missing'};
  let keys;
  try { keys=keysFor(tx); } catch(e) { return {swap:null,reason:e.message}; }
  const instructions=allInstructions(tx);
  const dexInstructions=instructions.filter(ix=>DEX_PROGRAMS.has(programId(ix,keys)));
  if(!dexInstructions.length) return {swap:null,reason:'no recognized DEX instruction'};
  const dexAccounts=new Set(dexInstructions.flatMap(ix=>accountSetFor(ix,keys)));
  const tokenChanges=new Map();
  const apply=(arr,sign)=>{for(const b of arr||[]){
    if(String(b.owner||'')!==wallet||!b.mint) continue;
    const amount=Number(b.uiTokenAmount?.uiAmountString??b.uiTokenAmount?.uiAmount??0);
    if(!Number.isFinite(amount)) continue;
    tokenChanges.set(b.mint,(tokenChanges.get(b.mint)||0)+sign*amount);
  }};
  apply(tx.meta.preTokenBalances,-1);apply(tx.meta.postTokenBalances,1);
  const legs=[...tokenChanges].filter(([,d])=>Math.abs(d)>1e-12);
  if(legs.length!==1) return {swap:null,reason:legs.length?'multiple token legs; SOL notional ambiguous':'no token balance change'};
  const [mint,tokenDelta]=legs[0];
  const walletIndex=keys.indexOf(wallet);
  if(walletIndex<0) return {swap:null,reason:'wallet missing from resolved account keys'};
  const pre=tx.meta.preBalances||[],post=tx.meta.postBalances||[];
  if(!Number.isFinite(pre[walletIndex])||!Number.isFinite(post[walletIndex])) return {swap:null,reason:'wallet native balance missing'};
  let solDelta=(post[walletIndex]-pre[walletIndex])/1e9;
  const fee=Number(tx.meta.fee||0);
  if(!Number.isFinite(fee)||fee<0) return {swap:null,reason:'invalid transaction fee'};
  if(keys[0]===wallet) solDelta+=fee/1e9;
  // Reject unrelated native transfers. A parsed system transfer is accepted only
  // when its counterparty is an account explicitly touched by the DEX instruction.
  for(const ix of instructions){
    const transfer=parsedSystemTransfer(ix,keys);if(!transfer) continue;
    const source=String(transfer.source||''),destination=String(transfer.destination||'');
    if(source!==wallet&&destination!==wallet) continue;
    const counterparty=source===wallet?destination:source;
    if(!dexAccounts.has(counterparty)) return {swap:null,reason:'unrelated SOL transfer in same transaction'};
  }
  if(tokenDelta>0&&solDelta<0) return {swap:{mint,side:'BUY',tokenAmount:tokenDelta,solAmount:Math.abs(solDelta),slot:Number(tx.slot||0),blockTime:Number(tx.blockTime||0),signature:tx.signature||''},reason:null};
  if(tokenDelta<0&&solDelta>0) return {swap:{mint,side:'SELL',tokenAmount:Math.abs(tokenDelta),solAmount:solDelta,slot:Number(tx.slot||0),blockTime:Number(tx.blockTime||0),signature:tx.signature||''},reason:null};
  return {swap:null,reason:'token and SOL legs do not oppose; non-SOL pair or ambiguous flow'};
}
export {DEX_PROGRAMS};
