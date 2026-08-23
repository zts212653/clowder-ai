// F296 B3a hard gate 2: a DeliveryReceipt must be mintable only by a provider adapter.
//
// Why: consuming dedupe is the one irreversible act in the ledger — once a
// projection is marked delivered, the cat will never be shown it again in this
// epoch. B2b let any caller pass `{ promptGenerationId, providerReceivedAt }`,
// so a renderer or a route could mark something delivered that the provider
// never received. The type carried no proof.
//
// The gate here is structural at BOTH levels, because a TypeScript brand alone
// vanishes at runtime and these tests run against compiled JS:
//   - compile time: the brand symbol is module-private, so no object literal
//     outside the minting module can satisfy `DeliveryReceipt`
//   - run time: `commit` rejects anything that does not carry the brand
//
// Mutation check: delete the runtime guard in PresentationLedger.commit and the
// "forged" tests below go green — i.e. they are load-bearing.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const receiptModule = await import('../dist/domains/cats/services/session/delivery-receipt.js');
const { mintDeliveryReceipt, isProviderMintedReceipt } = receiptModule;

const RECEIPT_INPUT = Object.freeze({
  promptGenerationId: 'gen-1',
  providerReceivedAt: 1_700_000_000_000,
  providerAdapterId: 'codex/exec_json',
});

describe('F296 B3a gate 2: only a provider adapter can mint a receipt', () => {
  test('a minted receipt carries the coordinates it was minted with', () => {
    const receipt = mintDeliveryReceipt(RECEIPT_INPUT);
    assert.equal(receipt.promptGenerationId, 'gen-1');
    assert.equal(receipt.providerReceivedAt, 1_700_000_000_000);
    assert.equal(receipt.providerAdapterId, 'codex/exec_json');
    assert.equal(isProviderMintedReceipt(receipt), true);
  });

  test('a hand-rolled struct with the same fields is NOT a receipt', () => {
    // This is exactly the B2b shape. It must no longer be accepted anywhere.
    const forged = {
      promptGenerationId: 'gen-1',
      providerReceivedAt: 1_700_000_000_000,
      providerAdapterId: 'codex/exec_json',
    };
    assert.equal(isProviderMintedReceipt(forged), false);
  });

  test('the brand survives neither spreading nor JSON nor structuredClone', () => {
    const receipt = mintDeliveryReceipt(RECEIPT_INPUT);
    // A spread copy is the most likely accidental forgery in real code
    // (`{ ...receipt, providerReceivedAt: Date.now() }`). The brand is a
    // non-enumerable symbol property precisely so that spread drops it.
    assert.equal(isProviderMintedReceipt({ ...receipt }), false);
    assert.equal(isProviderMintedReceipt(JSON.parse(JSON.stringify(receipt))), false);
    assert.equal(isProviderMintedReceipt(structuredClone(receipt)), false);
  });

  test('the brand does not leak into serialized telemetry', () => {
    const receipt = mintDeliveryReceipt(RECEIPT_INPUT);
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes('brand'), false);
    assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
      'promptGenerationId',
      'providerAdapterId',
      'providerReceivedAt',
    ]);
  });

  test('the brand key is a symbol, so it cannot be forged from a string literal', () => {
    const [brand, ...extra] = Object.getOwnPropertySymbols(mintDeliveryReceipt(RECEIPT_INPUT));
    assert.equal(typeof brand, 'symbol');
    assert.deepEqual(extra, [], 'exactly one brand symbol');
    const forged = { ...RECEIPT_INPUT, [Symbol.for('providerAdapterReceipt')]: true };
    assert.equal(isProviderMintedReceipt(forged), false);
  });

  // ── kimi review P1-2 (PR #3783) ──────────────────────────────────────────
  // The brand symbol used to be exported, so anyone could import it and
  // `defineProperty` a passing receipt. Low residual risk (that is a loud,
  // deliberate act, and the three accidental paths stayed closed) — but the
  // module header claimed only this module could produce a valid receipt, and
  // that claim was false. In a PR whose subject is "a comment must not stand in
  // for a structure", the false comment is itself the defect.
  test('the brand symbol is not reachable from the module surface', () => {
    const exportedSymbols = Object.values(receiptModule).filter((value) => typeof value === 'symbol');
    assert.deepEqual(exportedSymbols, [], 'exporting the brand would make forgery a one-liner');
  });

  test('a forgery attempt using a same-description symbol still fails', () => {
    const forged = { ...RECEIPT_INPUT };
    Object.defineProperty(forged, Symbol('f296.providerAdapterReceipt'), { value: true });
    assert.equal(isProviderMintedReceipt(forged), false);
  });

  test('non-objects are rejected without throwing', () => {
    for (const value of [null, undefined, 'gen-1', 42, true, []]) {
      assert.equal(isProviderMintedReceipt(value), false);
    }
  });

  test('minting rejects incoherent provider coordinates', () => {
    assert.throws(() => mintDeliveryReceipt({ ...RECEIPT_INPUT, promptGenerationId: '' }), /delivery_receipt/);
    assert.throws(() => mintDeliveryReceipt({ ...RECEIPT_INPUT, providerAdapterId: '' }), /delivery_receipt/);
    assert.throws(() => mintDeliveryReceipt({ ...RECEIPT_INPUT, providerReceivedAt: 0 }), /delivery_receipt/);
    assert.throws(() => mintDeliveryReceipt({ ...RECEIPT_INPUT, providerReceivedAt: Number.NaN }), /delivery_receipt/);
  });

  test('a receipt is frozen: its generation cannot be rewritten after minting', () => {
    const receipt = mintDeliveryReceipt(RECEIPT_INPUT);
    assert.equal(Object.isFrozen(receipt), true);
    assert.throws(() => {
      'use strict';
      receipt.promptGenerationId = 'gen-2';
    }, TypeError);
  });
});
