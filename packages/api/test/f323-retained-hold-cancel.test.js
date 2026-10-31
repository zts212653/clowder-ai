import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// The generic job ledger is independent of this legacy wake store. Keep the
// fixture's filesystem namespace private even in the full concurrent Redis suite.
const priorDataRoot = process.env.CAT_CAFE_DATA_DIR;
const fixtureDataRoot = mkdtempSync(join(tmpdir(), 'managed-projection-fixture-'));
before(() => {
  process.env.CAT_CAFE_DATA_DIR = fixtureDataRoot;
});
after(() => {
  if (priorDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
  else process.env.CAT_CAFE_DATA_DIR = priorDataRoot;
  rmSync(fixtureDataRoot, { recursive: true, force: true });
});

import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { ManagedCommandWakeRecoverySweep } from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { listManagedCommandExecutions } from '../dist/domains/cats/services/agents/invocation/active-execution-service.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { ScheduleMutationProposalStore } from '../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { registerHoldBallCancelRoutes } from '../dist/routes/callback-hold-ball-cancel-routes.js';

const taskId = 'hold-ball-legacy-refused';
function fixture(t, alter = () => {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  applyMigrations(db);
  // This schema survived the Phase B rollback. Keep its real deletion boundary.
  db.exec(`ALTER TABLE dynamic_task_defs ADD COLUMN managed_resource_json TEXT;
    CREATE TRIGGER dynamic_resource_history_no_delete BEFORE DELETE ON dynamic_task_defs
    WHEN OLD.managed_resource_json IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Managed command resource requires a retained owner tombstone'); END`);
  const store = new DynamicTaskStore(db);
  const task = {
    id: taskId,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 100 },
    params: {
      triggerUserId: 'owner',
      targetCatId: 'codex-astra',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'cancel_requested',
        createdBy: 'hold-ball:codex-astra',
        cancellationRequestedAt: 20,
        cancelledBy: 'cvo:owner',
        managedCommand: {
          state: 'command_running',
          command: 'pnpm alpha:start',
          startedAt: 10,
          pid: null,
          admissionFact: 'Command did not start',
          admissionFactAppended: true,
        },
      },
    },
    display: { label: 'retained hold', category: 'system' },
    deliveryThreadId: 'thread-old',
    enabled: false,
    createdBy: 'hold-ball:codex-astra',
    createdAt: '2026-10-06T14:39:19.602Z',
  };
  const result = {
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    tailOutput: 'provider_execution_refused:effect_closed_or_consumed',
  };
  const resource = {
    v: 1,
    revision: 3,
    state: 'terminal',
    launchClosed: true,
    nativeEffects: [],
    resourceRef: 'managed-command:legacy',
    executionRef: 'execution-original',
    pendingIntentRef: 'turnexec:execution-original',
    resultRef: `managed-result:${taskId}`,
    outcome: 'not_started',
    businessResult: { resultRef: `managed-result:${taskId}`, outcome: 'not_started', result },
  };
  alter(task, resource);
  store.insert(task, 'strict');
  db.prepare('UPDATE dynamic_task_defs SET managed_resource_json=? WHERE id=?').run(JSON.stringify(resource), taskId);
  const originalResource = db.prepare('SELECT managed_resource_json FROM dynamic_task_defs WHERE id=?').get(taskId);
  const messages = [],
    cancels = [],
    unregistered = [];
  const deps = {
    ownerUserId: 'owner',
    dynamicTaskStore: store,
    scheduleMutationAuditStore: new ScheduleMutationProposalStore(db),
    taskRunner: {
      unregister(id) {
        unregistered.push(id);
      },
    },
    messageStore: {
      async append(m) {
        messages.push(m);
        return { id: `m${messages.length}`, ...m };
      },
      async getByIdempotencyKey() {
        return null;
      },
    },
    socketManager: { broadcastToRoom() {} },
    threadStore: {
      get() {
        return { id: 'thread-old', createdBy: 'owner' };
      },
      list(userId) {
        return userId === 'owner' ? [{ id: 'thread-old', createdBy: 'owner' }] : [];
      },
    },
    cancelManagedWakeIfTaskMatches(id) {
      cancels.push(id);
      return false;
    },
    invocationRecordStore: {
      async getByIdempotencyKey() {
        return null;
      },
    },
    getInvokeTrigger() {
      throw new Error('never wake or rerun a cancelled no-start command');
    },
  };
  return { db, store, deps, originalResource, messages, cancels, unregistered };
}
async function appFor(t, deps) {
  const app = Fastify();
  registerHoldBallCancelRoutes(app, deps);
  await app.ready();
  t.after(() => app.close());
  return app;
}
function cancel(app, user = 'owner') {
  return app.inject({
    method: 'DELETE',
    url: `/api/callbacks/hold-ball/${taskId}`,
    headers: { 'x-cat-cafe-user': user },
  });
}

test('original cancelled no-start can be stopped without deleting its retained resource or cancellation history', async (t) => {
  const f = fixture(t);
  const app = await appFor(t, f.deps);
  const response = await cancel(app);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().cancelled, true);
  const task = f.store.getById(taskId);
  assert.equal(task.enabled, false);
  assert.equal(task.params.holdLifecycle.managedCommand.state, 'not_started');
  assert.equal(task.params.holdLifecycle.cancellationRequestedAt, 20);
  assert.equal(task.params.holdLifecycle.cancelledBy, 'cvo:owner');
  assert.deepEqual(
    f.db.prepare('SELECT managed_resource_json FROM dynamic_task_defs WHERE id=?').get(taskId),
    f.originalResource,
  );
  assert.deepEqual(listManagedCommandExecutions([task]), []);
  assert.equal((await cancel(app)).statusCode, 200, 'stale UI retry is idempotent');
  assert.equal(f.messages.length, 1, 'retry does not duplicate cancellation visibility');
  assert.deepEqual(f.cancels, [], 'never touch the newer runner in the same thread');
});

test('startup settles the proven cancelled no-start without sending a completion wake; later live work stays visible', async (t) => {
  const f = fixture(t);
  const sweep = new ManagedCommandWakeRecoverySweep(f.deps);
  const newTask = { ...structuredClone(f.store.getById(taskId)), id: 'hold-ball-new-live', enabled: true };
  newTask.params.holdLifecycle.status = 'active';
  newTask.params.holdLifecycle.managedCommand.startedAt = 999;
  newTask.params.holdLifecycle.managedCommand.pid = 1234;
  f.store.insert(newTask, 'strict');
  await sweep.runOnce();
  await sweep.runOnce();
  assert.equal(f.store.getById(taskId).params.holdLifecycle.managedCommand.state, 'not_started');
  assert.deepEqual(
    listManagedCommandExecutions(f.store.getAll()).map((x) => [x.taskId, x.startedAt]),
    [['hold-ball-new-live', 999]],
  );
  assert.deepEqual(f.messages, []);
  assert.deepEqual(
    f.db.prepare('SELECT managed_resource_json FROM dynamic_task_defs WHERE id=?').get(taskId),
    f.originalResource,
  );
});

for (const [name, alter] of [
  [
    'started effect',
    (_t, r) => {
      r.nativeEffects = [{ state: 'running' }];
    },
  ],
  [
    'open launch',
    (_t, r) => {
      r.launchClosed = false;
    },
  ],
  [
    'wrong task',
    (_t, r) => {
      r.businessResult.resultRef = 'managed-result:other';
    },
  ],
  [
    'missing structured result',
    (_t, r) => {
      delete r.businessResult;
    },
  ],
  [
    'contradictory exit',
    (_t, r) => {
      r.businessResult.result.exitCode = 0;
    },
  ],
]) {
  test(`retained ${name} stays pending, without guessing from pid or prose`, async (t) => {
    const f = fixture(t, alter);
    const app = await appFor(t, f.deps);
    const response = await cancel(app);
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().cancelled, false);
    await new ManagedCommandWakeRecoverySweep(f.deps).runOnce();
    assert.equal(f.store.getById(taskId).params.holdLifecycle.managedCommand.state, 'command_running');
    assert.equal(listManagedCommandExecutions(f.store.getAll()).length, 1);
    assert.deepEqual(
      f.db.prepare('SELECT managed_resource_json FROM dynamic_task_defs WHERE id=?').get(taskId),
      f.originalResource,
    );
  });
}

test('unauthorized cancellation does not reconcile or mutate the retained task', async (t) => {
  const f = fixture(t);
  const before = f.store.getById(taskId);
  const app = await appFor(t, f.deps);
  assert.equal((await cancel(app, 'other-user')).statusCode, 403);
  assert.deepEqual(f.store.getById(taskId), before);
});

test('the retained proof cannot settle a replacement using a stale task snapshot', (t) => {
  const f = fixture(t);
  const old = f.store.getById(taskId);
  const next = structuredClone(old.params);
  next.holdLifecycle.managedCommand.startedAt = 500;
  f.store.updateParamsIfCurrent(taskId, old.params, next);
  assert.equal(f.store.reconcileRetainedManagedCommand(old), 'conflict');
  assert.deepEqual(f.store.getById(taskId).params, next);
});

test('fresh schemas require no legacy column or mutation and keep ordinary managed state', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  applyMigrations(db);
  const f = fixture(t);
  const task = f.store.getById(taskId);
  const store = new DynamicTaskStore(db);
  store.insert(task, 'strict');
  assert.equal(store.reconcileRetainedManagedCommand(task), 'absent');
  assert.deepEqual(store.getById(taskId), task);
  assert.equal(
    db
      .prepare('PRAGMA table_info(dynamic_task_defs)')
      .all()
      .some((x) => x.name === 'managed_resource_json'),
    false,
  );
});

test('malformed retained proof and a real pid cannot be interpreted as no-start', async (t) => {
  for (const invalidJson of [true, false]) {
    const f = fixture(t, (task) => {
      if (!invalidJson) task.params.holdLifecycle.managedCommand.pid = 321;
    });
    if (invalidJson)
      f.db.prepare('UPDATE dynamic_task_defs SET managed_resource_json=? WHERE id=?').run('{broken', taskId);
    const before = f.store.getById(taskId);
    assert.equal(f.store.reconcileRetainedManagedCommand(before), 'pending');
    assert.deepEqual(f.store.getById(taskId), before);
  }
});
