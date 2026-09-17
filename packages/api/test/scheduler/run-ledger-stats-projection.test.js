import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations, SCHEMA_V5 } from '../../dist/domains/memory/schema.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';

function legacyDatabase(path = ':memory:') {
  const db = new Database(path);
  db.exec(SCHEMA_V5);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version VALUES (44, '2026-09-08T00:00:00Z');
  `);
  return db;
}

function insert(db, taskId, outcome) {
  return db
    .prepare(`INSERT INTO task_run_ledger
      (task_id, subject_key, outcome, signal_summary, duration_ms, started_at)
      VALUES (?, 'subject-kept', ?, '历史回执 — keep this exact content', 17, '2026-09-08T00:00:00Z')`)
    .run(taskId, outcome).lastInsertRowid;
}

function canonicalStats(db, taskId) {
  return db
    .prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(outcome = 'RUN_DELIVERED'), 0) AS delivered,
    COALESCE(SUM(outcome = 'RUN_FAILED'), 0) AS failed,
    COALESCE(SUM(outcome IN ('SKIP_NO_SIGNAL', 'SKIP_DISABLED', 'SKIP_OVERLAP')), 0) AS skipped
    FROM task_run_ledger WHERE task_id = ?`)
    .get(taskId);
}

test('schedule counters do not rescan retained run history on a read', (t) => {
  const queries = [];
  const db = new Database(':memory:', { verbose: (sql) => queries.push(sql) });
  t.after(() => db.close());
  applyMigrations(db);
  db.transaction(() => {
    for (let i = 0; i < 2000; i += 1) insert(db, 'busy-poller', i % 2 ? 'RUN_DELIVERED' : 'SKIP_NO_SIGNAL');
  })();
  const ledger = new RunLedger(db);
  queries.length = 0;
  assert.deepEqual(ledger.stats('busy-poller'), { total: 2000, delivered: 1000, failed: 0, skipped: 1000 });
  assert.equal(
    queries.some((sql) => /\bFROM\s+task_run_ledger\b/i.test(sql)),
    false,
    'a display refresh must not aggregate the complete canonical history again',
  );
  assert.deepEqual(ledger.stats('unknown'), { total: 0, delivered: 0, failed: 0, skipped: 0 });
});

test('V45 backfills legacy history atomically and repeated startup preserves exact rows and counters', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-ledger-stats-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'scheduler.sqlite');
  let db = legacyDatabase(path);
  const outcomes = [
    'RUN_DELIVERED',
    'RUN_FAILED',
    'SKIP_NO_SIGNAL',
    'SKIP_DISABLED',
    'SKIP_OVERLAP',
    'SKIP_GLOBAL_PAUSE',
  ];
  for (const outcome of outcomes) insert(db, 'poller', outcome);
  insert(db, 'second-task', 'RUN_DELIVERED');
  const before = db.prepare('SELECT * FROM task_run_ledger ORDER BY id').all();
  applyMigrations(db);
  const expected = { total: 6, delivered: 1, failed: 1, skipped: 3 };
  assert.deepEqual(new RunLedger(db).stats('poller'), expected);
  assert.deepEqual(db.prepare('SELECT * FROM task_run_ledger ORDER BY id').all(), before);
  db.close();

  db = new Database(path);
  t.after(() => db.close());
  applyMigrations(db);
  assert.deepEqual(new RunLedger(db).stats('poller'), expected);
  assert.deepEqual(db.prepare('SELECT * FROM task_run_ledger ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_version WHERE version = 45').get().count, 1);
});

test('old SQL writers, transaction rollback, corrections and a second connection keep counters exact', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-ledger-concurrent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'scheduler.sqlite');
  const writer = legacyDatabase(path);
  applyMigrations(writer);
  const reader = new Database(path);
  t.after(() => {
    reader.close();
    writer.close();
  });
  const ledger = new RunLedger(reader);
  const rowId = insert(writer, 'first', 'RUN_DELIVERED');
  assert.deepEqual(ledger.stats('first'), canonicalStats(writer, 'first'));

  writer.exec('BEGIN');
  insert(writer, 'first', 'RUN_FAILED');
  assert.equal(ledger.stats('first').total, 1, 'uncommitted writes must stay invisible');
  writer.exec('ROLLBACK');
  assert.deepEqual(ledger.stats('first'), canonicalStats(writer, 'first'));

  writer.prepare('UPDATE task_run_ledger SET task_id = ?, outcome = ? WHERE id = ?').run('second', 'RUN_FAILED', rowId);
  assert.deepEqual(ledger.stats('first'), { total: 0, delivered: 0, failed: 0, skipped: 0 });
  assert.deepEqual(ledger.stats('second'), canonicalStats(writer, 'second'));
  writer.prepare('UPDATE task_run_ledger SET outcome = ? WHERE id = ?').run('SKIP_TASK_OVERRIDE', rowId);
  assert.deepEqual(ledger.stats('second'), { total: 1, delivered: 0, failed: 0, skipped: 0 });
  writer.prepare('UPDATE task_run_ledger SET signal_summary = ? WHERE id = ?').run('corrected summary', rowId);
  assert.deepEqual(ledger.stats('second'), canonicalStats(writer, 'second'));
  writer.prepare('DELETE FROM task_run_ledger WHERE id = ?').run(rowId);
  assert.deepEqual(ledger.stats('second'), { total: 0, delivered: 0, failed: 0, skipped: 0 });
});

test('a failed V45 migration leaves history, version and schema intact before retry', (t) => {
  const db = legacyDatabase();
  t.after(() => db.close());
  insert(db, 'retained', 'RUN_DELIVERED');
  const before = db.prepare('SELECT * FROM task_run_ledger').all();
  const beforeSchema = db.prepare('SELECT name FROM sqlite_master ORDER BY name').all();
  db.exec(`CREATE TRIGGER reject_v45 BEFORE INSERT ON schema_version WHEN NEW.version = 45
    BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
  assert.throws(() => applyMigrations(db), /injected migration failure/);
  assert.deepEqual(db.prepare('SELECT * FROM task_run_ledger').all(), before);
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version, 44);
  db.exec('DROP TRIGGER reject_v45');
  assert.deepEqual(db.prepare('SELECT name FROM sqlite_master ORDER BY name').all(), beforeSchema);
  applyMigrations(db);
  assert.deepEqual(new RunLedger(db).stats('retained'), { total: 1, delivered: 1, failed: 0, skipped: 0 });
});

test('a rewound V45 marker rebuilds existing counters without double counts or phantom tasks', (t) => {
  const db = legacyDatabase();
  t.after(() => db.close());
  insert(db, 'retained', 'RUN_DELIVERED');
  applyMigrations(db);
  insert(db, 'retained', 'RUN_FAILED');
  const before = db.prepare('SELECT * FROM task_run_ledger ORDER BY id').all();
  db.exec(`INSERT INTO task_run_stats VALUES ('stale-projection', 1, 1, 0, 0);
    DELETE FROM schema_version WHERE version = 45;`);
  applyMigrations(db);
  const ledger = new RunLedger(db);
  assert.deepEqual(ledger.stats('retained'), canonicalStats(db, 'retained'));
  assert.deepEqual(ledger.stats('stale-projection'), { total: 0, delivered: 0, failed: 0, skipped: 0 });
  assert.deepEqual(db.prepare('SELECT * FROM task_run_ledger ORDER BY id').all(), before);
});
