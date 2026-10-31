/**
 * `assertQueueExecution` is a fail-closed gate: an invalid owner auth provenance must stop the row
 * from entering the queue ledger. It was written as
 * `['strict', ...].includes(String(value.ownerAuthProvenance))`, which does not fail closed —
 * `String(['strict'])` is `'strict'`, so a one-element array (and any object whose `toString`
 * returns a literal) is accepted as proven authorization.
 *
 * This is the same defect the review reported against the shared lifecycle guard, at a second site
 * this PR also introduced. Pinning it here so fixing the reported instance alone cannot look done.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { assertQueueLedgerEntry } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerValidation.js'
);

const entry = (provenance) => ({
  version: 2,
  id: 'queue:1',
  threadId: 'thread-1',
  owner: { kind: 'user', userId: 'u1' },
  kind: 'conversation_input',
  status: 'queued',
  priority: 'normal',
  targets: ['cat-1'],
  from: { kind: 'user', userId: 'u1' },
  payload: { sourceRecordId: 'rec-1', content: 'hi' },
  execution: { intent: 'execute', ownerAuthProvenance: provenance, autoExecute: false },
  delivery: {},
  enqueuedAt: 1789000000000,
});

describe('queue ledger owner auth provenance must not be coerced', () => {
  it('accepts each real provenance literal', () => {
    for (const p of ['strict', 'compatibility_fallback', 'unknown']) {
      assert.doesNotThrow(() => assertQueueLedgerEntry(entry(p)));
    }
  });

  it('rejects a one-element array that stringifies to a literal', () => {
    assert.throws(() => assertQueueLedgerEntry(entry(['strict'])), /owner auth provenance is invalid/);
  });

  it('rejects an object whose toString returns a literal', () => {
    assert.throws(
      () => assertQueueLedgerEntry(entry({ toString: () => 'strict' })),
      /owner auth provenance is invalid/,
    );
  });

  it('still rejects a plainly wrong literal', () => {
    assert.throws(() => assertQueueLedgerEntry(entry('forged')), /owner auth provenance is invalid/);
  });
});
