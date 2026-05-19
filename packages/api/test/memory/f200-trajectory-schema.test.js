import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F200 Phase D — task_trajectories schema V22', () => {
  let Database, applyMigrations, SCHEMA_V1;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import(`../../dist/domains/memory/schema.js?v=${Date.now()}`);
    applyMigrations = schema.applyMigrations;
    SCHEMA_V1 = schema.SCHEMA_V1;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);
  });

  it('creates task_trajectories table with correct columns', () => {
    const cols = db.prepare("PRAGMA table_info('task_trajectories')").all();
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes('trajectory_id'), 'missing trajectory_id');
    assert.ok(colNames.includes('invocation_id'), 'missing invocation_id');
    assert.ok(colNames.includes('thread_id'), 'missing thread_id');
    assert.ok(colNames.includes('cat_id'), 'missing cat_id');
    assert.ok(colNames.includes('task_context'), 'missing task_context');
    assert.ok(colNames.includes('search_event_ids_json'), 'missing search_event_ids_json');
    assert.ok(colNames.includes('files_read_json'), 'missing files_read_json');
    assert.ok(colNames.includes('files_modified_json'), 'missing files_modified_json');
    assert.ok(colNames.includes('output_verified'), 'missing output_verified');
    assert.ok(colNames.includes('output_verified_signals_json'), 'missing output_verified_signals_json');
    assert.ok(colNames.includes('total_token_cost'), 'missing total_token_cost');
    assert.ok(colNames.includes('duration'), 'missing duration');
    assert.ok(colNames.includes('created_at'), 'missing created_at');
    assert.ok(colNames.includes('updated_at'), 'missing updated_at');
  });

  it('has indexes on invocation_id, thread_id, cat_id, output_verified', () => {
    const indexes = db.prepare("PRAGMA index_list('task_trajectories')").all();
    const indexNames = indexes.map((i) => i.name);
    assert.ok(
      indexNames.some((n) => n.includes('inv')),
      'missing invocation_id index',
    );
    assert.ok(
      indexNames.some((n) => n.includes('thread')),
      'missing thread_id index',
    );
    assert.ok(
      indexNames.some((n) => n.includes('cat')),
      'missing cat_id index',
    );
    assert.ok(
      indexNames.some((n) => n.includes('verified')),
      'missing output_verified index',
    );
  });

  it('can insert and retrieve a trajectory record', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO task_trajectories (
        trajectory_id, invocation_id, thread_id, cat_id, task_context,
        search_event_ids_json, files_read_json, files_modified_json,
        output_verified, output_verified_signals_json,
        total_token_cost, duration, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'traj-001',
      'inv-001',
      'thread-001',
      'opus-46',
      'F200 search → recall',
      '["re-001","re-002"]',
      '["src/foo.ts"]',
      '["src/bar.ts"]',
      0,
      '[]',
      1500,
      45000,
      now,
      now,
    );

    const row = db.prepare('SELECT * FROM task_trajectories WHERE trajectory_id = ?').get('traj-001');
    assert.equal(row.invocation_id, 'inv-001');
    assert.equal(row.thread_id, 'thread-001');
    assert.equal(row.cat_id, 'opus-46');
    assert.equal(row.task_context, 'F200 search → recall');
    assert.deepEqual(JSON.parse(row.search_event_ids_json), ['re-001', 're-002']);
    assert.deepEqual(JSON.parse(row.files_read_json), ['src/foo.ts']);
    assert.deepEqual(JSON.parse(row.files_modified_json), ['src/bar.ts']);
    assert.equal(row.output_verified, 0);
    assert.equal(row.total_token_cost, 1500);
    assert.equal(row.duration, 45000);
  });

  it('reaches schema version 23', () => {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    assert.equal(row.v, 23);
  });
});
