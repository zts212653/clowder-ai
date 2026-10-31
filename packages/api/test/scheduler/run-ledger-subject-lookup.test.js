import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';

function record(ledger, taskId, subject, sequence) {
  ledger.record({
    task_id: taskId,
    subject_key: subject,
    outcome: 'RUN_DELIVERED',
    signal_summary: `retained-${sequence}`,
    duration_ms: sequence,
    started_at: '2026-10-02T00:00:00Z',
    assigned_cat_id: null,
  });
}

test('exact subject lookup seeks both keys without scanning other tasks or sorting history', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  applyMigrations(db);
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT * FROM task_run_ledger
    WHERE task_id = ? AND subject_key = ? ORDER BY id DESC LIMIT ?`)
    .all('absent-task', 'busy-subject', 1);
  assert.ok(
    plan.some((step) => /task_id=\? AND subject_key=\?/.test(step.detail)),
    JSON.stringify(plan),
  );
  assert.ok(
    plan.every((step) => !/SCAN |TEMP B-TREE/.test(step.detail)),
    JSON.stringify(plan),
  );
});

test('bulk membership is one covering lookup and preserves exact task/subject pairs', (t) => {
  const queries = [];
  const db = new Database(':memory:', { verbose: (sql) => queries.push(sql) });
  t.after(() => db.close());
  applyMigrations(db);
  const ledger = new RunLedger(db);
  db.transaction(() => {
    for (let i = 0; i < 2000; i += 1) record(ledger, 'busy', 'shared', i);
    record(ledger, 'target', 'older-match', 2001);
    record(ledger, 'target', 'unrelated-latest', 2002);
    record(ledger, 'other', 'shared', 2003);
  })();
  queries.length = 0;
  assert.deepEqual(
    ledger.findTaskIdsBySubjects(['target', 'absent', 'target'], ['shared', 'older-match']),
    new Set(['target']),
  );
  const reads = queries.filter((sql) => /\bFROM\s+task_run_ledger\b/i.test(sql));
  assert.equal(reads.length, 1, 'membership must not execute one statement per task × subject');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${reads[0]}`).all();
  assert.ok(
    plan.some((step) => /COVERING INDEX.*task_id=\? AND subject_key=\?/.test(step.detail)),
    JSON.stringify(plan),
  );
  assert.deepEqual(ledger.findTaskIdsBySubjects([], ['shared']), new Set());
  assert.deepEqual(ledger.findTaskIdsBySubjects(['target'], []), new Set());
  assert.equal(ledger.queryBySubject('busy', 'shared', 2)[0].duration_ms, 1999);
});

test('task-wide latest-run reads keep their own index instead of sorting every subject history', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  applyMigrations(db);
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT * FROM task_run_ledger
    WHERE task_id = ? ORDER BY id DESC LIMIT ?`)
    .all('task-with-many-subjects', 1);
  assert.ok(
    plan.some((step) => /idx_run_ledger_task \(task_id=\?\)/.test(step.detail)),
    JSON.stringify(plan),
  );
  assert.ok(
    plan.every((step) => !/SCAN |TEMP B-TREE/.test(step.detail)),
    JSON.stringify(plan),
  );
});

test('V50 upgrade is atomic, restart-safe, and preserves every canonical run', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-subject-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'ledger.sqlite');
  let db = new Database(path);
  applyMigrations(db);
  const ledger = new RunLedger(db);
  record(ledger, 'kept', 'pr:a/b#1', 1);
  record(ledger, 'kept', 'pr:a/b#1', 2);
  db.exec('DROP INDEX IF EXISTS idx_run_ledger_task_subject; DELETE FROM schema_version WHERE version >= 50');
  const before = db.prepare('SELECT * FROM task_run_ledger ORDER BY id').all();
  db.exec(`CREATE TRIGGER reject_v50 BEFORE INSERT ON schema_version WHEN NEW.version = 50
    BEGIN SELECT RAISE(ABORT, 'injected v50 failure'); END`);
  assert.throws(() => applyMigrations(db), /injected v50 failure/);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_run_ledger_task_subject'").get(),
    undefined,
  );
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version, 49);
  assert.deepEqual(db.prepare('SELECT * FROM task_run_ledger ORDER BY id').all(), before);
  db.exec('DROP TRIGGER reject_v50');
  applyMigrations(db);
  db.close();
  db = new Database(path);
  t.after(() => db.close());
  applyMigrations(db);
  assert.deepEqual(db.prepare('SELECT * FROM task_run_ledger ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_version WHERE version = 50').get().count, 1);
  assert.deepEqual(
    new RunLedger(db).queryBySubject('kept', 'pr:a/b#1', 2).map((row) => row.duration_ms),
    [2, 1],
  );
});
