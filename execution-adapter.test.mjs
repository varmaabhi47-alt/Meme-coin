import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJitodontfrontReadonly, sendViaHeliusSender, SolanaLiveExecutionAdapter } from './execution-adapter.mjs';

const JITO = 'jitodontfront111111111111111111111111111111';
const key = value => ({ toBase58: () => value });

test('compiled transaction must include jitodontfront as readonly', () => {
  const readonlyMessage = {
    staticAccountKeys: [key('payer'), key(JITO), key('swap')],
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 }
  };
  assert.equal(validateJitodontfrontReadonly({ message: readonlyMessage }), true);
  const writableMessage = {
    staticAccountKeys: [key('payer'), key(JITO), key('swap')],
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }
  };
  assert.equal(validateJitodontfrontReadonly({ message: writableMessage }), false);
  assert.equal(validateJitodontfrontReadonly({ message: { staticAccountKeys: [key('payer')] } }), false);
});

test('Sender refuses non-Helius or non-HTTPS endpoints before transmitting signed bytes', async () => {
  let calls = 0;
  await assert.rejects(sendViaHeliusSender('signed', {
    endpoint: 'http://attacker.example/fast',
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ result: 'sig' }) }; }
  }), /verified HTTPS/);
  assert.equal(calls, 0);
});

test('live adapter refuses orders without a real Jupiter V2 request id', async () => {
  const adapter = new SolanaLiveExecutionAdapter({
    enabled: true, confirmationKey: 'confirm', signer: { signTransaction: async tx => tx },
    jupiterSwap: { swap: async () => { throw new Error('incomplete order'); } }, telegramChatId: 'authorized'
  });
  process.env.LIVE_TRADING = 'true';
  await assert.rejects(adapter.buy({ amountSol: 0.01, mint: 'So11111111111111111111111111111111111111112', decimals: 9 }, { chatId: 'authorized' }), /incomplete order/);
  delete process.env.LIVE_TRADING;
});

test('live /kill latches the adapter and awaits its flatten callback', async () => {
  const adapter = new SolanaLiveExecutionAdapter({ enabled: false, confirmationKey: '', telegramChatId: 'authorized' });
  let flattened = 0;
  const result = await adapter.handleTelegramCommand('/kill', 'authorized', { flattenOpenPositions: async () => { flattened++; return { flattened: 2, failed: 1 }; } });
  assert.equal(adapter.killed, true);
  assert.equal(flattened, 1);
  assert.deepEqual(result, { authorized: true, flattened: 2, failed: 1 });
  const denied = await adapter.handleTelegramCommand('/kill', 'other', { flattenOpenPositions: async () => { throw new Error('must not run'); } });
  assert.equal(denied.authorized, false);
});
