// F186 Phase A Task 6: CollectionReadModel — deterministic read-model for Overview + Health
// Covers AC-A7 (Collection Overview Lens), AC-A8 (Hub Catalog skeleton)

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('CollectionReadModel', () => {
  let CollectionReadModel, SqliteEvidenceStore;
  let store, db;

  beforeEach(async () => {
    ({ CollectionReadModel } = await import('../../dist/domains/memory/CollectionReadModel.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    db = store.getDb();

    await store.upsert([
      { anchor: 'F001', kind: 'feature', status: 'active', title: 'Feature One', updatedAt: '2026-05-01' },
      { anchor: 'F002', kind: 'feature', status: 'done', title: 'Feature Two', updatedAt: '2026-05-02' },
      { anchor: 'D001', kind: 'decision', status: 'active', title: 'Decision One', updatedAt: '2026-05-03' },
      { anchor: 'L001', kind: 'lesson', status: 'active', title: 'Lesson One', updatedAt: '2026-04-01' },
    ]);
  });

  it('computeOverview returns correct shape and counts', () => {
    const overview = CollectionReadModel.computeOverview('project:cat-cafe', 'Clowder AI', 'internal', db);
    assert.equal(overview.collectionId, 'project:cat-cafe');
    assert.equal(overview.displayName, 'Clowder AI');
    assert.equal(overview.sensitivity, 'internal');
    assert.equal(overview.docCount, 4);
    assert.equal(overview.indexable, false);
    assert.ok(Array.isArray(overview.topKinds));
    assert.equal(overview.topKinds[0].kind, 'feature');
    assert.equal(overview.topKinds[0].count, 2);
    assert.ok(Array.isArray(overview.recentAnchors));
    assert.ok(overview.recentAnchors.length <= 5);
    assert.equal(overview.recentAnchors[0].anchor, 'D001');
  });

  it('computeHealth returns correct shape', () => {
    const health = CollectionReadModel.computeHealth('project:cat-cafe', db);
    assert.equal(health.collectionId, 'project:cat-cafe');
    assert.equal(health.indexable, false);
    assert.ok(typeof health.indexFreshness === 'string');
    assert.equal(typeof health.pendingReviewCount, 'number');
    assert.equal(typeof health.orphanedAnchorCount, 'number');
  });

  it('computeOverview with empty store', async () => {
    const emptyStore = new SqliteEvidenceStore(':memory:');
    await emptyStore.initialize();
    const emptyDb = emptyStore.getDb();
    const overview = CollectionReadModel.computeOverview('project:empty', 'Empty', 'private', emptyDb);
    assert.equal(overview.docCount, 0);
    assert.equal(overview.topKinds.length, 0);
    assert.equal(overview.recentAnchors.length, 0);
  });
});
