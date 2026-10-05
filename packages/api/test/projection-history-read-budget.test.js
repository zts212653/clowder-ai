import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { parseManagedCommandWakeTask } from '../dist/domains/ball-custody/managed-command-wake-task-projection.js';
import { listManagedCommandExecutions } from '../dist/domains/cats/services/agents/invocation/active-execution-service.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { MANAGED_COMMAND_CANDIDATE_FILTER } from '../dist/infrastructure/scheduler/managed-command-candidate-schema.js';

test('managed selector skips unrelated history but keeps retired running and completion evidence', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const store = new DynamicTaskStore(db);
  const task = (id, params, enabled = true) => ({
    id: `hold-ball-${id}`,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 1 },
    params: { triggerUserId: 'u', targetCatId: 'codex-astra', ...params },
    display: { label: id, category: 'system' },
    deliveryThreadId: 't',
    enabled,
    createdBy: 'hold-ball:codex-astra',
    createdAt: '2026-10-03',
  });
  const managed = (state, status = 'active') => ({
    holdLifecycle: {
      mode: 'wake_when',
      status,
      createdBy: 'hold-ball:codex-astra',
      managedCommand: { state, command: 'pnpm gate', startedAt: 1 },
    },
  });
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) store.insert(task(`old-${i}`, { longText: 'x'.repeat(1000) }, false));
    store.insert(task('live', managed('command_running')));
    store.insert(task('retired-live', managed('command_running', 'cancelled_by_user'), false));
    store.insert(task('retired-terminal', managed('condition_met', 'retired_by_replacement'), false));
    store.insert(task('settled', managed('consumed', 'fired'), false));
    const pendingAdmission = managed('consumed');
    Object.assign(pendingAdmission.holdLifecycle.managedCommand, {
      admissionFact: 'accepted command',
      admissionFactAppended: false,
    });
    store.insert(task('admission-pending', pendingAdmission));
    for (let i = 0; i < 769; i++)
      store.insert(task(`retired-enqueued-${i}`, managed('enqueued', 'retired_by_replacement'), false));
    for (let i = 0; i < 12; i++)
      store.insert(task(`cancelled-enqueued-${i}`, managed('enqueued', 'cancelled_by_user'), false));
    store.insert(task('cancelled-dispatched', managed('dispatched', 'cancelled_by_user'), false));
  })();
  assert.equal(
    store.listManagedCommandCandidates().length,
    4,
    'retired enqueued/dispatched history is not actionable recovery',
  );
  assert.deepEqual(
    store
      .listManagedCommandCandidates()
      .map((t) => t.id.replace('hold-ball-', ''))
      .sort(),
    ['admission-pending', 'live', 'retired-live', 'retired-terminal'],
  );
  assert.deepEqual(
    listManagedCommandExecutions(store.listManagedCommandCandidates())
      .map((item) => item.taskId)
      .sort(),
    ['hold-ball-live', 'hold-ball-retired-live'],
  );
  assert.equal(
    parseManagedCommandWakeTask(store.getById('hold-ball-admission-pending'))?.command.admissionFactAppended,
    false,
  );
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM dynamic_task_defs WHERE ${MANAGED_COMMAND_CANDIDATE_FILTER} ORDER BY created_at DESC`,
    )
    .all();
  assert(
    plan.some((row) => row.detail.includes('idx_dynamic_managed_candidates')),
    JSON.stringify(plan),
  );
  assert.equal(db.prepare('SELECT version FROM schema_version WHERE version = 51').get().version, 51);
  store.updateParams('hold-ball-live', managed('consumed', 'fired'));
  store.setEnabled('hold-ball-live', false);
  assert.equal(store.listManagedCommandCandidates().length, 3);
  db.close();
});
