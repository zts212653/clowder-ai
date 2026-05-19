import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('V18 edges schema migration (AC-C0a)', () => {
  it('adds 5 columns to a V1-only edges table', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { SCHEMA_V1, applyMigrations } = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());

    const colsBefore = db
      .prepare("PRAGMA table_info('edges')")
      .all()
      .map((c) => c.name);
    assert.deepEqual(colsBefore, ['from_anchor', 'to_anchor', 'relation']);

    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('F186', 'F102', 'related')").run();

    applyMigrations(db);

    const colsAfter = db
      .prepare("PRAGMA table_info('edges')")
      .all()
      .map((c) => c.name);
    assert.ok(colsAfter.includes('from_collection_id'), 'from_collection_id column added');
    assert.ok(colsAfter.includes('to_collection_id'), 'to_collection_id column added');
    assert.ok(colsAfter.includes('edge_sensitivity'), 'edge_sensitivity column added');
    assert.ok(colsAfter.includes('provenance'), 'provenance column added');
    assert.ok(colsAfter.includes('created_at'), 'created_at column added');

    const legacyEdge = db.prepare('SELECT * FROM edges WHERE from_anchor = ?').get('F186');
    assert.equal(legacyEdge.from_anchor, 'F186');
    assert.equal(legacyEdge.from_collection_id, null, 'legacy edge has null for new columns');

    db.close();
  });

  it('getRelated works after V18 migration on legacy edges', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    await store.addEdge({
      fromAnchor: 'F186',
      toAnchor: 'F102',
      relation: 'related_to',
      provenance: 'frontmatter',
    });

    const related = await store.getRelated('F186');
    assert.equal(related.length, 1);
    assert.equal(related[0].anchor, 'F102');
    assert.equal(related[0].relation, 'related_to');
    assert.equal(related[0].provenance, 'frontmatter');

    const reverse = await store.getRelated('F102');
    assert.equal(reverse.length, 1);
    assert.equal(reverse[0].anchor, 'F186');

    store.close();
  });

  it('addEdge writes all 8 columns after migration', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    await store.addEdge({
      fromAnchor: 'F188',
      toAnchor: 'F186',
      relation: 'feature_ref',
      fromCollectionId: 'project:cat-cafe',
      toCollectionId: 'project:cat-cafe',
      edgeSensitivity: 'internal',
      provenance: 'content',
    });

    const related = await store.getRelated('F188');
    assert.equal(related.length, 1);
    assert.equal(related[0].anchor, 'F186');
    assert.equal(related[0].fromCollectionId, 'project:cat-cafe');
    assert.equal(related[0].toCollectionId, 'project:cat-cafe');
    assert.equal(related[0].edgeSensitivity, 'internal');
    assert.equal(related[0].provenance, 'content');

    store.close();
  });
});
