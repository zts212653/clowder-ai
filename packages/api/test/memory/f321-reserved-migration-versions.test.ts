import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/domains/memory/schema.js';

test('installs owner memory tables after an existing V59 ledger without reusing deployed F323 versions', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    // A pre-F321 main database has the old canonical schema and historical F323
    // markers, but none of these new owner lifecycle tables. Keep every older
    // table and version marker; the fixture removes only the unshipped F321 slice.
    const tables = [
      'entity_memory_forget_tombstones',
      'entity_memory_owner_action_evidence',
      'profile_memory_owner_action_evidence',
      'taste_memory_lifecycle',
      'taste_memory_owner_action_evidence',
      'taste_takeaway_candidates',
    ];
    for (const table of tables) db.exec(`DROP TABLE ${table}`);
    db.prepare('DELETE FROM schema_version WHERE version > 52').run();
    const history = db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)');
    for (const version of [53, 54, 55, 56, 57, 58, 59]) history.run(version, 'historical-main-boot');

    applyMigrations(db);
    applyMigrations(db);
    for (const table of tables) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
    }
    assert.deepEqual(
      db
        .prepare('SELECT version, applied_at FROM schema_version WHERE version BETWEEN 53 AND 59 ORDER BY version')
        .all(),
      [53, 54, 55, 56, 57, 58, 59].map((version) => ({ version, applied_at: 'historical-main-boot' })),
    );
    assert.ok(
      (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version > 59,
    );
  } finally {
    db.close();
  }
});

test('deployed F306 V63 is preserved while F321 installs its own V64/V65 state', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.exec('DROP TABLE thread_curation_state; DELETE FROM schema_version WHERE version > 63');
    db.prepare("UPDATE schema_version SET applied_at='deployed-f306' WHERE version=63").run();
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_dynamic_managed_candidates'").get();
    applyMigrations(db);
    assert.deepEqual(db.prepare('SELECT version,applied_at FROM schema_version WHERE version=63').get(), {
      version: 63,
      applied_at: 'deployed-f306',
    });
    assert.deepEqual(
      db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_dynamic_managed_candidates'").get(),
      before,
    );
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='thread_curation_state'").get());
    assert.ok(
      (db.prepare('PRAGMA table_info(thread_curation_state)').all() as Array<{ name: string }>).some(
        (row) => row.name === 'backfill_attempt_order',
      ),
    );
  } finally {
    db.close();
  }
});

test('isolated pre-merge V64 retains overview metadata and repairs the concurrent V63 no-spawn index', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.prepare(`INSERT INTO thread_curation_state(owner_user_id,thread_id,session_id,provider_identity,summary_revision,directory_line,backfill_cursor,backfill_attempt_order)
      VALUES ('owner','thread','native','luna','revision','idea','cursor',8)`).run();
    const before = db.prepare('SELECT * FROM thread_curation_state').all();
    db.exec(`DELETE FROM schema_version WHERE version>=65;
      DROP INDEX idx_dynamic_managed_candidates;
      CREATE INDEX idx_dynamic_managed_candidates ON dynamic_task_defs(created_at DESC)
        WHERE template_id='reminder' AND json_extract(params_json,'$.holdLifecycle.managedCommand.state')='command_running'`);
    applyMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM thread_curation_state').all(), before);
    assert.match(
      (db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_dynamic_managed_candidates'").get() as { sql: string })
        .sql,
      /not_started/,
    );
  } finally {
    db.close();
  }
});
