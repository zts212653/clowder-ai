import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../../dist/domains/memory/schema.js';

it('upgrades v77 persisted schedule records without losing checkpoints, indexes, or append-only audit guards', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'memory.sqlite');
  let db = new Database(file);
  // Retain all pre-v78 tables/repair fences, then restore only the historical
  // schedule tables this migration changes. A version number alone is not a v77 database.
  applyMigrations(db);
  db.exec(
    'DROP TABLE schedule_mutation_proposals; DROP TABLE schedule_mutation_audit; DELETE FROM schema_version WHERE version >= 78;',
  );
  db.exec(readFileSync(new URL('./fixtures/schema-v77-schedule.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, 77);
  db.prepare(`INSERT INTO schedule_mutation_proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'old-proposal',
    'owner',
    'codex-sol',
    'create',
    '{"kind":"create"}',
    'applying',
    '{"state":"anchored"}',
    '{"kind":"create","taskId":"old-task","appliedAt":2}',
    1,
    2,
    null,
    null,
    null,
    null,
    null,
  );
  db.prepare('INSERT INTO schedule_mutation_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'old-audit',
    'owner',
    'cvo',
    'owner',
    'create',
    'old-task',
    '{"unchanged":true}',
    1,
  );
  const records = db.prepare('SELECT * FROM schedule_mutation_proposals').all();
  const audits = db.prepare('SELECT * FROM schedule_mutation_audit').all();
  const schemas = () =>
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE tbl_name IN ('schedule_mutation_proposals', 'schedule_mutation_audit') AND type IN ('index', 'trigger') ORDER BY name",
      )
      .all();
  const schemaBefore = schemas();
  db.close();
  db = new Database(file);
  try {
    applyMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM schedule_mutation_proposals').all(), records);
    assert.deepEqual(db.prepare('SELECT * FROM schedule_mutation_audit').all(), audits);
    assert.deepEqual(schemas(), schemaBefore);
    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_version').get().version, CURRENT_SCHEMA_VERSION);
    assert.throws(() => db.exec("UPDATE schedule_mutation_audit SET detail_json = '{}'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM schedule_mutation_audit'), /append-only/);
    db.exec("UPDATE schedule_mutation_proposals SET mutation_kind = 'update'");
    db.prepare('INSERT INTO schedule_mutation_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'new-audit',
      'owner',
      'cvo',
      'owner',
      'update',
      'old-task',
      '{}',
      3,
    );
    applyMigrations(db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schedule_mutation_audit').get().n, 2);
    assert.throws(() => db.exec("UPDATE schedule_mutation_proposals SET mutation_kind = 'other'"), /CHECK/);
  } finally {
    db.close();
  }
});
