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

test('live adapter rejects builder boolean claims without a compiled readonly account', async () => {
  const adapter = new SolanaLiveExecutionAdapter({
    enabled: true, confirmationKey: 'confirm', signer: { signTransaction: async tx => tx },
    buildJupiterSwap: async () => ({ transaction: { message: { staticAccountKeys: [key('payer')] } }, dynamicSlippageApplied: true, jitodontfrontReadOnly: true }),
    sendViaHeliusSender: async () => 'sig', telegramChatId: 'authorized'
  });
  process.env.LIVE_TRADING = 'true';
  await assert.rejects(adapter.buy({ amountSol: 0.01 }, { chatId: 'authorized' }), /compiled message/);
  delete process.env.LIVE_TRADING;
});
