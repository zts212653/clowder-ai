import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations, SCHEMA_V5 } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';

// --- Task 1: Schema V8 ---

test('SCHEMA_V8 creates dynamic_task_defs table', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dynamic_task_defs'").all();
  assert.equal(tables.length, 1);
  db.close();
});

test('SCHEMA_V8 adds error_summary column to task_run_ledger', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const cols = db.prepare('PRAGMA table_info(task_run_ledger)').all();
  const errorSummary = cols.find((c) => c.name === 'error_summary');
  assert.ok(errorSummary, 'error_summary column should exist');
  db.close();
});

test('SCHEMA_V29 adds scheduler timing columns to task_run_ledger', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const cols = db.prepare('PRAGMA table_info(task_run_ledger)').all();
  const names = new Set(cols.map((c) => c.name));
  for (const name of ['scheduled_at', 'fired_at', 'lateness_ms', 'missed_slots', 'trigger_kind', 'misfire_policy']) {
    assert.ok(names.has(name), `${name} column should exist`);
  }
  db.close();
});

test('dynamic_task_defs has correct columns', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const cols = db.prepare('PRAGMA table_info(dynamic_task_defs)').all();
  const names = cols.map((c) => c.name);
  assert.ok(names.includes('id'));
  assert.ok(names.includes('template_id'));
  assert.ok(names.includes('trigger_json'));
  assert.ok(names.includes('params_json'));
  assert.ok(names.includes('display_json'));
  assert.ok(names.includes('delivery_thread_id'));
  assert.ok(names.includes('enabled'));
  assert.ok(names.includes('created_by'));
  assert.ok(names.includes('created_at'));
  assert.ok(names.includes('owner_auth_provenance'));
  db.close();
});

test('V44 preserves legacy tasks and private owner auth across a database restart', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-v44-owner-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'scheduler.sqlite');
  let db = new Database(dbPath);
  db.exec(SCHEMA_V5);
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version, applied_at) VALUES (43, '2026-09-01T00:00:00Z');
    CREATE TABLE dynamic_task_defs (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      params_json TEXT NOT NULL,
      entrusted_work_reevaluation_json TEXT,
      display_json TEXT NOT NULL,
      delivery_thread_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO dynamic_task_defs (
      id, template_id, trigger_json, params_json, entrusted_work_reevaluation_json,
      display_json, delivery_thread_id, enabled, created_by, created_at
    ) VALUES (
      'legacy-task', 'reminder', '{"type":"once","fireAt":1000}', '{"message":"legacy"}', NULL,
      '{"label":"Legacy","category":"system","description":"legacy"}', 'thread-legacy', 1,
      'hold-ball:codex-sol', '2026-09-01T00:00:00Z'
    );
  `);

  applyMigrations(db);
  let migrated = new DynamicTaskStore(db);
  assert.equal(migrated.getById('legacy-task').params.message, 'legacy');
  assert.equal(migrated.getPrivateOwnerAuthProvenance('legacy-task'), 'unknown');
  migrated.insert({ ...SAMPLE_DEF, id: 'strict-task' }, 'strict');
  db.close();

  db = new Database(dbPath);
  migrated = new DynamicTaskStore(db);
  assert.equal(migrated.getPrivateOwnerAuthProvenance('legacy-task'), 'unknown');
  assert.equal(migrated.getPrivateOwnerAuthProvenance('strict-task'), 'strict');
  assert.equal(Object.hasOwn(migrated.getById('strict-task'), 'ownerAuthProvenance'), false);
  db.close();
});

// --- Task 2: DynamicTaskStore CRUD ---

const SAMPLE_DEF = {
  id: 'dyn-001',
  templateId: 'reminder',
  trigger: { type: 'cron', expression: '0 9 * * *' },
  params: { message: '检查 backlog' },
  display: { label: '每日提醒', category: 'system', description: '每天九点提醒检查 backlog' },
  deliveryThreadId: 'thread-abc',
  enabled: true,
  createdBy: 'opus',
  createdAt: '2026-03-27T03:00:00Z',
};

describe('DynamicTaskStore', () => {
  let db;
  let store;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    store = new DynamicTaskStore(db);
  });

  test('insert + getAll round-trips', () => {
    store.insert(SAMPLE_DEF);
    const all = store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'dyn-001');
    assert.equal(all[0].templateId, 'reminder');
    assert.deepEqual(all[0].trigger, { type: 'cron', expression: '0 9 * * *' });
    assert.deepEqual(all[0].params, { message: '检查 backlog' });
    assert.equal(all[0].deliveryThreadId, 'thread-abc');
    assert.equal(all[0].enabled, true);
  });

  test('managed-command owner auth is durable, immutable, and absent from task projections', () => {
    store.insert(SAMPLE_DEF, 'strict');

    assert.equal(store.getPrivateOwnerAuthProvenance('dyn-001'), 'strict');
    assert.equal(Object.hasOwn(store.getById('dyn-001'), 'ownerAuthProvenance'), false);
    assert.equal(Object.hasOwn(store.getById('dyn-001').params, 'ownerAuthProvenance'), false);

    const observed = store.getById('dyn-001').params;
    assert.equal(store.updateParams('dyn-001', { ...observed, message: 'updated' }), true);
    store.upsert({ ...SAMPLE_DEF, params: { message: 'upserted' } });
    assert.equal(
      store.getPrivateOwnerAuthProvenance('dyn-001'),
      'strict',
      'ordinary lifecycle writes and public schedule upserts cannot rewrite private auth provenance',
    );

    assert.equal(store.remove('dyn-001'), true);
    assert.equal(store.getPrivateOwnerAuthProvenance('dyn-001'), 'unknown');
  });

  test('legacy dynamic tasks without private owner auth fail closed to unknown', () => {
    store.insert(SAMPLE_DEF);
    assert.equal(store.getPrivateOwnerAuthProvenance('dyn-001'), 'unknown');
  });

  test('rejects an invalid private owner auth producer value before persistence', () => {
    assert.throws(() => store.insert(SAMPLE_DEF, 'forged'), /ownerAuthProvenance must be explicit/);
    assert.equal(store.getById('dyn-001'), null);
  });

  test('getById returns matching def', () => {
    store.insert(SAMPLE_DEF);
    const def = store.getById('dyn-001');
    assert.equal(def.id, 'dyn-001');
  });

  test('getById returns null for missing', () => {
    const def = store.getById('nonexistent');
    assert.equal(def, null);
  });

  test('remove deletes row', () => {
    store.insert(SAMPLE_DEF);
    const removed = store.remove('dyn-001');
    assert.equal(removed, true);
    assert.equal(store.getAll().length, 0);
  });

  test('remove returns false for missing', () => {
    assert.equal(store.remove('nonexistent'), false);
  });

  test('setEnabled toggles flag', () => {
    store.insert(SAMPLE_DEF);
    store.setEnabled('dyn-001', false);
    assert.equal(store.getById('dyn-001').enabled, false);
    store.setEnabled('dyn-001', true);
    assert.equal(store.getById('dyn-001').enabled, true);
  });

  test('updateParamsIfCurrent allows one lifecycle transition and rejects a stale replay', () => {
    store.insert(SAMPLE_DEF);
    const observed = store.getById('dyn-001').params;
    const next = { ...observed, terminalFence: { state: 'dispatch_pending', generation: 1 } };

    assert.equal(store.updateParamsIfCurrent('dyn-001', observed, next), true);
    assert.equal(store.updateParamsIfCurrent('dyn-001', observed, { message: 'stale replay' }), false);
    assert.deepEqual(store.getById('dyn-001').params, next);
  });

  test('insert rejects duplicate id', () => {
    store.insert(SAMPLE_DEF);
    assert.throws(() => store.insert(SAMPLE_DEF), /UNIQUE|constraint/i);
  });

  test('findByDeliveryThreadAndCreatedBy returns matching tasks', () => {
    const hold1 = {
      ...SAMPLE_DEF,
      id: 'hold-ball-001',
      templateId: 'reminder',
      deliveryThreadId: 'thread-xyz',
      createdBy: 'hold-ball:codex',
    };
    const hold2 = {
      ...SAMPLE_DEF,
      id: 'hold-ball-002',
      templateId: 'reminder',
      deliveryThreadId: 'thread-xyz',
      createdBy: 'hold-ball:codex',
      createdAt: '2026-03-27T04:00:00Z',
    };
    const otherCat = {
      ...SAMPLE_DEF,
      id: 'hold-ball-003',
      deliveryThreadId: 'thread-xyz',
      createdBy: 'hold-ball:opus',
    };
    const otherThread = {
      ...SAMPLE_DEF,
      id: 'hold-ball-004',
      deliveryThreadId: 'thread-other',
      createdBy: 'hold-ball:codex',
    };
    store.insert(hold1);
    store.insert(hold2);
    store.insert(otherCat);
    store.insert(otherThread);

    const results = store.findByDeliveryThreadAndCreatedBy('thread-xyz', 'hold-ball:codex');
    assert.equal(results.length, 2);
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes('hold-ball-001'));
    assert.ok(ids.includes('hold-ball-002'));
  });

  test('findByDeliveryThreadAndCreatedBy returns empty array when no matches', () => {
    store.insert(SAMPLE_DEF);
    const results = store.findByDeliveryThreadAndCreatedBy('nonexistent-thread', 'hold-ball:codex');
    assert.deepEqual(results, []);
  });

  test('#415: once trigger round-trips correctly', () => {
    const fireAt = Date.now() + 120_000;
    const onceDef = {
      ...SAMPLE_DEF,
      id: 'dyn-once-rt',
      trigger: { type: 'once', fireAt },
    };
    store.insert(onceDef);
    const loaded = store.getById('dyn-once-rt');
    assert.equal(loaded.trigger.type, 'once');
    assert.equal(loaded.trigger.fireAt, fireAt);
  });

  test('upsert replaces a managed definition without changing its stable identity', () => {
    store.upsert(SAMPLE_DEF);
    store.upsert({
      ...SAMPLE_DEF,
      trigger: { type: 'cron', expression: '30 22 * * 1,3,5', timezone: 'America/Los_Angeles' },
      params: { targetCatId: 'codex-sol', managedBy: 'f255-cat-life' },
      enabled: false,
    });

    const all = store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, SAMPLE_DEF.id);
    assert.deepEqual(all[0].trigger, {
      type: 'cron',
      expression: '30 22 * * 1,3,5',
      timezone: 'America/Los_Angeles',
    });
    assert.equal(all[0].enabled, false);
    assert.equal(all[0].params.managedBy, 'f255-cat-life');
  });
});
