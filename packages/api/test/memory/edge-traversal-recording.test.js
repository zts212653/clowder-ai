import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('Edge traversal recording (F200 PG-3)', () => {
  let Database;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema.SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    schema.applyMigrations(db);
  });

  it('recordEdgeTraversals increments traversal_count', async () => {
    const { recordEdgeTraversals } = await import(`../../dist/domains/memory/edge-traversal.js?v=${Date.now()}`);

    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('A', 'B', 'related_to')").run();

    recordEdgeTraversals(db, [{ from: 'A', to: 'B', relation: 'related_to' }]);

    const edge = db.prepare("SELECT * FROM edges WHERE from_anchor = 'A' AND to_anchor = 'B'").get();
    assert.equal(edge.traversal_count, 1);
    assert.ok(edge.last_traversed_at, 'last_traversed_at is set');
  });

  it('repeated traversal increments count', async () => {
    const { recordEdgeTraversals } = await import(`../../dist/domains/memory/edge-traversal.js?v2=${Date.now()}`);

    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('X', 'Y', 'feature_ref')").run();

    recordEdgeTraversals(db, [{ from: 'X', to: 'Y', relation: 'feature_ref' }]);
    recordEdgeTraversals(db, [{ from: 'X', to: 'Y', relation: 'feature_ref' }]);

    const edge = db.prepare("SELECT * FROM edges WHERE from_anchor = 'X' AND to_anchor = 'Y'").get();
    assert.equal(edge.traversal_count, 2);
  });

  it('handles non-existent edges gracefully (no crash)', async () => {
    const { recordEdgeTraversals } = await import(`../../dist/domains/memory/edge-traversal.js?v3=${Date.now()}`);

    recordEdgeTraversals(db, [{ from: 'ghost', to: 'phantom', relation: 'none' }]);
    // Should not throw — edge doesn't exist, UPDATE matches 0 rows
  });

  it('records traversals for multiple edges at once', async () => {
    const { recordEdgeTraversals } = await import(`../../dist/domains/memory/edge-traversal.js?v4=${Date.now()}`);

    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('A', 'B', 'related_to')").run();
    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('A', 'C', 'feature_ref')").run();

    recordEdgeTraversals(db, [
      { from: 'A', to: 'B', relation: 'related_to' },
      { from: 'A', to: 'C', relation: 'feature_ref' },
    ]);

    const b = db.prepare("SELECT traversal_count FROM edges WHERE to_anchor = 'B'").get();
    const c = db.prepare("SELECT traversal_count FROM edges WHERE to_anchor = 'C'").get();
    assert.equal(b.traversal_count, 1);
    assert.equal(c.traversal_count, 1);
  });
});
