/**
 * D2-A Phase 1 — Admission Guard + Bounded Output Tests
 *
 * Phase 1 covers: timestamp admission guard and bounded output.
 * These are independently safe — they do not interact with sequence state.
 *
 * Verified in this suite (Phase 1):
 *  Admission: non-negative integer ECMAScript Date values only.
 *  INV-1 (pre-overflow domain): Same-score ordering within a single
 *    uninterrupted process while sequence stays within 6-digit padStart
 *    range (0..999999). At 1000000+ the pre-existing padStart(6) produces
 *    7+ digits, breaking lexicographic order — this is a known E2 defect
 *    deferred to Phase 2.
 *  INV-2: Expired-cursor fallback (memory store only, sample domain).
 *  INV-3: Output length ≤ 128.
 *
 * DEFERRED to Phase 2 (sequence state model not yet designed):
 *  INV-4 (sequence exhaustion): Requires per-timestamp state; mechanism
 *    choice (map, counter, encoding change, etc.) is open.
 *  INV-4 (restart/concurrency): Process restart at the same millisecond
 *    can produce IDs that collide on timestamp+sequence.
 *  INV-5 (Memory/Redis parity): No Redis store is instantiated in this suite.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let freshModuleId = 0;

/** Load an isolated module instance so restart tests do not expose a production reset hook. */
function loadFreshMessageStoreModule() {
  return import(`../dist/domains/cats/services/stores/ports/MessageStore.js?d2=${freshModuleId++}`);
}

// ---------------------------------------------------------------------------
// §1  generateSortableId — admission guard + ordering
// ---------------------------------------------------------------------------

describe('D2 — generateSortableId order invariants', () => {
  let generateSortableId;

  beforeEach(async () => {
    const mod = await loadFreshMessageStoreModule();
    generateSortableId = mod.generateSortableId;
  });

  test('INV-1a: sequential IDs at same timestamp sort in insertion order', () => {
    const ts = 1721433600000;
    const ids = Array.from({ length: 100 }, () => generateSortableId(ts));
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] > ids[i - 1], `id[${i}] (${ids[i]}) must sort after id[${i - 1}] (${ids[i - 1]})`);
    }
  });

  test('INV-1b: IDs at increasing timestamps sort chronologically', () => {
    const timestamps = [0, 1000, 2000, 3000, 100000, 1721433600000];
    const ids = timestamps.map((ts) => generateSortableId(ts));
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] > ids[i - 1], `id at ts=${timestamps[i]} must sort after id at ts=${timestamps[i - 1]}`);
    }
  });

  // -- Admission guard (these were RED before D2 fix) --

  test('Admission: out-of-Date-range timestamp throws', () => {
    const tooLarge = 8_640_000_000_000_001; // just past Date boundary
    assert.throws(
      () => generateSortableId(tooLarge),
      /valid.*Date|timestamp|range/i,
      'must reject timestamp beyond Date range',
    );
  });

  test('Admission: NaN timestamp throws', () => {
    assert.throws(() => generateSortableId(Number.NaN), /valid.*Date|timestamp|range|finite/i, 'must reject NaN');
  });

  test('Admission: Infinity timestamp throws', () => {
    assert.throws(
      () => generateSortableId(Number.POSITIVE_INFINITY),
      /valid.*Date|timestamp|range|finite/i,
      'must reject +Infinity',
    );
    assert.throws(
      () => generateSortableId(Number.NEGATIVE_INFINITY),
      /valid.*Date|timestamp|range|finite/i,
      'must reject -Infinity',
    );
  });

  test('Admission: negative timestamp throws', () => {
    assert.throws(
      () => generateSortableId(-1),
      /non-negative integer/i,
      'must reject negative timestamps before generating an ID',
    );
  });

  test('Admission: fractional timestamp throws', () => {
    assert.throws(
      () => generateSortableId(1.5),
      /non-negative integer/i,
      'must reject fractional timestamps before generating an ID',
    );
  });

  test('Admission: rejection does not consume sequence state', () => {
    const first = generateSortableId(1000);
    assert.throws(() => generateSortableId(Number.NaN), /timestamp/i);
    const second = generateSortableId(1000);

    assert.equal(first.split('-')[1], '000000');
    assert.equal(second.split('-')[1], '000001');
  });

  // -- INV-3: bounded output --

  test('INV-3: all generated IDs are ≤ 128 characters', () => {
    const timestamps = [0, 1, 1721433600000, 8_640_000_000_000_000];
    for (const ts of timestamps) {
      const id = generateSortableId(ts);
      assert.ok(id.length <= 128, `ID length ${id.length} exceeds 128 for ts=${ts}: ${id}`);
    }
  });

  test('INV-3: max-width timestamp produces ID within bound', () => {
    const id = generateSortableId(8_640_000_000_000_000);
    // 16 digits + '-' + 6 digits + '-' + 8 chars = 32
    assert.ok(id.length <= 128, `ID length ${id.length} for max timestamp`);
    assert.ok(id.length <= 40, `ID format should be ~32 chars, got ${id.length}`);
  });
});

// ---------------------------------------------------------------------------
// §2  Memory store cursor correctness
// ---------------------------------------------------------------------------

describe('D2 — Memory store cursor order', () => {
  let MessageStore;

  beforeEach(async () => {
    const mod = await loadFreshMessageStoreModule();
    MessageStore = mod.MessageStore;
  });

  /**
   * Helper: append N messages to a store at the same timestamp.
   * Returns the stored messages in insertion order.
   */
  function appendN(store, n, { timestamp = 1000, threadId = 'thread-1' } = {}) {
    const msgs = [];
    for (let i = 0; i < n; i++) {
      msgs.push(
        store.append({
          userId: 'user-1',
          catId: null,
          content: `msg-${i}`,
          mentions: [],
          timestamp,
          threadId,
        }),
      );
    }
    return msgs;
  }

  test('INV-1: getBefore same-timestamp tiebreaker returns correct set', () => {
    const store = new MessageStore();
    const msgs = appendN(store, 5, { timestamp: 1000 });

    // Cursor at msg[3] — should return msg[0..2]
    const result = store.getBefore(1000, 50, undefined, msgs[3].id);
    const resultIds = result.map((m) => m.id);

    assert.ok(resultIds.includes(msgs[0].id), 'must include msg[0]');
    assert.ok(resultIds.includes(msgs[1].id), 'must include msg[1]');
    assert.ok(resultIds.includes(msgs[2].id), 'must include msg[2]');
    assert.ok(!resultIds.includes(msgs[3].id), 'must exclude cursor msg[3]');
    assert.ok(!resultIds.includes(msgs[4].id), 'must exclude msg[4] (after cursor)');
  });

  test('INV-1: getByThreadAfter returns only messages after cursor', () => {
    const store = new MessageStore();
    const msgs = appendN(store, 5, { timestamp: 1000 });

    const afterId = msgs[2].id;
    const result = store.getByThreadAfter('thread-1', afterId);
    const resultIds = result.map((m) => m.id);

    assert.ok(!resultIds.includes(msgs[0].id), 'must not include msg[0]');
    assert.ok(!resultIds.includes(msgs[1].id), 'must not include msg[1]');
    assert.ok(!resultIds.includes(msgs[2].id), 'must not include cursor msg[2]');
    assert.ok(resultIds.includes(msgs[3].id), 'must include msg[3]');
    assert.ok(resultIds.includes(msgs[4].id), 'must include msg[4]');
  });

  test('INV-2: getByThreadAfter fallback with non-existent cursor', () => {
    // Simulates expired cursor: cursor ID doesn't exist in store.
    // Fallback path uses `id > afterId` — must return messages whose IDs
    // lexically sort after the synthetic cursor.
    const store = new MessageStore();
    const msgs = appendN(store, 5, { timestamp: 1000 });

    // Synthetic cursor that sorts between msg[2] and msg[3]:
    // same timestamp + same sequence as msg[2] + suffix 'zzzzzzzz'
    // (any UUID suffix is hex, so 'zzzzzzzz' > any real suffix → sorts
    // after msg[2] but before msg[3] which has a higher sequence digit).
    const parts = msgs[2].id.split('-');
    const syntheticCursor = `${parts[0]}-${parts[1]}-zzzzzzzz`;

    // This cursor doesn't exist → triggers fallback
    const result = store.getByThreadAfter('thread-1', syntheticCursor);
    const resultIds = result.map((m) => m.id);

    // All messages with id > syntheticCursor should be returned
    // syntheticCursor has seq between msg[2] and msg[3], so msg[3..4] should appear
    assert.ok(resultIds.includes(msgs[3].id), 'must include msg[3] (after synthetic cursor)');
    assert.ok(resultIds.includes(msgs[4].id), 'must include msg[4] (after synthetic cursor)');
    assert.ok(!resultIds.includes(msgs[0].id), 'must not include msg[0]');
    assert.ok(!resultIds.includes(msgs[1].id), 'must not include msg[1]');
  });

  test('INV-1: getByThreadBefore same-timestamp correctness', () => {
    const store = new MessageStore();
    const msgs = appendN(store, 5, { timestamp: 1000 });

    // Cursor at msg[3] — should return msg[0..2]
    const result = store.getByThreadBefore('thread-1', 1000, 50, msgs[3].id);
    const resultIds = result.map((m) => m.id);

    assert.equal(resultIds.length, 3, 'should return exactly 3 messages');
    assert.ok(resultIds.includes(msgs[0].id));
    assert.ok(resultIds.includes(msgs[1].id));
    assert.ok(resultIds.includes(msgs[2].id));
  });
});

// ---------------------------------------------------------------------------
// §3  Sequence restart safety (ordering, not exhaustion guard)
// ---------------------------------------------------------------------------

describe('D2 — Sequence restart', () => {
  test('after module restart, new IDs at later timestamp sort after previous', async () => {
    // Simulate: process A generates IDs at ts=1000
    const processA = await loadFreshMessageStoreModule();
    const idOld = processA.generateSortableId(1000);

    // Process restart: a fresh module sequence starts at zero, but timestamp advances
    const processB = await loadFreshMessageStoreModule();
    const idNew = processB.generateSortableId(2000);

    assert.ok(idNew > idOld, 'post-restart ID at later timestamp must sort after pre-restart ID');
  });

  test('UUID suffix ensures uniqueness when timestamp+sequence collide (not ordering)', async () => {
    // NOTE: This test proves ID *uniqueness* via UUID suffix, NOT cursor ordering.
    // Same-ms restart with sequence reset produces IDs that differ only in UUID —
    // their cursor ordering is undefined (Phase 2 concern: INV-4 restart/concurrency).
    const ts = 1721433600000;
    const processA = await loadFreshMessageStoreModule();
    const id1 = processA.generateSortableId(ts);
    const processB = await loadFreshMessageStoreModule();
    const id2 = processB.generateSortableId(ts);

    // IDs differ due to UUID suffix even if timestamp+sequence match
    assert.notEqual(id1, id2, 'same ts+seq must still produce different IDs (UUID suffix)');
  });
});
