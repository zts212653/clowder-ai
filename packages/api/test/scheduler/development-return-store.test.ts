import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { isVisibleDynamicTaskDef } from '../../src/routes/schedule-route-support.js';

test('return registration is private, durable in the same execution record, and CAS fenced', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const store = new DynamicTaskStore(db);
  const state = {
    v: 1,
    registrationId: 'return-1',
    ownerUserId: 'owner',
    ownerThreadId: 'original',
    ownerCatId: 'codex-sol',
    taskRef: 'task:work:original-task',
    observedRevision: 3,
    proposalId: 'proposal',
    executionThreadId: 'child',
    reporterCatIds: ['codex-sol'],
    sourceActionRef: 'message:authorized',
    sourceMessageRevision: `sha256:${'a'.repeat(64)}`,
    expectedSignal: 'terminal_report',
    slaUntil: 5000,
    registeredAt: 1000,
    status: 'waiting',
  };
  const definition = {
    id: 'return-1',
    templateId: 'development-terminal-return',
    trigger: { type: 'once', fireAt: 5000 },
    params: {},
    display: { label: 'Wait for original work result', category: 'system' },
    deliveryThreadId: 'original',
    createdBy: 'codex-sol',
    createdAt: new Date(1000).toISOString(),
    enabled: true,
  };
  store.insert(definition, 'strict', state);
  assert.deepEqual(store.getPrivateExecutionReturn('return-1'), state);
  assert.deepEqual(store.getById('return-1').params, {});
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT params_json FROM dynamic_task_defs WHERE id = ?').get('return-1').params_json),
    {},
    'old public params readers must not expose the private return',
  );
  assert.equal(JSON.stringify(store.getAll()).includes('original-task'), false);
  assert.equal(
    isVisibleDynamicTaskDef(store.getById('return-1')),
    false,
    'internal return is not a business Schedule item',
  );
  const fresh = new DynamicTaskStore(db);
  assert.deepEqual(fresh.getPrivateExecutionReturn('return-1'), state);
  assert.throws(
    () => db.prepare('UPDATE dynamic_task_defs SET enabled = 0 WHERE id = ?').run('return-1'),
    /private return/,
    'legacy disable must not silently strand an active owner return',
  );
  assert.equal(
    fresh.replacePrivateExecutionReturn('return-1', state, {
      ...state,
      status: 'delivering',
      deliveryRevision: 5,
      reason: 'deadline_review',
    }),
    true,
  );
  assert.equal(store.replacePrivateExecutionReturn('return-1', state, { ...state, status: 'ready' }), false);
  const delivering = fresh.getPrivateExecutionReturn('return-1');
  assert.throws(
    () => fresh.replacePrivateExecutionReturn('return-1', delivering, { ...delivering, deliveryRevision: 6 }),
    /revision is immutable/,
  );
  assert.throws(() => db.prepare('DELETE FROM dynamic_task_defs WHERE id = ?').run('return-1'), /private return/);
  assert.throws(
    () => db.prepare("UPDATE dynamic_task_defs SET template_id = 'reminder' WHERE id = ?").run('return-1'),
    /identity/,
  );
  assert.throws(
    () => fresh.replacePrivateExecutionReturn('return-1', delivering, { ...delivering, ownerThreadId: 'elsewhere' }),
    /identity/,
  );
  fresh.remove('return-1');
  assert.equal(fresh.getPrivateExecutionReturn('return-1').status, 'retired');
  assert.equal(fresh.getById('return-1').enabled, false);
  assert.throws(() => db.prepare('UPDATE dynamic_task_defs SET enabled = 1 WHERE id = ?').run('return-1'), /terminal/);
  const retired = fresh.getPrivateExecutionReturn('return-1');
  assert.throws(
    () => fresh.replacePrivateExecutionReturn('return-1', retired, { ...retired, status: 'waiting' }),
    /terminal/,
  );
  db.close();
});
