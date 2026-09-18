// Regression (2026-09-07): schema_version is one counter shared by the upstream and fork lineages.
// A DB the fork had already stamped ≥40 skipped upstream's V40 block, so
// dynamic_task_defs.entrusted_work_reevaluation_json never landed on 25/26 live DBs and every
// DynamicTaskStore insert (hold_ball, scheduled tasks) failed with SQLITE_ERROR.
// Column presence is the truth, not the stamp: applyMigrations must reconcile the ladder's columns.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../dist/domains/memory/schema.js';

const LADDER_COLUMNS = ['entrusted_work_reevaluation_json', 'retry_attempts'];

function columnsOf(db) {
  return db
    .prepare('PRAGMA table_info(dynamic_task_defs)')
    .all()
    .map((column) => column.name);
}

function stampedVersion(db) {
  return db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
}

/** The exact write path that failed live (DynamicTaskStore.insert column list). */
function insertLikeDynamicTaskStore(db) {
  db.prepare(
    `INSERT INTO dynamic_task_defs (id, template_id, trigger_json, params_json, entrusted_work_reevaluation_json, display_json, delivery_thread_id, enabled, created_by, created_at, retry_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('hold-1', 'hold-ball', '{}', '{}', null, '{}', null, 1, 'cat-test', new Date().toISOString(), 0);
}

describe('applyMigrations · dynamic_task_defs column reconciliation', () => {
  test('a fresh DB receives every ladder column', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    for (const name of LADDER_COLUMNS) assert.ok(columnsOf(db).includes(name), `${name} missing on fresh DB`);
    insertLikeDynamicTaskStore(db);
  });

  test('a DB stamped past V40 whose V40 column never landed is repaired without forging a stamp', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    db.exec('ALTER TABLE dynamic_task_defs DROP COLUMN entrusted_work_reevaluation_json');
    const stamp = stampedVersion(db);
    assert.ok(stamp >= 40, `expected a post-V40 stamp, got ${stamp}`);
    assert.ok(!columnsOf(db).includes('entrusted_work_reevaluation_json'));
    assert.throws(() => insertLikeDynamicTaskStore(db), /no column named entrusted_work_reevaluation_json/);

    applyMigrations(db);

    assert.ok(columnsOf(db).includes('entrusted_work_reevaluation_json'), 'ladder column not reconciled');
    assert.equal(stampedVersion(db), stamp, 'reconciliation must not forge a new schema_version stamp');
    insertLikeDynamicTaskStore(db);
  });

  test('a healthy DB is left untouched on repeated passes', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const before = columnsOf(db);
    const stampBefore = stampedVersion(db);
    applyMigrations(db);
    applyMigrations(db);
    assert.deepEqual(columnsOf(db), before);
    // Stamp-neutral by contract: reconciliation repairs columns without ever
    // advancing the shared counter, so assert it did not move — not a literal,
    // which would break on every ladder bump from either lineage.
    assert.equal(stampedVersion(db), stampBefore);
  });
});
