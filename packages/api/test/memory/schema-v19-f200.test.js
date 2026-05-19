import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('V19 migration — F200 recall_events + edge traversal columns', () => {
  it('creates recall_events table with all columns', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { SCHEMA_V1, applyMigrations } = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());

    applyMigrations(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recall_events'").all();
    assert.equal(tables.length, 1, 'recall_events table exists');

    const cols = db
      .prepare("PRAGMA table_info('recall_events')")
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes('recall_id'), 'has recall_id');
    assert.ok(cols.includes('cat_id'), 'has cat_id');
    assert.ok(cols.includes('invocation_id'), 'has invocation_id');
    assert.ok(cols.includes('tool_name'), 'has tool_name');
    assert.ok(cols.includes('query'), 'has query');
    assert.ok(cols.includes('mode'), 'has mode');
    assert.ok(cols.includes('scope'), 'has scope');
    assert.ok(cols.includes('candidates_json'), 'has candidates_json');
    assert.ok(cols.includes('consumed_json'), 'has consumed_json');
    assert.ok(cols.includes('reformulated'), 'has reformulated');
    assert.ok(cols.includes('fell_back_to_grep'), 'has fell_back_to_grep');
    assert.ok(cols.includes('abandoned'), 'has abandoned');
    assert.ok(cols.includes('next_graph_resolve_after_read'), 'has next_graph_resolve_after_read');
    assert.ok(cols.includes('token_cost'), 'has token_cost');
    assert.ok(cols.includes('timestamp'), 'has timestamp');

    db.close();
  });

  it('adds traversal_count and last_traversed_at to edges', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { SCHEMA_V1, applyMigrations } = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());

    db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('A', 'B', 'related')").run();

    applyMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info('edges')")
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes('traversal_count'), 'traversal_count column added');
    assert.ok(cols.includes('last_traversed_at'), 'last_traversed_at column added');

    const edge = db.prepare('SELECT * FROM edges WHERE from_anchor = ?').get('A');
    assert.equal(edge.traversal_count, 0, 'default traversal_count is 0');
    assert.equal(edge.last_traversed_at, null, 'default last_traversed_at is null');

    db.close();
  });

  it('recall_events indexes exist', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { SCHEMA_V1, applyMigrations } = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());

    applyMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='recall_events'")
      .all()
      .map((r) => r.name);
    assert.ok(indexes.includes('idx_recall_events_cat'), 'cat_id index');
    assert.ok(indexes.includes('idx_recall_events_ts'), 'timestamp index');
    assert.ok(indexes.includes('idx_recall_events_inv'), 'invocation_id index');

    db.close();
  });

  it('CURRENT_SCHEMA_VERSION is 23', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    assert.equal(CURRENT_SCHEMA_VERSION, 23);
  });

  it('can insert and read recall_events', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { SCHEMA_V1, applyMigrations } = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);

    db.prepare(`
      INSERT INTO recall_events
        (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
         candidates_json, consumed_json, reformulated, fell_back_to_grep,
         abandoned, next_graph_resolve_after_read, token_cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-id',
      'opus',
      'inv-1',
      'search_evidence',
      'F200',
      'hybrid',
      'docs',
      '[]',
      '[]',
      0,
      0,
      1,
      0,
      500,
      Date.now(),
    );

    const row = db.prepare('SELECT * FROM recall_events WHERE recall_id = ?').get('test-id');
    assert.equal(row.cat_id, 'opus');
    assert.equal(row.tool_name, 'search_evidence');
    assert.equal(row.abandoned, 1);

    db.close();
  });
});
