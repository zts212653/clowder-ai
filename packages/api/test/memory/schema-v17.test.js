// F186 Phase A Task 9: Schema V17 migration test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Schema V17 migration', () => {
  it('CURRENT_SCHEMA_VERSION is 18', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    assert.equal(CURRENT_SCHEMA_VERSION, 18);
  });

  it('V17 adds collection_id and review_status to evidence_docs', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();
    const cols = db.pragma('table_info(evidence_docs)').map((c) => c.name);
    assert.ok(cols.includes('collection_id'), 'missing collection_id column');
    assert.ok(cols.includes('review_status'), 'missing review_status column');
  });

  it('V17 adds marker routing columns', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();
    const cols = db.pragma('table_info(markers)').map((c) => c.name);
    assert.ok(cols.includes('source_collection_id'), 'missing source_collection_id');
    assert.ok(cols.includes('target_collection_id'), 'missing target_collection_id');
    assert.ok(cols.includes('promote_review_status'), 'missing promote_review_status');
  });

  it('collection_id index exists', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();
    const indexes = db.pragma('index_list(evidence_docs)').map((i) => i.name);
    assert.ok(indexes.includes('idx_evidence_docs_collection'), 'missing collection index');
  });
});
