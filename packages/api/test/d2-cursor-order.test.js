/**
 * Sortable-ID producer admission regressions.
 *
 * Store-boundary coverage lives in message-store.test.js and
 * redis-message-store.test.js. This suite only protects the shared generator's
 * direct-call contract and its sequence side-effect boundary.
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
  assert.equal(getSortableIdSequence(1), MAX_SEQUENCE + 1);
});

test('generateSortableId sequences are independent per timestamp', async () => {
  const { generateSortableId, resetSortableIdSequence, getSortableIdSequence } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-per-ts'
  );
  resetSortableIdSequence();

  const tsA = 1_000;
  const tsB = 2_000;

  // Advance tsA several times.
  const a1 = generateSortableId(tsA);
  const a2 = generateSortableId(tsA);
  const a3 = generateSortableId(tsA);
  assert.equal(a1.split('-')[1], '000000');
  assert.equal(a2.split('-')[1], '000001');
  assert.equal(a3.split('-')[1], '000002');
  assert.equal(getSortableIdSequence(tsA), 3);

  // tsB starts from the default (0), not from tsA's next sequence.
  const b1 = generateSortableId(tsB);
  assert.equal(b1.split('-')[1], '000000', 'independent timestamp starts from default sequence');
  assert.equal(getSortableIdSequence(tsB), 1);

  // Revisiting tsA continues from where it left off.
  const a4 = generateSortableId(tsA);
  assert.equal(a4.split('-')[1], '000003');
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
  // previously emitted high-sequence prefix at that timestamp. The module-global
  // producer cannot detect history, so the ordering contract is violated; this
  // documents the boundary and is why production callers must use monotonic
  // timestamps across restarts.
  const prefix = (id) => id.slice(0, id.lastIndexOf('-'));
  assert.ok(prefix(afterReset) < prefix(highSequence), 'reset sequence at same timestamp regresses order');
  assert.equal(prefix(beforeReset), prefix(afterReset), 'reset returns sequence to zero');
});

test('generateSortableId keeps per-timestamp sequence monotonic across clock rollback', async () => {
  const { generateSortableId, resetSortableIdSequence } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-rollback'
  );
  resetSortableIdSequence();

  // Scenario from D2 review: clock rolls back and forth within the admitted
  // Date domain. Each timestamp must keep its own independent next-sequence.
  const timestamps = [1_000, 1_001, 1_000, 1_002, 1_000];
  const ids = timestamps.map((ts) => generateSortableId(ts));

  // Expected per-timestamp sequences:
  // 1000 -> 0, 1001 -> 0, 1000 -> 1, 1002 -> 0, 1000 -> 2
  const expectedSequences = ['000000', '000000', '000001', '000000', '000002'];
  for (let i = 0; i < ids.length; i++) {
    assert.equal(ids[i].split('-')[1], expectedSequences[i], `sequence for append ${i}`);
  }

  // Same-timestamp prefixes must advance monotonically (the D2 cursor-order
  // invariant). Cross-timestamp order is governed by the timestamp component
  // and is intentionally not tied to append order when the clock rolls back.
  const prefix = (id) => id.slice(0, id.lastIndexOf('-'));
  assert.ok(prefix(ids[2]) > prefix(ids[0]), 'second 1000 append sorts after first 1000 append');
  assert.ok(prefix(ids[4]) > prefix(ids[2]), 'third 1000 append sorts after second 1000 append');
});

test('generateSortableId sequence state is bounded regardless of process lifetime', async () => {
  const { generateSortableId, resetSortableIdSequence, getSortableIdSequence, MAX_TRACKED_TIMESTAMPS } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-bounded'
  );
  resetSortableIdSequence();

  // Generate IDs for more distinct timestamps than the cache can hold.
  const overflow = MAX_TRACKED_TIMESTAMPS + 100;
  for (let i = 0; i < overflow; i++) {
    generateSortableId(i + 1);
  }

  // Count how many timestamps still have cached sequence state.
  let trackedCount = 0;
  for (let i = 1; i <= overflow; i++) {
    if (getSortableIdSequence(i) > 0) {
      trackedCount++;
    }
  }

  assert.ok(
    trackedCount <= MAX_TRACKED_TIMESTAMPS,
    `tracked timestamps ${trackedCount} exceed capacity ${MAX_TRACKED_TIMESTAMPS}`,
  );

  // Recent timestamps must remain usable: the most recent distinct timestamp
  // should have advanced its sequence by one.
  assert.equal(getSortableIdSequence(overflow), 1);
});
