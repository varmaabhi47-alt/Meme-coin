import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://api.jup.ag/swap/v2';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function assertHttps(url, allowedHost) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== allowedHost) throw new Error('Unexpected API URL');
  return parsed;
}

async function readJsonResponse(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(label + ' HTTP ' + response.status + ': ' + String(body.error || body.message || response.statusText));
  return body;
}

export function createJupiterV2SwapClient({ apiKey, signer, publicKey, VersionedTransaction, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('JUPITER_API_KEY is required for live swaps');
  if (!signer || typeof signer.signTransaction !== 'function') throw new Error('A local Solana signer is required');
  const taker = String(publicKey || signer.publicKey?.toBase58?.() || '');
  if (!taker) throw new Error('Signer public key is missing');
  if (typeof VersionedTransaction?.deserialize !== 'function') throw new Error('VersionedTransaction codec is required');

  async function getOrder({ inputMint, outputMint, amount }) {
    if (![inputMint, outputMint].every(v => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v))) throw new Error('Invalid swap mint address');
    if (!/^\d+$/.test(String(amount)) || BigInt(amount) <= 0n) throw new Error('Swap amount must be a positive integer in base units');
    const params = new URLSearchParams({ inputMint, outputMint, amount: String(amount), taker, maxSupportedTransactionVersion: '0' });
    const url = assertHttps(BASE + '/order?' + params, 'api.jup.ag');
    const response = await fetchImpl(url, { headers: { 'x-api-key': apiKey } });
    const order = await readJsonResponse(response, 'Jupiter order');
    if (!order.transaction || !order.requestId || !/^\d+$/.test(String(order.outAmount || '')) || BigInt(order.outAmount) <= 0n) {
      throw new Error('Jupiter returned an incomplete order: ' + String(order.errorMessage || 'transaction/requestId/output missing'));
    }
    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    if (!transaction?.message) throw new Error('Jupiter order transaction could not be decoded');
    return { order, transaction, requestId: order.requestId, outAmount: String(order.outAmount), router: String(order.router || 'unknown'), dynamicSlippageApplied: true, landingMode: 'jupiter-v2-managed' };
  }

  async function execute({ signedTransaction, requestId }) {
    if (!requestId || !signedTransaction) throw new Error('Jupiter execute requires signed transaction and order requestId');
    const response = await fetchImpl(BASE + '/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ signedTransaction: Buffer.from(signedTransaction).toString('base64'), requestId })
    });
    const result = await readJsonResponse(response, 'Jupiter execute');
    if (result.status !== 'Success' || !result.signature) throw new Error('Jupiter execute failed: ' + String(result.error || result.status || 'no signature'));
    return { signature: result.signature, outputAmountResult: String(result.outputAmountResult || ''), inputAmountResult: String(result.inputAmountResult || ''), status: result.status, router: result.router || null };
  }

  async function swap({ inputMint, outputMint, amount }) {
    const built = await getOrder({ inputMint, outputMint, amount });
    const signed = await signer.signTransaction(built.transaction);
    const serialized = signed.serialize();
    const result = await execute({ signedTransaction: serialized, requestId: built.requestId });
    return { ...result, outAmount: built.outAmount, requestId: built.requestId, router: built.router, landingMode: built.landingMode };
  }

  return { taker, getOrder, execute, swap, solMint: SOL_MINT, usdcMint: USDC_MINT };
}

export async function loadJupiterLiveClient({ apiKey = process.env.JUPITER_API_KEY, keypairPath = process.env.SOLANA_SIGNER_KEYPAIR_PATH, fetchImpl = fetch } = {}) {
  if (!keypairPath) throw new Error('Set SOLANA_SIGNER_KEYPAIR_PATH to a secret-mounted Solana keypair JSON file');
  if (!apiKey) throw new Error('Set JUPITER_API_KEY (free key) before live trading');
  const absolute = path.resolve(keypairPath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error('Signer path must be a regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Signer keypair file permissions are too open; chmod 600 the secret file');
  const raw = JSON.parse(await fs.readFile(absolute, 'utf8'));
  if (!Array.isArray(raw) || raw.length !== 64 || raw.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('Keypair file must be a 64-byte Solana secret-key JSON array');
  const { Keypair, VersionedTransaction } = await import('@solana/web3.js');
  const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
  const signer = { publicKey: keypair.publicKey, signTransaction: async tx => { tx.sign([keypair]); return tx; } };
  return createJupiterV2SwapClient({ apiKey, signer, publicKey: keypair.publicKey.toBase58(), VersionedTransaction, fetchImpl });
}

export { SOL_MINT, USDC_MINT };
