/**
 * F163 Phase C Task 2: EvidenceItem interface + upsert round-trip for Phase C columns
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 Phase C column round-trip', () => {
  it('upsert persists contradicts/invalidAt/reviewCycleDays and getByAnchor returns them', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'LL-CT-1',
        kind: 'lesson',
        status: 'active',
        title: 'Test contradiction',
        updatedAt: '2026-04-16',
        contradicts: ['LL-OLD-1', 'LL-OLD-2'],
        invalidAt: '2026-04-16T12:00:00Z',
        reviewCycleDays: 90,
      },
    ]);
    const doc = await store.getByAnchor('LL-CT-1');
    assert.ok(doc);
    assert.deepEqual(doc.contradicts, ['LL-OLD-1', 'LL-OLD-2']);
    assert.equal(doc.invalidAt, '2026-04-16T12:00:00Z');
    assert.equal(doc.reviewCycleDays, 90);
  });

  it('defaults Phase C fields to undefined when not set', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'LL-PLAIN',
        kind: 'lesson',
        status: 'active',
        title: 'Plain doc',
        updatedAt: '2026-04-16',
      },
    ]);
    const doc = await store.getByAnchor('LL-PLAIN');
    assert.ok(doc);
    assert.equal(doc.contradicts, undefined);
    assert.equal(doc.invalidAt, undefined);
    assert.equal(doc.reviewCycleDays, undefined);
  });
});
