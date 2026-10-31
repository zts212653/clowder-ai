import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('getRecallStats24h (F200 AC-A4)', () => {
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

  it('returns zero counts for empty table', async () => {
    const { getRecallStats24h } = await import(`../../dist/domains/memory/recall-stats.js?v=${Date.now()}`);
    const stats = getRecallStats24h(db);
    assert.equal(stats.total, 0);
    assert.equal(stats.consumed, 0);
    assert.equal(stats.reformulated, 0);
    assert.equal(stats.abandoned, 0);
    assert.equal(stats.fellBackToGrep, 0);
  });

  it('counts events within 24h', async () => {
    const { getRecallStats24h } = await import(`../../dist/domains/memory/recall-stats.js?v2=${Date.now()}`);
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO recall_events
        (recall_id, cat_id, invocation_id, tool_name, query, candidates_json, consumed_json,
         reformulated, fell_back_to_grep, abandoned, next_graph_resolve_after_read, token_cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Recent event — consumed (consumed_json non-empty)
    insert.run('r1', 'opus', 'inv-1', 'search_evidence', 'q1', '[]', '[{"anchor":"A"}]', 0, 0, 0, 0, 100, now);
    // Recent event — abandoned
    insert.run('r2', 'opus', 'inv-2', 'search_evidence', 'q2', '[]', '[]', 0, 0, 1, 0, 200, now - 3600_000);
    // Recent event — reformulated + grep fallback
    insert.run('r3', 'opus', 'inv-3', 'graph_resolve', 'q3', '[]', '[]', 1, 1, 0, 0, 150, now - 7200_000);
    // Old event (>24h) — should NOT be counted
    insert.run('r4', 'opus', 'inv-4', 'search_evidence', 'q4', '[]', '[]', 1, 0, 0, 0, 50, now - 90000_000);

    const stats = getRecallStats24h(db);
    assert.equal(stats.total, 3, '3 recent events');
    assert.equal(stats.consumed, 1, '1 with non-empty consumed');
    assert.equal(stats.reformulated, 1);
    assert.equal(stats.abandoned, 1);
    assert.equal(stats.fellBackToGrep, 1);
  });
});
