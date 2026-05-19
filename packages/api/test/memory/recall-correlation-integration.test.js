import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F200 recall correlation integration', () => {
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

  it('end-to-end: search_evidence → Read → RecallEvent persisted', async () => {
    const { triggerRecallCorrelation } = await import(
      `../../dist/domains/memory/recall-correlation-hook.js?v=${Date.now()}`
    );

    const now = Date.now();
    const events = [
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'search_evidence',
        summary: {
          query: 'memory adapter',
          mode: 'hybrid',
          scope: 'docs',
          resultCount: 1,
          _f200Candidates: [
            { anchor: 'F102', rank: 0, sourcePath: 'docs/features/F102-memory-adapter.md', docKind: 'feature' },
          ],
        },
        timestamp: now - 5000,
      },
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'Read',
        summary: { file_path: '/path/cat-cafe/docs/features/F102-memory-adapter.md' },
        timestamp: now - 3000,
      },
    ];

    await triggerRecallCorrelation(db, events, 'inv-1', 'opus');

    const rows = db.prepare('SELECT * FROM recall_events').all();
    assert.equal(rows.length, 1, 'one RecallEvent persisted');
    assert.equal(rows[0].tool_name, 'search_evidence');
    assert.equal(rows[0].cat_id, 'opus');

    const consumed = JSON.parse(rows[0].consumed_json);
    assert.equal(consumed.length, 1, 'one consumed entry');
    assert.equal(consumed[0].anchor, 'F102');
    assert.equal(consumed[0].method, 'Read');
  });

  it('no memory tools → no RecallEvents', async () => {
    const { triggerRecallCorrelation } = await import(
      `../../dist/domains/memory/recall-correlation-hook.js?v2=${Date.now()}`
    );

    const events = [
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'Edit',
        toolInput: { file_path: '/src/foo.ts' },
        summary: {},
        timestamp: Date.now(),
      },
    ];

    await triggerRecallCorrelation(db, events, 'inv-1', 'opus');

    const rows = db.prepare('SELECT * FROM recall_events').all();
    assert.equal(rows.length, 0, 'no recall events for non-memory tools');
  });

  it('edge traversals recorded from graph_resolve with edges', async () => {
    const { triggerRecallCorrelation } = await import(
      `../../dist/domains/memory/recall-correlation-hook.js?v3=${Date.now()}`
    );

    // Pre-populate edges
    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('F102', 'F042', 'feature_ref')").run();
    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('F102', 'ADR-019', 'doc_link')").run();

    const now = Date.now();
    const events = [
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'graph_resolve',
        toolInput: { query: 'F102' },
        summary: {
          centerAnchor: 'F102',
          nodeCount: 3,
          edgeCount: 2,
          _f200Candidates: [{ anchor: 'F102', rank: 0 }],
          _f200Edges: [
            { from: 'F102', to: 'F042', relation: 'feature_ref' },
            { from: 'F102', to: 'ADR-019', relation: 'doc_link' },
          ],
        },
        timestamp: now,
      },
    ];

    await triggerRecallCorrelation(db, events, 'inv-1', 'opus');

    // P1-2 fix: only edges whose target was consumed should be recorded
    // graph_resolve with no follow-up Read = no consumption = no edge traversal
    const e1 = db.prepare("SELECT traversal_count FROM edges WHERE from_anchor = 'F102' AND to_anchor = 'F042'").get();
    const e2 = db
      .prepare("SELECT traversal_count FROM edges WHERE from_anchor = 'F102' AND to_anchor = 'ADR-019'")
      .get();
    assert.equal(e1.traversal_count, 0, 'no consumption = no edge traversal');
    assert.equal(e2.traversal_count, 0, 'no consumption = no edge traversal');
  });

  it('edge traversals only recorded for consumed targets', async () => {
    const { triggerRecallCorrelation } = await import(
      `../../dist/domains/memory/recall-correlation-hook.js?v4=${Date.now()}`
    );

    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('F102', 'F042', 'feature_ref')").run();
    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('F102', 'ADR-019', 'doc_link')").run();

    const now = Date.now();
    const events = [
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'graph_resolve',
        summary: {
          centerAnchor: 'F102',
          nodeCount: 3,
          edgeCount: 2,
          query: 'F102',
          _f200Candidates: [
            { anchor: 'F102', rank: 0 },
            { anchor: 'F042', rank: 1 },
            { anchor: 'ADR-019', rank: 2 },
          ],
          _f200Edges: [
            { from: 'F102', to: 'F042', relation: 'feature_ref' },
            { from: 'F102', to: 'ADR-019', relation: 'doc_link' },
          ],
        },
        timestamp: now - 5000,
      },
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'Read',
        summary: { file_path: '/path/cat-cafe/docs/features/F042-something.md' },
        timestamp: now - 3000,
      },
    ];

    await triggerRecallCorrelation(db, events, 'inv-1', 'opus');

    const e1 = db.prepare("SELECT traversal_count FROM edges WHERE from_anchor = 'F102' AND to_anchor = 'F042'").get();
    const e2 = db
      .prepare("SELECT traversal_count FROM edges WHERE from_anchor = 'F102' AND to_anchor = 'ADR-019'")
      .get();
    assert.equal(e1.traversal_count, 1, 'consumed target edge recorded');
    assert.equal(e2.traversal_count, 0, 'unconsumed target edge NOT recorded');
  });

  it('reading center anchor does NOT record outbound edges', async () => {
    const { triggerRecallCorrelation } = await import(
      `../../dist/domains/memory/recall-correlation-hook.js?v5=${Date.now()}`
    );

    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('F102', 'F042', 'feature_ref')").run();

    const now = Date.now();
    const events = [
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'graph_resolve',
        summary: {
          centerAnchor: 'F102',
          nodeCount: 2,
          edgeCount: 1,
          query: 'F102',
          _f200Candidates: [
            { anchor: 'F102', rank: 0 },
            { anchor: 'F042', rank: 1 },
          ],
          _f200Edges: [{ from: 'F102', to: 'F042', relation: 'feature_ref' }],
        },
        timestamp: now - 5000,
      },
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'Read',
        summary: { file_path: '/path/cat-cafe/docs/features/F102-memory-adapter.md' },
        timestamp: now - 3000,
      },
    ];

    await triggerRecallCorrelation(db, events, 'inv-1', 'opus');

    const e1 = db.prepare("SELECT traversal_count FROM edges WHERE from_anchor = 'F102' AND to_anchor = 'F042'").get();
    assert.equal(e1.traversal_count, 0, 'reading center does NOT count as traversing outbound edges');
  });

  it('private collection hits are not persisted in recall_events', async () => {
    const { triggerRecallCorrelation } = await import(
      `../../dist/domains/memory/recall-correlation-hook.js?v6=${Date.now()}`
    );

    const now = Date.now();
    const events = [
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'search_evidence',
        summary: {
          query: 'secret plot',
          mode: 'hybrid',
          scope: 'all',
          resultCount: 1,
          _f200Candidates: [{ anchor: 'world:lexander:doc/secret-plot', rank: 0, docKind: 'doc' }],
          _f200HasPrivateHits: true,
        },
        timestamp: now - 5000,
      },
      {
        threadId: 'th-1',
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'Read',
        summary: { file_path: '/path/library/world-lexander/doc/secret-plot.md' },
        timestamp: now - 3000,
      },
    ];

    await triggerRecallCorrelation(db, events, 'inv-1', 'opus');

    const rows = db.prepare('SELECT * FROM recall_events').all();
    assert.equal(rows.length, 0, 'no RecallEvent for private collection hits');
  });
});
