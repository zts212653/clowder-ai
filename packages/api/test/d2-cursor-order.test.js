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
  assert.equal(getSortableIdSequence(), MAX_SEQUENCE + 1);
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
