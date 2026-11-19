#!/usr/bin/env node
/**
 * MEME.RADAR V5 live API smoke checks.
 * Read-only only: GET market/security/quote APIs and Solana getHealth.
 * No wallet, taker, transaction signing, transaction submission, or trading.
 */
import assert from 'node:assert/strict';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - started, detail });
  } catch (error) {
    results.push({ name, status: 'FAIL', ms: Date.now() - started, detail: error.message });
  }
}

async function getJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json();
}

await check('DexScreener latest token profiles', async () => {
  const data = await getJson('https://api.dexscreener.com/token-profiles/latest/v1');
  assert.ok(Array.isArray(data), 'Expected a JSON array');
  assert.ok(data.length > 0, 'No token profiles returned');
  const valid = data.filter(x => x && typeof x.chainId === 'string' && typeof x.tokenAddress === 'string');
  assert.ok(valid.length > 0, 'No usable chainId/tokenAddress entries');
  return `${valid.length} usable profiles in response`;
});

await check('GoPlus supported-chain directory', async () => {
  const data = await getJson('https://api.gopluslabs.io/api/v1/supported_chains');
  assert.equal(Number(data.code), 1, data.message || 'GoPlus did not return success code');
  const ids = new Set((data.result || []).map(x => String(x.id)));
  assert.ok(ids.has('1') && ids.has('8453'), 'Ethereum/Base missing from supported chain list');
  return `${ids.size} supported chains listed`;
});

await check('GoPlus Ethereum token-security lookup', async () => {
  const url = `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${ETH_USDC}`;
  const data = await getJson(url);
  assert.equal(Number(data.code), 1, data.message || 'GoPlus token lookup failed');
  assert.ok(data.result && data.result[ETH_USDC], 'No token-security record for reference contract');
  return 'Reference Ethereum USDC security record returned (not a safety endorsement)';
});

await check('RugCheck Solana report-summary lookup', async () => {
  const data = await getJson(`https://api.rugcheck.xyz/v1/tokens/${SOL_MINT}/report/summary`);
  assert.ok(data && typeof data === 'object' && !Array.isArray(data), 'Expected report-summary JSON object');
  assert.ok('score' in data || 'score_normalised' in data || 'risks' in data, 'Response shape missing expected report fields');
  return 'Wrapped-SOL report-summary response shape valid';
});

await check('Solana mainnet RPC getHealth', async () => {
  const data = await getJson('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' })
  });
  assert.equal(data.result, 'ok', data.error?.message || 'RPC node did not report healthy');
  return 'RPC reports healthy';
});

await check('Jupiter Swap API v2 quote-only order', async () => {
  // No taker is supplied. Per Jupiter docs, this requests a quote only.
  const params = new URLSearchParams({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: '1000000' });
  const data = await getJson(`https://api.jup.ag/swap/v2/order?${params}`);
  assert.ok(/^\d+$/.test(String(data.outAmount || '')), 'Missing numeric outAmount');
  assert.ok(data.router, 'Missing route/router label');
  assert.equal(data.transaction ?? null, null, 'Unexpected transaction in quote-only response');
  return `Quote returned via ${data.router}; no transaction supplied`;
});

for (const item of results) {
  console.log(`${item.status.padEnd(4)} | ${item.name} | ${item.ms}ms | ${item.detail}`);
}
const failed = results.filter(x => x.status === 'FAIL').length;
console.log(`\nLive read-only checks: ${results.length - failed}/${results.length} passed.`);
if (failed) process.exitCode = 1;
