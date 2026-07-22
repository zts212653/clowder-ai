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
  const { generateSortableId } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js?sortable-id-admission'
  );

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
