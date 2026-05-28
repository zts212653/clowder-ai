/**
 * F102 bugfix regression: V25 migration — thread_id column + backfill
 *
 * Verifies:
 * - V25 adds thread_id column to recall_events
 * - V25 creates idx_recall_events_thread index
 * - Backfill SQL correctly recovers thread_id from task_trajectories
 * - Orphan recall_events (no matching trajectory) keep empty thread_id
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('V25 migration — F102 recall_events thread_id', () => {
  it('adds thread_id column with empty default', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { SCHEMA_V1, applyMigrations } = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());

    applyMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info('recall_events')")
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes('thread_id'), 'thread_id column exists');

    // Verify default is empty string
    db.prepare(
      `INSERT INTO recall_events
        (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
         candidates_json, consumed_json, reformulated, fell_back_to_grep,
         abandoned, next_graph_resolve_after_read, token_cost, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('r-default', 'opus', 'inv-1', 'search_evidence', 'test', 'hybrid', 'docs', '[]', '[]', 0, 0, 0, 0, 0, 1000);

    const row = db.prepare('SELECT thread_id FROM recall_events WHERE recall_id = ?').get('r-default');
    assert.equal(row.thread_id, '', 'default thread_id is empty string');

    db.close();
  });

  it('creates idx_recall_events_thread index', async () => {
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
    assert.ok(indexes.includes('idx_recall_events_thread'), 'thread index exists');

    db.close();
  });

  it('backfill recovers thread_id from task_trajectories', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { SCHEMA_V1, applyMigrations } = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());

    // Apply all migrations (V25 backfill runs on empty tables — no-op)
    applyMigrations(db);

    // Simulate "old" recall_events with empty thread_id (pre-backfill state)
    db.prepare(
      `INSERT INTO recall_events
        (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
         candidates_json, consumed_json, reformulated, fell_back_to_grep,
         abandoned, next_graph_resolve_after_read, token_cost, timestamp, thread_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'r-match',
      'opus',
      'inv-with-traj',
      'search_evidence',
      'F200',
      'hybrid',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      1000,
      '',
    );

    db.prepare(
      `INSERT INTO recall_events
        (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
         candidates_json, consumed_json, reformulated, fell_back_to_grep,
         abandoned, next_graph_resolve_after_read, token_cost, timestamp, thread_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'r-orphan',
      'opus',
      'inv-no-traj',
      'search_evidence',
      'orphan',
      'hybrid',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      2000,
      '',
    );

    // Seed task_trajectories with known thread_id for one invocation
    db.prepare(
      `INSERT INTO task_trajectories
        (trajectory_id, invocation_id, thread_id, cat_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('traj-1', 'inv-with-traj', 'thread-abc-123', 'opus', Date.now(), Date.now());

    // Re-run the V25 backfill SQL (same statement as migration)
    db.exec(`
      UPDATE recall_events SET thread_id = (
        SELECT t.thread_id FROM task_trajectories t
        WHERE t.invocation_id = recall_events.invocation_id
        LIMIT 1
      ) WHERE thread_id = '' AND EXISTS (
        SELECT 1 FROM task_trajectories t
        WHERE t.invocation_id = recall_events.invocation_id
      )
    `);

    // Matched row: thread_id recovered from trajectory
    const matched = db.prepare('SELECT thread_id FROM recall_events WHERE recall_id = ?').get('r-match');
    assert.equal(matched.thread_id, 'thread-abc-123', 'thread_id backfilled from task_trajectories');

    // Orphan row: no matching trajectory, stays empty
    const orphan = db.prepare('SELECT thread_id FROM recall_events WHERE recall_id = ?').get('r-orphan');
    assert.equal(orphan.thread_id, '', 'orphan recall_event keeps empty thread_id');

    db.close();
  });

  it('backfill skips rows that already have thread_id', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { SCHEMA_V1, applyMigrations } = await import('../../dist/domains/memory/schema.js');

    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);

    // Row already has a thread_id — should NOT be overwritten
    db.prepare(
      `INSERT INTO recall_events
        (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
         candidates_json, consumed_json, reformulated, fell_back_to_grep,
         abandoned, next_graph_resolve_after_read, token_cost, timestamp, thread_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'r-existing',
      'opus',
      'inv-existing',
      'search_evidence',
      'test',
      'hybrid',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      0,
      3000,
      'thread-original',
    );

    // Trajectory points to different thread
    db.prepare(
      `INSERT INTO task_trajectories
        (trajectory_id, invocation_id, thread_id, cat_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('traj-2', 'inv-existing', 'thread-different', 'opus', Date.now(), Date.now());

    // Run backfill — should skip because thread_id != ''
    db.exec(`
      UPDATE recall_events SET thread_id = (
        SELECT t.thread_id FROM task_trajectories t
        WHERE t.invocation_id = recall_events.invocation_id
        LIMIT 1
      ) WHERE thread_id = '' AND EXISTS (
        SELECT 1 FROM task_trajectories t
        WHERE t.invocation_id = recall_events.invocation_id
      )
    `);

    const row = db.prepare('SELECT thread_id FROM recall_events WHERE recall_id = ?').get('r-existing');
    assert.equal(row.thread_id, 'thread-original', 'existing thread_id not overwritten');

    db.close();
  });
});
