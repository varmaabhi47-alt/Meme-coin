/**
 * MEME.RADAR v5 intelligence core.
 * Pure, deterministic functions shared by the paper bot and Node tests.
 * This is a screening heuristic, not a prediction or guarantee of safety.
 */

export const V5_SCORE_VERSION = '5.1.0';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function scoreCandidate(pair, security = { pass: false }) {
  const liq = num(pair?.liquidity?.usd);
  const vol24 = num(pair?.volume?.h24);
  const vol1h = num(pair?.volume?.h1);
  const buys5m = num(pair?.txns?.m5?.buys);
  const sells5m = num(pair?.txns?.m5?.sells);
  const buys1h = num(pair?.txns?.h1?.buys);
  const sells1h = num(pair?.txns?.h1?.sells);
  const buys24 = num(pair?.txns?.h24?.buys);
  const sells24 = num(pair?.txns?.h24?.sells);
  const fdv = num(pair?.fdv || pair?.marketCap);
  const buyRatio5m = buys5m + sells5m ? buys5m / (buys5m + sells5m) : 0;
  const buyRatio1h = buys1h + sells1h ? buys1h / (buys1h + sells1h) : 0;
  const buyRatio24 = buys24 + sells24 ? buys24 / (buys24 + sells24) : 0;
  const liqFdv = fdv > 0 ? liq / fdv : 0;
  const turnover = liq > 0 ? vol24 / liq : 0;
  const change5m = num(pair?.priceChange?.m5);
  const change1h = num(pair?.priceChange?.h1);

  // Scores deliberately reward sustained, two-window demand rather than one spike.
  const liquidityScore = clamp((liq / 150000) * 60 + (liqFdv / 0.2) * 40);
  const demandScore = clamp((buyRatio1h * 55 + buyRatio24 * 45) * 100);
  const activityScore = clamp(Math.min(100, (buys1h + sells1h) * 2) * 0.6 + Math.min(100, vol1h / 1000) * 0.4);
  const momentumScore = clamp(50 + change5m * 2 + change1h * 0.8);
  const turnoverScore = clamp(turnover > 0 ? 100 - Math.abs(Math.log(Math.max(turnover, 0.01) / 2)) * 22 : 0);
  const securityScore = security?.pass === true ? 100 : 0;

  const score = Math.round(
    liquidityScore * 0.20 +
    demandScore * 0.20 +
    activityScore * 0.15 +
    momentumScore * 0.15 +
    turnoverScore * 0.10 +
    securityScore * 0.20
  );

  const hardReject = security?.pass !== true || change5m > 30 || change1h > 150 || buyRatio5m < 0.55 || buyRatio1h < 0.52 || liqFdv < 0.08;
  const reasons = [];
  if (hardReject) reasons.push('security audit not passed');
  if (liq < 75000) reasons.push('liquidity below $75k');
  if (buys1h + sells1h < 10) reasons.push('insufficient 1h transactions');
  if (vol24 < 50000) reasons.push('24h volume below $50k');
  if (buyRatio1h < 0.52) reasons.push('1h buy ratio below 52%');
  if (liqFdv < 0.08) reasons.push('liquidity/FDV below 8%');
  if (turnover > 20) reasons.push('extreme turnover; possible churn');
  if (change5m > 30) reasons.push('HARD REJECT: 5m price change above +30%');
  if (change1h > 150) reasons.push('HARD REJECT: 1h price change above +150%');
  if (buyRatio5m < 0.55) reasons.push('5m buy ratio below 55%');

  return {
    version: V5_SCORE_VERSION,
    score,
    tier: hardReject || reasons.length ? 'REJECT' : score >= 80 ? 'RESEARCH' : score >= 65 ? 'WATCH' : 'WEAK',
    hardReject,
    reasons,
    components: {
      liquidity: Math.round(liquidityScore),
      demand: Math.round(demandScore),
      activity: Math.round(activityScore),
      momentum: Math.round(momentumScore),
      turnover: Math.round(turnoverScore),
      security: Math.round(securityScore)
    },
    metrics: { liq, vol24, vol1h, buys5m, sells5m, buyRatio5m, buys1h, sells1h, buyRatio1h, buyRatio24, liqFdv, turnover, change5m, change1h }
  };
}

/**
 * Constant-product pool approximation using quote-side reserve ~= total TVL / 2.
 * It is intentionally more conservative than tradeUsd/(2*TVL).
 * It is not a live route quote; production execution research should use an aggregator quote.
 */
export function estimateConstantProductImpact(tradeUsd, liquidityUsd) {
  const trade = num(tradeUsd);
  const liquidity = num(liquidityUsd);
  if (trade <= 0 || liquidity <= 0) return { impactRate: 1, valid: false };
  const reserveQuote = liquidity / 2;
  const x = trade / reserveQuote;
  const impactRate = clamp(1 - Math.log1p(x) / x, 0, 0.95);
  return { impactRate, valid: true, model: 'constant-product-average-price-approximation' };
}

export function calculatePaperBuy(usd, spotPrice, liquidityUsd, feeRate = 0.003) {
  const amount = num(usd), price = num(spotPrice), fee = num(feeRate);
  if (amount <= 0 || price <= 0 || fee < 0 || fee >= 1) throw new Error('Invalid buy inputs');
  const impact = estimateConstantProductImpact(amount, liquidityUsd);
  if (!impact.valid) throw new Error('Cannot estimate impact without positive liquidity');
  const feeUsd = amount * fee;
  const netUsd = amount - feeUsd;
  const effectivePrice = price * (1 + impact.impactRate);
  return {
    feeUsd,
    impactRate: impact.impactRate,
    impactUsd: netUsd * impact.impactRate,
    effectivePrice,
    tokens: netUsd / effectivePrice,
    model: impact.model
  };
}

export function calculatePaperSell(tokens, spotPrice, liquidityUsd, feeRate = 0.003) {
  const qty = num(tokens), price = num(spotPrice), fee = num(feeRate);
  if (qty <= 0 || price <= 0 || fee < 0 || fee >= 1) throw new Error('Invalid sell inputs');
  const gross = qty * price;
  const impact = estimateConstantProductImpact(gross, liquidityUsd);
  if (!impact.valid) throw new Error('Cannot estimate impact without positive liquidity');
  const effectivePrice = price * (1 - impact.impactRate);
  const afterImpact = qty * effectivePrice;
  const feeUsd = afterImpact * fee;
  return {
    effectivePrice,
    impactRate: impact.impactRate,
    impactUsd: gross - afterImpact,
    feeUsd,
    netProceeds: Math.max(0, afterImpact - feeUsd),
    model: impact.model
  };
}

/**
 * Converts a Jupiter quote-only /order response into paper exit proceeds.
 * Jupiter returns outAmount in the output token's smallest unit (USDC = 6 decimals).
 * No taker is supplied, so no transaction is assembled or executable.
 */
export function calculateJupiterQuoteExit({ quote, tokens, spotPrice, outputDecimals = 6 }) {
  const qty = num(tokens), spot = num(spotPrice), decimals = Number(outputDecimals);
  const outRaw = quote?.outAmount;
  if (!/^\d+$/.test(String(outRaw ?? '')) || qty <= 0 || spot <= 0 ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('Invalid Jupiter quote exit inputs');
  }
  const netProceeds = Number(outRaw) / (10 ** decimals);
  if (!Number.isFinite(netProceeds) || netProceeds <= 0) throw new Error('Jupiter quote has no usable output');
  const grossSpotValue = qty * spot;
  return {
    netProceeds,
    effectivePrice: netProceeds / qty,
    impactUsd: Math.max(0, grossSpotValue - netProceeds),
    impactRate: grossSpotValue > 0 ? clamp(1 - netProceeds / grossSpotValue, 0, 1) : 1,
    feeUsd: 0,
    model: 'jupiter-route-quote',
    router: typeof quote.router === 'string' ? quote.router : null,
    quoteOnly: true
  };
}

export function detectBasicMarketWarnings(pair) {
  const warnings = [];
  const buys = num(pair?.txns?.h1?.buys), sells = num(pair?.txns?.h1?.sells);
  const volume = num(pair?.volume?.h1), liquidity = num(pair?.liquidity?.usd);
  const priceMove = num(pair?.priceChange?.m5);
  if (buys + sells >= 20 && volume > 0 && liquidity > 0 && volume / liquidity > 5) warnings.push('high 1h turnover vs liquidity');
  if (sells > buys * 1.8 && sells >= 10) warnings.push('sell pressure exceeds buys');
  if (priceMove > 25) warnings.push('extreme 5m price expansion');
  if (!pair?.pairCreatedAt) warnings.push('pair age unavailable');
  return warnings;
}

export function calculateTopHolderConcentration(largestAccounts,totalSupplyRaw,excludedAddresses=[]){
 let supply;try{supply=BigInt(String(totalSupplyRaw||'0'));}catch{supply=0n;}
 if(supply<=0n||!Array.isArray(largestAccounts))return{known:false,top5Pct:null,top10Pct:null,reason:'holder data unavailable'};
 const knownBurn=new Set(['1nc1nerator11111111111111111111111111111111','11111111111111111111111111111111']);
 const excluded=new Set([...knownBurn,...(Array.isArray(excludedAddresses)?excludedAddresses:[])].filter(Boolean).map(String));
 const aggregate=new Map();let excludedCount=0;
 largestAccounts.forEach((account,index)=>{
  const address=String(account.address||''),owner=String(account.owner||''),key=owner||address||'account-'+index;
  if(excluded.has(address)||excluded.has(owner)){excludedCount++;return;}
  let amount=0n;try{amount=BigInt(String(account.amount||'0'));}catch{}
  if(amount>0n)aggregate.set(key,(aggregate.get(key)||0n)+amount);
 });
 const amounts=[...aggregate.values()].sort((a,b)=>a>b?-1:a<b?1:0);
 const sum=list=>list.reduce((total,amount)=>total+amount,0n),pct=amount=>Number((amount*1000000n)/supply)/10000;
 return{known:true,top5Pct:pct(sum(amounts.slice(0,5))),top10Pct:pct(sum(amounts.slice(0,10))),holdersObserved:amounts.length,excludedAccounts:excludedCount,interpretation:'Largest observed token holders aggregated by owner; known burn and supplied pool addresses excluded. LP identification is conservative and may not classify every pool token account.'};
}

/**
 * Transparent Solana authority/holder heuristics.
 * These signals are clues for manual review, not proof of a creator's identity
 * or coordinated wallets. Holder owners are derived from parsed token accounts.
 */
export function analyzeCreatorSignals({
  mintAuthority = null,
  freezeAuthority = null,
  authoritySignatureCount = null,
  holderOwners = [],
  priorAuthorityRows = []
} = {}) {
  const owners = holderOwners.filter(owner => typeof owner === 'string' && owner.length > 20);
  const uniqueOwners = [...new Set(owners)];
  const counts = new Map();
  for (const owner of owners) counts.set(owner, (counts.get(owner) || 0) + 1);
  const repeatedOwners = [...counts.entries()].filter(([, count]) => count > 1)
    .map(([address, count]) => ({ address, count }));
  const authoritySet = new Set([mintAuthority, freezeAuthority].filter(Boolean));
  const authorityHolderOverlap = uniqueOwners.filter(owner => authoritySet.has(owner));
  const priorTokens = new Set();
  if (mintAuthority) {
    for (const row of priorAuthorityRows) {
      if (row?.creatorSignals?.mintAuthority === mintAuthority && row.token) priorTokens.add(row.token);
    }
  }
  const reusedMintAuthorityTokens = priorTokens.size;
  const warnings = [];
  if (mintAuthority) warnings.push('mint authority is active; minting control remains');
  if (freezeAuthority) warnings.push('freeze authority is active; freeze control remains');
  if (authorityHolderOverlap.length) warnings.push('authority wallet also appears among observed top-holder owners');
  if (reusedMintAuthorityTokens > 0) warnings.push('mint authority appeared on previously recorded token(s); review possible deployer reuse');
  if (repeatedOwners.length) warnings.push('same owner controls multiple observed top token accounts');
  if (Number.isFinite(authoritySignatureCount) && authoritySignatureCount >= 500) warnings.push('authority wallet has at least 500 recent signatures; activity count is not a reputation score');
  return {
    known: true,
    mintAuthority,
    freezeAuthority,
    authoritySignatureCount: Number.isFinite(authoritySignatureCount) ? authoritySignatureCount : null,
    holderOwnersObserved: uniqueOwners.length,
    holderOwnerAddresses: uniqueOwners,
    repeatedHolderOwners: repeatedOwners,
    authorityHolderOverlap,
    reusedMintAuthorityTokens,
    warnings,
    interpretation: 'RPC-visible authorities and token-account owners only; not proof of creator identity, common beneficial ownership, or manipulation'
  };
}


/**
 * Groups exact RPC-observed authority and token-account owner strings across
 * research snapshots. A cluster is a review lead, not proof of shared identity.
 */
export function summarizeCrossTokenClusters(rows = [], minTokens = 2) {
  const groups = new Map();
  const add = (kind, address, token) => {
    if (typeof address !== 'string' || address.length < 20 || typeof token !== 'string' || !token) return;
    const key = kind + ':' + address;
    if (!groups.has(key)) groups.set(key, { signalType: kind, address, tokens: new Set(), observations: 0 });
    const group = groups.get(key);
    group.tokens.add(token);
    group.observations++;
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const token = row?.token;
    const signals = row?.creatorSignals || {};
    add('mint-authority', signals.mintAuthority, token);
    add('freeze-authority', signals.freezeAuthority, token);
    for (const owner of Array.isArray(signals.holderOwnerAddresses) ? signals.holderOwnerAddresses : []) {
      add('holder-owner', owner, token);
    }
  }
  return [...groups.values()]
    .filter(group => group.tokens.size >= Math.max(2, Number(minTokens) || 2))
    .map(group => ({
      signalType: group.signalType,
      address: group.address,
      tokenCount: group.tokens.size,
      observationCount: group.observations,
      tokens: [...group.tokens]
    }))
    .sort((a, b) => b.tokenCount - a.tokenCount || a.signalType.localeCompare(b.signalType));
}


/**
 * Explain the bot's cheap discovery gates before expensive security RPC calls.
 * Missing metrics are explicitly flagged instead of silently treated as safe.
 */
/**
 * Engine 5: measures only the observable public-profile footprint.
 * It does NOT claim sentiment, real followers, community quality, or virality.
 */
export function analyzeNarrativeFootprint(pair = {}) {
  const info = pair.info || {};
  const websites = Array.isArray(info.websites) ? info.websites : [];
  const socials = Array.isArray(info.socials) ? info.socials : [];
  const normalize = value => {
    try {
      const u = new URL(String(value));
      return { host: u.hostname.toLowerCase().replace(/^www\\./, ''), url: u.toString() };
    } catch { return null; }
  };
  const websiteHosts = [...new Set(websites.map(x => normalize(x?.url || x)).filter(Boolean).map(x => x.host))];
  const socialRows = socials.map(x => {
    const parsed = normalize(x?.url || x);
    return parsed ? { type: String(x?.type || 'unknown').toLowerCase(), host: parsed.host } : null;
  }).filter(Boolean);
  const socialHosts = [...new Set(socialRows.map(x => x.host))];
  const recognized = new Set(['x.com','twitter.com','t.me','telegram.me','discord.gg','discord.com','reddit.com','youtube.com','youtu.be','instagram.com','medium.com','warpcast.com']);
  const recognizedSocials = [...new Set(socialHosts.filter(host => recognized.has(host) || [...recognized].some(d => host.endsWith('.' + d))))];
  const name = String(pair.baseToken?.name || '').trim();
  const symbol = String(pair.baseToken?.symbol || '').trim();
  const hasWebsite = websiteHosts.length > 0;
  const hasSocial = socialHosts.length > 0;
  const score = Math.min(100, (hasWebsite ? 25 : 0) + Math.min(60, recognizedSocials.length * 20) + (name.length >= 3 ? 5 : 0) + (symbol.length >= 2 ? 5 : 0) + (websiteHosts.length > 1 ? 5 : 0));
  const flags = [];
  if (!hasWebsite) flags.push('No website listed in pair metadata');
  if (!hasSocial) flags.push('No social links listed in pair metadata');
  if (hasSocial && recognizedSocials.length === 0) flags.push('Social links use unrecognized domains; manual review suggested');
  return {
    score, tier: score >= 70 ? 'BROAD_FOOTPRINT' : score >= 35 ? 'SOME_FOOTPRINT' : 'THIN_FOOTPRINT',
    websiteHosts, socialHosts, recognizedSocialHosts: recognizedSocials,
    websiteCount: websiteHosts.length, socialLinkCount: socialRows.length,
    dataSource: 'DexScreener pair metadata', sentimentAnalyzed: false,
    engagementVerified: false, flags
  };
}

/**
 * Engine 6: descriptive learning from completed paper trades only.
 * No parameter changes are made. A minimum sample threshold prevents tiny
 * samples from being presented as a reliable strategy conclusion.
 */
export function summarizePaperLearning(closedTrades = [], minSamples = 20) {
  const valid = closedTrades.filter(t => Number.isFinite(Number(t.netPnlUsd)) && Number.isFinite(Number(t.netPnlPct)));
  const n = valid.length;
  const wins = valid.filter(t => Number(t.netPnlUsd) > 0).length;
  const losses = valid.filter(t => Number(t.netPnlUsd) < 0).length;
  const totalPnlUsd = valid.reduce((sum, t) => sum + Number(t.netPnlUsd), 0);
  const avgPnlPct = n ? valid.reduce((sum, t) => sum + Number(t.netPnlPct), 0) / n : null;
  const sorted = [...valid].sort((a, b) => Number(a.exitTime || 0) - Number(b.exitTime || 0));
  let equity = 1, peak = 1, maxDrawdownPct = 0;
  for (const trade of sorted) {
    equity *= Math.max(0, 1 + Number(trade.netPnlPct) / 100);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
  }
  return {
    sampleSize: n, wins, losses, breakeven: n - wins - losses,
    winRatePct: n ? wins / n * 100 : null, totalPnlUsd,
    averagePnlPct: avgPnlPct, maxDrawdownPct,
    evidence: n >= minSamples ? 'SAMPLE_AVAILABLE' : 'INSUFFICIENT_SAMPLE',
    minSamplesRequired: minSamples,
    autoTuningEnabled: false,
    note: n >= minSamples ? 'Descriptive paper-trade history; not proof of future performance.' : 'Collect more completed paper trades before drawing strategy conclusions.'
  };
}

/**
 * Fail-closed Solana authority/holder hard blockers.
 * Caller supplies only observed RPC-derived fields; unknown values are rejected.
 */
export function evaluateSolanaHardSecurityGates({ mintAuthority = null, freezeAuthority = null, holderDistribution = null, creatorSignals = null, tokenProgramId = null, tokenExtensions = null } = {}) {
  const reasons = [];
  const SPL_TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN_2022_PROGRAM='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  if(!tokenProgramId||![SPL_TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(tokenProgramId))reasons.push('token program unknown or unsupported');
  if(tokenProgramId===TOKEN_2022_PROGRAM){
    if(!Array.isArray(tokenExtensions))reasons.push('Token-2022 extensions unknown');
    else if(tokenExtensions.some(x=>/transfer.?hook|permanent.?delegate|confidential/i.test(String(x))))reasons.push('unsupported Token-2022 hook/privileged extension');
  }
  if (mintAuthority) reasons.push('active mint authority');
  if (freezeAuthority) reasons.push('active freeze authority');
  if (holderDistribution?.known !== true) reasons.push('holder concentration unknown');
  if (creatorSignals?.known !== true) reasons.push('creator signals unknown');
  else {
    if (Number(holderDistribution.top10Pct) > 30) reasons.push('top-10 concentration exceeds 30%');
    if (Number(holderDistribution.top5Pct) > 20) reasons.push('top-5 concentration exceeds 20%');
  }
  if ((creatorSignals?.authorityHolderOverlap || []).length) reasons.push('authority/holder overlap');
  if (Number(creatorSignals?.reusedMintAuthorityTokens || 0) > 0) reasons.push('mint authority reused on prior recorded token');
  return { pass: reasons.length === 0, reasons };
}

export function evaluateDiscoveryPrefilter(pair, config = {}) {
  const minLiquidity = Number(config.MIN_LIQUIDITY_USD ?? 75000);
  const maxTradeToLiquidity = Number(config.MAX_TRADE_TO_LIQ_PCT ?? 2);
  const minLiqFdv = Number(config.MIN_LIQ_FDV_PCT ?? 8);
  const minSells = Number(config.MIN_SELLS_1H ?? 10);
  const minVolume = Number(config.MIN_VOLUME_24H ?? 50000);
  const minBuyRatio = Number(config.MIN_BUY_RATIO_PCT ?? 52);
  const minBuyRatio1h = Number(config.MIN_BUY_RATIO_1H_PCT ?? 52);
  const minBuyRatio5m = Number(config.MIN_BUY_RATIO_5M_PCT ?? 55);
  const minPairAgeMinutes = Number(config.MIN_PAIR_AGE_MINUTES ?? 15);
  const maxChange5mPct = Number(config.MAX_CHANGE_5M_PCT ?? 30);
  const maxChange1hPct = Number(config.MAX_CHANGE_1H_PCT ?? 150);
  const liquidity = Number(pair?.liquidity?.usd || 0);
  const fdv = Number(pair?.fdv || pair?.marketCap || 0);
  const tradeSize = Number(config.TRADE_SIZE_USD ?? 100);
  const volume = Number(pair?.volume?.h24 || 0);
  const sells1h = Number(pair?.txns?.h1?.sells || 0);
  const buys5m = Number(pair?.txns?.m5?.buys || 0);
  const sells5m = Number(pair?.txns?.m5?.sells || 0);
  const buys1h = Number(pair?.txns?.h1?.buys || 0);
  const sells1hTotal = Number(pair?.txns?.h1?.sells || 0);
  const buyRatio1h = buys1h + sells1hTotal > 0 ? buys1h / (buys1h + sells1hTotal) * 100 : null;
  const buys24 = Number(pair?.txns?.h24?.buys || 0);
  const sells24 = Number(pair?.txns?.h24?.sells || 0);
  const buyRatio = buys24 + sells24 > 0 ? buys24 / (buys24 + sells24) * 100 : null;
  const buyRatio5m = buys5m + sells5m > 0 ? buys5m / (buys5m + sells5m) * 100 : null;
  const change5m = Number(pair?.priceChange?.m5);
  const change1h = Number(pair?.priceChange?.h1);
  const pairAgeMinutes = Number(pair?.pairCreatedAt) > 0 ? (Date.now() - Number(pair.pairCreatedAt)) / 60000 : null;
  const liqFdv = fdv > 0 ? liquidity / fdv * 100 : null;
  const tradeToLiq = liquidity > 0 ? tradeSize / liquidity * 100 : null;
  const reasons = [];
  if (!liquidity) reasons.push('liquidity unavailable');
  else if (liquidity < minLiquidity) reasons.push('liquidity below minimum');
  if (tradeToLiq === null) reasons.push('trade-to-liquidity unavailable');
  else if (tradeToLiq > maxTradeToLiquidity) reasons.push('paper trade size too large for liquidity');
  if (liqFdv === null) reasons.push('liquidity/FDV unavailable');
  else if (liqFdv < minLiqFdv) reasons.push('liquidity/FDV below minimum');
  if (sells1h < minSells) reasons.push('1h sells below minimum');
  if (volume < minVolume) reasons.push('24h volume below minimum');
  if (buyRatio === null) reasons.push('24h buy ratio unavailable');
  else if (buyRatio < minBuyRatio) reasons.push('24h buy ratio below minimum');
  if (buyRatio1h === null) reasons.push('1h buy ratio unavailable');
  else if (buyRatio1h < minBuyRatio1h) reasons.push('1h buy ratio below minimum');
  if (buyRatio5m === null) reasons.push('5m buy ratio unavailable');
  else if (buyRatio5m < minBuyRatio5m) reasons.push('5m buy ratio below minimum');
  if (pairAgeMinutes === null) reasons.push('pair age unavailable');
  else if (pairAgeMinutes < minPairAgeMinutes) reasons.push('pair age below minimum');
  if (!Number.isFinite(change5m)) reasons.push('5m price change unavailable');
  else if (change5m > maxChange5mPct) reasons.push('5m price spike exceeds maximum');
  if (!Number.isFinite(change1h)) reasons.push('1h price change unavailable');
  else if (change1h > maxChange1hPct) reasons.push('1h price spike exceeds maximum');
  const previousLiquidity = Number(config.PREVIOUS_LIQUIDITY_USD);
  if (config.REQUIRE_LIQUIDITY_STABILITY === true) {
    if (!(previousLiquidity > 0)) reasons.push('previous liquidity unavailable');
    else if (liquidity < previousLiquidity * 0.95) reasons.push('liquidity fell more than 5% from previous observation');
  }
  return {
    pass: reasons.length === 0,
    reasons,
    metrics: { liquidityUsd: liquidity, fdvUsd: fdv || null, volume24hUsd: volume, sells1h, buyRatioPct: buyRatio, buyRatio1hPct: buyRatio1h, buyRatio5mPct: buyRatio5m, change5m, change1h, pairAgeMinutes, previousLiquidityUsd: previousLiquidity > 0 ? previousLiquidity : null, liquidityFdvPct: liqFdv, tradeToLiquidityPct: tradeToLiq }
  };
}
