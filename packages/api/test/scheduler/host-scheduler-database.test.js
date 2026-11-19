import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { CURRENT_SCHEMA_VERSION, FTS_TRIGGER_STATEMENTS, SCHEMA_V1 } from '../../dist/domains/memory/schema.js';
import { openHostSchedulerDatabase } from '../../dist/infrastructure/scheduler/host-scheduler-database.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';

function recordRun(ledger, subject) {
  ledger.record({
    task_id: 'ordinary-task',
    subject_key: subject,
    outcome: 'RUN_DELIVERED',
    signal_summary: null,
    duration_ms: 1,
    started_at: '2026-11-18T00:00:00.000Z',
    assigned_cat_id: null,
  });
}

test('Host scheduler owns its connection before and after the memory store runs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'host-scheduler-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'evidence.sqlite');

  const schedulerDb = await openHostSchedulerDatabase(dbPath);
  try {
    const scheduler = new RunLedger(schedulerDb);
    recordRun(scheduler, 'before-memory');

    const memory = new SqliteEvidenceStore(dbPath);
    await memory.initialize();
    try {
      assert.notEqual(memory.getDb(), schedulerDb);
      assert.deepEqual(new RunLedger(memory.getDb()).stats('ordinary-task'), {
        total: 1,
        delivered: 1,
        failed: 0,
        skipped: 0,
      });
    } finally {
      memory.close();
    }

    recordRun(scheduler, 'after-memory');
    assert.deepEqual(
      scheduler.query('ordinary-task', 5).map((row) => row.subject_key),
      ['after-memory', 'before-memory'],
    );
  } finally {
    schedulerDb.close();
  }

  const reopened = await openHostSchedulerDatabase(dbPath);
  try {
    assert.equal(new RunLedger(reopened).stats('ordinary-task').total, 2);
  } finally {
    reopened.close();
  }
});

test('Host scheduler refuses a future legacy database without applying migrations', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'host-scheduler-unknown-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'evidence.sqlite');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version VALUES (999, '2026-11-18T00:00:00.000Z');
  `);
  seed.close();

  await assert.rejects(openHostSchedulerDatabase(dbPath), /unsupported legacy evidence schema 999/i);
  const snapshot = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(snapshot.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all(), [
      'schema_version',
    ]);
  } finally {
    snapshot.close();
  }
});

test('a current marker does not hide an incomplete shared layout', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'host-scheduler-incomplete-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'evidence.sqlite');
  const seed = new Database(dbPath);
  seed.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  seed.prepare('INSERT INTO schema_version VALUES (?, ?)').run(CURRENT_SCHEMA_VERSION, '2026-11-18T00:00:00.000Z');
  seed.close();

  await assert.rejects(openHostSchedulerDatabase(dbPath), /no such table: evidence_docs/);
});

test('legacy preparation backs up the original schema and records before migrating', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'host-scheduler-legacy-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'evidence.sqlite');
  const seed = new Database(dbPath);
  seed.exec(SCHEMA_V1);
  for (const trigger of FTS_TRIGGER_STATEMENTS) seed.exec(trigger);
  seed.exec(`
    INSERT INTO schema_version VALUES (1, '2026-11-18T00:00:00.000Z');
    INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
    VALUES ('test:legacy', 'lesson', 'active', 'Legacy record', '2026-11-18T00:00:00.000Z');
  `);
  seed.close();

  const db = await openHostSchedulerDatabase(dbPath);
  try {
    assert.equal(db.prepare('SELECT MAX(version) FROM schema_version').pluck().get(), CURRENT_SCHEMA_VERSION);
    assert.equal(
      db.prepare('SELECT title FROM evidence_docs WHERE anchor = ?').pluck().get('test:legacy'),
      'Legacy record',
    );
    recordRun(new RunLedger(db), 'after-legacy-migration');
  } finally {
    db.close();
  }

  const backupDirs = (await readdir(dir)).filter((entry) => entry.startsWith('.legacy-evidence-backup-'));
  assert.equal(backupDirs.length, 1);
  const backup = new Database(join(dir, backupDirs[0], 'evidence.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(backup.prepare('SELECT MAX(version) FROM schema_version').pluck().get(), 1);
    assert.equal(
      backup.prepare('SELECT title FROM evidence_docs WHERE anchor = ?').pluck().get('test:legacy'),
      'Legacy record',
    );
  } finally {
    backup.close();
  }
});

test('a failed legacy migration can resume without replacing the original backup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'host-scheduler-legacy-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'evidence.sqlite');
  const seed = await openHostSchedulerDatabase(dbPath);
  try {
    recordRun(new RunLedger(seed), 'before-failed-migration');
    seed.exec(`
      INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
        VALUES ('test:migration-retry', 'lesson', 'active', 'Durable legacy evidence', '2026-11-18T00:00:00.000Z');
      DELETE FROM schema_version WHERE version > 68;
      ALTER TABLE dynamic_task_defs DROP COLUMN tool_execution_policy_json;
      CREATE TRIGGER abort_v70 BEFORE INSERT ON schema_version WHEN NEW.version = 70 BEGIN
        SELECT RAISE(ABORT, 'injected V70 migration failure');
      END;
    `);
  } finally {
    seed.close();
  }

  await assert.rejects(openHostSchedulerDatabase(dbPath), /injected V70 migration failure/);
  const [originalBackup] = await readdir(dir).then((entries) =>
    entries.filter((entry) => entry.startsWith('.legacy-evidence-backup-')),
  );
  assert.ok(originalBackup);
  const interrupted = new Database(dbPath, { fileMustExist: true });
  try {
    assert.equal(interrupted.prepare('SELECT MAX(version) FROM schema_version').pluck().get(), 69);
    assert.throws(() => interrupted.prepare('SELECT tool_execution_policy_json FROM dynamic_task_defs'), /no such column/);
    interrupted.exec('DROP TRIGGER abort_v70');
  } finally {
    interrupted.close();
  }

  const recovered = await openHostSchedulerDatabase(dbPath);
  const backup = new Database(join(dir, originalBackup, 'evidence.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(recovered.prepare('SELECT MAX(version) FROM schema_version').pluck().get(), CURRENT_SCHEMA_VERSION);
    assert.equal(backup.prepare('SELECT MAX(version) FROM schema_version').pluck().get(), 68);
    for (const db of [recovered, backup]) {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(new RunLedger(db).stats('ordinary-task').total, 1);
      assert.equal(
        db.prepare('SELECT title FROM evidence_docs WHERE anchor = ?').pluck().get('test:migration-retry'),
        'Durable legacy evidence',
      );
    }
    recordRun(new RunLedger(recovered), 'after-retry');
    assert.equal(new RunLedger(recovered).stats('ordinary-task').total, 2);
  } finally {
    backup.close();
    recovered.close();
  }
});
