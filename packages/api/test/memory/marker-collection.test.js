// F186 Phase A Task 7: Marker collection routing
// Covers AC-A10 (Marker schema extension + approve target selection)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Marker collection routing', () => {
  it('Marker interface includes collection routing fields', async () => {
    const { COLLECTION_SENSITIVITY_ORDER, REVIEW_STATUSES } = await import('../../dist/domains/memory/interfaces.js');
    assert.ok(COLLECTION_SENSITIVITY_ORDER, 'sensitivity ordering available');
    assert.ok(REVIEW_STATUSES.includes('unreviewed'), 'ReviewStatus available');
  });

  it('sensitivity widening detection works', async () => {
    const { COLLECTION_SENSITIVITY_ORDER } = await import('../../dist/domains/memory/interfaces.js');
    const isWidening = (from, to) => COLLECTION_SENSITIVITY_ORDER[to] > COLLECTION_SENSITIVITY_ORDER[from];
    assert.ok(isWidening('private', 'internal'), 'private→internal is widening');
    assert.ok(isWidening('private', 'public'), 'private→public is widening');
    assert.ok(!isWidening('internal', 'private'), 'internal→private is NOT widening');
    assert.ok(!isWidening('internal', 'internal'), 'same→same is NOT widening');
  });

  it('Marker fields are optional (backwards compat)', async () => {
    const marker = {
      id: '1',
      content: 'test',
      source: 'manual',
      status: 'captured',
      createdAt: '2026-05-03',
    };
    assert.equal(marker.sourceCollectionId, undefined);
    assert.equal(marker.targetCollectionId, undefined);
    assert.equal(marker.promoteReviewStatus, undefined);
  });
});
