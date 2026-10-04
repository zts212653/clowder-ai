import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';

test('V51 survives restart, rolls back atomically on failure, and leaves canonical task bytes unchanged', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'managed-candidates-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.sqlite');
  let db = new Database(path);
  applyMigrations(db);
  db.exec('DROP INDEX idx_dynamic_managed_candidates; DELETE FROM schema_version WHERE version >= 51');
  new DynamicTaskStore(db).insert({
    id: 'live-retired',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 1 },
    params: {
      triggerUserId: 'u',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'retired_by_replacement',
        managedCommand: { state: 'command_running' },
      },
    },
    display: { label: 'gate', category: 'system' },
    deliveryThreadId: 't',
    enabled: false,
    createdBy: 'hold-ball:codex-astra',
    createdAt: '2026-10-03',
  });
  const before = db.prepare('SELECT * FROM dynamic_task_defs').all();
  db.exec(
    "CREATE TRIGGER fail_v51 BEFORE INSERT ON schema_version WHEN NEW.version = 51 BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  assert.throws(() => applyMigrations(db), /injected failure/);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='idx_dynamic_managed_candidates'").get(),
    undefined,
  );
  assert.equal(db.prepare('SELECT version FROM schema_version WHERE version=51').get(), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs').all(), before);
  db.exec('DROP TRIGGER fail_v51');
  db.close();
  db = new Database(path);
  applyMigrations(db);
  assert.deepEqual(db.prepare('SELECT * FROM dynamic_task_defs').all(), before);
  assert.equal(new DynamicTaskStore(db).listManagedCommandCandidates()[0]?.id, 'live-retired');
  assert.equal(new DynamicTaskStore(db).getAll().length, 1, 'older read path still accepts the database');
  db.close();
});
