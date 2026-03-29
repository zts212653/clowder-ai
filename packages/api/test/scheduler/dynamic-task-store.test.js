import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
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

  test('insert rejects duplicate id', () => {
    store.insert(SAMPLE_DEF);
    assert.throws(() => store.insert(SAMPLE_DEF), /UNIQUE|constraint/i);
  });
});
