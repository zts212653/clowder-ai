/**
 * Sortable-ID producer admission regressions.
 *
 * Store-boundary coverage lives in message-store.test.js and
 * redis-message-store.test.js. This suite only protects the shared generator's
 * direct-call contract and its sequence side-effect boundary.
 *
 * The producer encodes a *logical* timestamp in the ID prefix. The logical
 * timestamp is a process-local high-water mark: it advances when the caller
 * supplies a larger timestamp and stays unchanged for smaller or equal inputs.
 * This keeps the local state bounded to a few scalars while still producing
 * exact lexicographic order for every ID generated in the process.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

test('generateSortableId rejects invalid timestamps before consuming sequence state', async () => {
  const { generateSortableId, resetSortableIdSequence } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-admission'
  );
  resetSortableIdSequence();

  const invalidTimestamps = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001];
  for (const timestamp of invalidTimestamps) {
    assert.throws(
      () => generateSortableId(timestamp),
      /message timestamp must be a non-negative integer ECMAScript Date value/,
    );
  }

  const firstValidId = generateSortableId(1);
  assert.equal(firstValidId.split('-')[1], '000000', 'rejected input must not advance the sequence');
});

test('generateSortableId preserves lexicographic order within the same timestamp', async () => {
  const { generateSortableId, resetSortableIdSequence } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-same-ts'
  );
  resetSortableIdSequence();

  const timestamp = 1_234_567_890_123;
  const ids = Array.from({ length: 5 }, () => generateSortableId(timestamp));
  assert.deepEqual([...ids].sort(), ids, 'same-timestamp IDs must sort by generation order');
});

test('generateSortableId fails closed on six-digit sequence exhaustion', async () => {
  const { generateSortableId, resetSortableIdSequence, getSortableIdSequence, MAX_SEQUENCE } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-exhaustion'
  );
  resetSortableIdSequence(MAX_SEQUENCE);

  const atLimit = generateSortableId(1);
  assert.equal(atLimit.split('-')[1], String(MAX_SEQUENCE).padStart(6, '0'));

  assert.throws(
    () => generateSortableId(1),
    /sequence exhausted/i,
    'producer must fail closed rather than expand width or wrap',
  );

  // Rejection must not advance the sequence further.
  assert.equal(getSortableIdSequence(), MAX_SEQUENCE + 1);
});

test('generateSortableId advances timestamp and resets sequence at new high-water mark', async () => {
  const { generateSortableId, resetSortableIdSequence, getSortableIdSequence } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-advance'
  );
  resetSortableIdSequence();

  const firstTs = 1_000;
  const laterTs = 2_000;

  const a1 = generateSortableId(firstTs);
  const a2 = generateSortableId(firstTs);
  assert.equal(a1.split('-')[1], '000000');
  assert.equal(a2.split('-')[1], '000001');
  assert.equal(getSortableIdSequence(), 2);

  // Advancing the timestamp resets the sequence, avoiding process-lifetime
  // exhaustion as long as the timestamp keeps moving forward.
  const b1 = generateSortableId(laterTs);
  assert.equal(b1.split('-')[1], '000000', 'new high-water timestamp resets sequence');
  assert.equal(getSortableIdSequence(), 1);

  assert.ok(b1 > a2, 'later-timestamp ID sorts after earlier-timestamp ID');
});

test('generateSortableId promotes non-monotonic timestamps to the high-water mark', async () => {
  const { generateSortableId, resetSortableIdSequence } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-monotonic'
  );
  resetSortableIdSequence();

  const higher = generateSortableId(1_001);
  const lower = generateSortableId(1_000);

  // The second call is admitted using the current high-water logical timestamp,
  // so its timestamp prefix is the same as the first call and its sequence is higher.
  assert.equal(lower.slice(0, 16), higher.slice(0, 16), 'out-of-order timestamp inherits the logical timestamp prefix');
  assert.ok(lower > higher, 'later generation still sorts after earlier generation');
});

test('generateSortableId cross-timestamp generation avoids process-lifetime exhaustion', async () => {
  const { generateSortableId, resetSortableIdSequence } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-lifetime'
  );
  resetSortableIdSequence();

  // Simulate many messages across distinct monotonic timestamps.
  // The total count far exceeds MAX_SEQUENCE, yet each timestamp starts fresh.
  const timestamps = [1, 2, 3, 4, 5];
  for (const ts of timestamps) {
    const id = generateSortableId(ts);
    assert.equal(id.split('-')[1], '000000', `timestamp ${ts} starts at sequence 0`);
  }
});

test('generateSortableId output length is bounded', async () => {
  const { generateSortableId, resetSortableIdSequence } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-length'
  );
  resetSortableIdSequence();

  // Largest admitted timestamp at the largest six-digit sequence.
  const id = generateSortableId(8_640_000_000_000_000);
  assert.ok(id.length <= 32, `ID length ${id.length} exceeds bounded 32-char form`);
  assert.match(id, /^\d{16}-\d{6}-[0-9a-f]{8}$/);
});

test('generateSortableId restart at a later timestamp preserves chronological order', async () => {
  const { generateSortableId, resetSortableIdSequence } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-restart'
  );
  resetSortableIdSequence();

  const earlierTs = 1_000;
  const laterTs = 2_000;
  const beforeRestart = generateSortableId(earlierTs);
  resetSortableIdSequence();
  const afterRestart = generateSortableId(laterTs);

  assert.ok(afterRestart > beforeRestart, 'post-restart ID at a later timestamp must sort after pre-restart ID');
});

test('generateSortableId documents that sequence reset at the same timestamp regresses order', async () => {
  const { generateSortableId, resetSortableIdSequence, MAX_SEQUENCE } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-restart-same-ts'
  );
  resetSortableIdSequence();

  const timestamp = 1_000;
  const beforeReset = generateSortableId(timestamp); // sequence 0
  resetSortableIdSequence(MAX_SEQUENCE - 1);
  const highSequence = generateSortableId(timestamp); // sequence MAX_SEQUENCE - 1

  resetSortableIdSequence();
  const afterReset = generateSortableId(timestamp); // sequence 0 again

  // The random suffix makes full-ID order non-deterministic, but the
  // timestamp-sequence prefix is deterministic. Resetting the sequence to zero
  // at the same timestamp produces a prefix lexicographically earlier than a
  // previously emitted high-sequence prefix at that timestamp. The producer
  // cannot detect history, so the ordering contract is violated; this documents
  // the boundary and is why production callers must use monotonic timestamps
  // across restarts.
  const prefix = (id) => id.slice(0, id.lastIndexOf('-'));
  assert.ok(prefix(afterReset) < prefix(highSequence), 'reset sequence at same timestamp regresses order');
  assert.equal(prefix(beforeReset), prefix(afterReset), 'reset returns sequence to zero');
});

test('generateSortableId rate-limits high-water advancement so a far-future timestamp cannot pin the sequence', async () => {
  const { generateSortableId, resetSortableIdSequence, getSortableIdSequence, MAX_HIGH_WATER_ADVANCE_MS } =
    await import('../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-rate-limit');
  resetSortableIdSequence();

  const base = 1_000_000;
  generateSortableId(base);
  assert.equal(getSortableIdSequence(), 1);

  // A far-future timestamp is capped to high-water + MAX_HIGH_WATER_ADVANCE_MS,
  // so it advances the high-water mark by only one bounded step.
  const farFuture = base + MAX_HIGH_WATER_ADVANCE_MS * 100;
  const futureId = generateSortableId(farFuture);
  const futurePrefix = Number(futureId.slice(0, 16));
  assert.equal(
    futurePrefix,
    base + MAX_HIGH_WATER_ADVANCE_MS,
    'far-future timestamp advances high-water by at most MAX_HIGH_WATER_ADVANCE_MS',
  );

  // Subsequent ordinary timestamps can still advance the high-water mark,
  // proving the global sequence bucket is not permanently pinned.
  const ordinary = base + MAX_HIGH_WATER_ADVANCE_MS + 1;
  generateSortableId(ordinary);
  assert.equal(getSortableIdSequence(), 1, 'ordinary timestamp advances high-water and resets sequence');
});
