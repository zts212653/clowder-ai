/**
 * Issue #845 — InvocationRecordStore usageRecordedAt override behavior.
 *
 * Pins the backfill contract: when `update()` receives an explicit
 * `usageRecordedAt`, the store uses it verbatim (so historical records anchor to
 * their original day). Live writers omit the field and get the F128
 * write-once-on-first-usageByCat-write semantics.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');

function newStore() {
  return new InvocationRecordStore({ maxRecords: 100 });
}

function createAndRun(store) {
  // In-memory store is synchronous (Node single-threaded → Map ops atomic).
  const { invocationId } = store.create({
    threadId: 'thread-1',
    userId: 'user-1',
    targetCats: ['opus'],
    intent: 'execute',
    idempotencyKey: `key-${Date.now()}-${Math.random()}`,
  });
  // 'queued' → 'running' is required before writing succeeded usage
  store.update(invocationId, { status: 'running' });
  return invocationId;
}

describe('InvocationRecordStore usageRecordedAt semantics (#845)', () => {
  it('first usageByCat write without override stamps Date.now()', () => {
    const store = newStore();
    const id = createAndRun(store);
    const before = Date.now();
    const updated = store.update(id, {
      status: 'succeeded',
      usageByCat: { opus: { inputTokens: 10, outputTokens: 1 } },
    });
    const after = Date.now();
    assert.ok(updated);
    assert.ok(updated.usageRecordedAt != null);
    assert.ok(
      updated.usageRecordedAt >= before && updated.usageRecordedAt <= after,
      'usageRecordedAt should be stamped to now() on first write',
    );
  });

  it('subsequent usageByCat write without override preserves original timestamp', () => {
    const store = newStore();
    const id = createAndRun(store);
    const first = store.update(id, {
      status: 'succeeded',
      usageByCat: { opus: { inputTokens: 10, outputTokens: 1 } },
    });
    const originalStamp = first.usageRecordedAt;

    // Force a different clock value (sleep without async by busy-waiting is ugly;
    // simpler: rely on the fact that update sets it via Date.now() which advances).
    const second = store.update(id, {
      usageByCat: { opus: { inputTokens: 20, outputTokens: 2 } },
    });
    assert.ok(second);
    assert.equal(second.usageRecordedAt, originalStamp, 'F128 stamp must be stable across re-writes');
  });

  it('explicit usageRecordedAt override is honored (backfill anchor)', () => {
    const store = newStore();
    const id = createAndRun(store);
    const customAnchor = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const updated = store.update(id, {
      status: 'succeeded',
      usageByCat: { opus: { inputTokens: 10, outputTokens: 1 } },
      usageRecordedAt: customAnchor,
    });
    assert.ok(updated);
    assert.equal(updated.usageRecordedAt, customAnchor, 'backfill must anchor to original day');
  });

  it('explicit override on a record that already has usageRecordedAt still overwrites', () => {
    // This is intentional — backfill scripts may need to repair an incorrectly
    // stamped record (e.g. if the original write happened at the wrong wall clock).
    const store = newStore();
    const id = createAndRun(store);
    store.update(id, {
      status: 'succeeded',
      usageByCat: { opus: { inputTokens: 10, outputTokens: 1 } },
    });
    const newAnchor = 1_700_000_000_000;
    const updated = store.update(id, {
      usageByCat: { opus: { inputTokens: 20, outputTokens: 2 } },
      usageRecordedAt: newAnchor,
    });
    assert.equal(updated.usageRecordedAt, newAnchor);
  });

  it('expectedUsageByCatAbsent rejects non-empty existing usageByCat', () => {
    const store = newStore();
    const id = createAndRun(store);
    const originalAnchor = 1_700_000_000_000;
    store.update(id, {
      status: 'succeeded',
      usageByCat: { opus: { inputTokens: 10, outputTokens: 1 } },
      usageRecordedAt: originalAnchor,
    });

    const updated = store.update(id, {
      usageByCat: { codex: { inputTokens: 20, outputTokens: 2 } },
      usageRecordedAt: originalAnchor + 24 * 60 * 60 * 1000,
      expectedUsageByCatAbsent: true,
    });

    assert.equal(updated, null);
    const record = store.get(id);
    assert.deepEqual(record.usageByCat, { opus: { inputTokens: 10, outputTokens: 1 } });
    assert.equal(record.usageRecordedAt, originalAnchor);
  });

  it('expectedUsageByCatAbsent allows empty existing usageByCat', () => {
    const store = newStore();
    const id = createAndRun(store);
    store.update(id, {
      status: 'succeeded',
      usageByCat: {},
      usageRecordedAt: 1_700_000_000_000,
    });

    const updated = store.update(id, {
      usageByCat: { opus: { inputTokens: 20, outputTokens: 2 } },
      usageRecordedAt: 1_700_000_001_000,
      expectedUsageByCatAbsent: true,
    });

    assert.ok(updated);
    assert.deepEqual(updated.usageByCat, { opus: { inputTokens: 20, outputTokens: 2 } });
    assert.equal(updated.usageRecordedAt, 1_700_000_001_000);
  });
});
