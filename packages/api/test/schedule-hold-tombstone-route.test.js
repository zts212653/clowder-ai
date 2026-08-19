/**
 * Schedule route regression for hold-ball lifecycle tombstones.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('GET /api/schedule/tasks — hold-ball tombstones', () => {
  let app;
  let db;
  let ledger;
  let runner;
  let store;

  beforeEach(async () => {
    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { DynamicTaskStore } = await import('../dist/infrastructure/scheduler/DynamicTaskStore.js');
    const { RunLedger } = await import('../dist/infrastructure/scheduler/RunLedger.js');
    const { ScheduleMutationProposalStore } = await import(
      '../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js'
    );
    const { TaskRunnerV2 } = await import('../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const { templateRegistry } = await import('../dist/infrastructure/scheduler/templates/registry.js');
    const { scheduleRoutes } = await import('../dist/routes/schedule.js');

    db = new Database(':memory:');
    applyMigrations(db);
    ledger = new RunLedger(db);
    runner = new TaskRunnerV2({
      logger: { info() {}, error() {} },
      ledger,
    });
    store = new DynamicTaskStore(db);
    app = Fastify({ logger: false });
    app.decorateRequest('sessionUserId', undefined);
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = 'default-user';
    });
    await app.register(scheduleRoutes, {
      taskRunner: runner,
      dynamicTaskStore: store,
      templateRegistry,
      taskStore: new TaskStore(),
      ownerUserId: 'default-user',
      scheduleMutationProposalStore: new ScheduleMutationProposalStore(db),
      approvalIngress: {
        async publish() {
          assert.fail('retired hold tombstones must never publish an approval proposal');
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    runner.stop();
    await app.close();
    db.close();
  });

  it('excludes retired hold tombstones while keeping paused user dynamic tasks visible', async () => {
    store.insert({
      id: 'dyn-paused-user-task',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'paused but resumable' },
      display: { label: 'Paused user reminder', category: 'thread', description: 'resumable paused task' },
      deliveryThreadId: 'thread-hold-scope',
      enabled: false,
      createdBy: 'codex',
      createdAt: '2026-07-07T07:00:00.000Z',
    });
    store.insert({
      id: 'hold-ball-retired-tombstone',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: {
        message: 'retired hold wake',
        targetCatId: 'codex',
        triggerUserId: 'default-user',
        holdLifecycle: {
          mode: 'timer',
          status: 'retired_by_event',
          subjectKey: 'zts212653/cat-cafe#2779',
          expectedSignalKey: 'review_posted',
          wakeAt: Date.now() + 60_000,
          createdBy: 'hold-ball:codex',
        },
      },
      display: { label: '持球唤醒 (codex)', category: 'system', description: 'retired hold tombstone' },
      deliveryThreadId: 'thread-hold-scope',
      enabled: false,
      createdBy: 'hold-ball:codex',
      createdAt: '2026-07-07T07:01:00.000Z',
    });

    const allRes = await app.inject({ method: 'GET', url: '/api/schedule/tasks' });
    assert.equal(allRes.statusCode, 200);
    const allIds = allRes.json().tasks.map((task) => task.id);
    assert.ok(allIds.includes('dyn-paused-user-task'), 'resumable paused dynamic task stays visible');
    assert.ok(!allIds.includes('hold-ball-retired-tombstone'), 'retired hold tombstone is not a schedule task');

    const scopedRes = await app.inject({ method: 'GET', url: '/api/schedule/tasks?threadId=thread-hold-scope' });
    assert.equal(scopedRes.statusCode, 200);
    const scopedIds = scopedRes.json().tasks.map((task) => task.id);
    assert.ok(scopedIds.includes('dyn-paused-user-task'), 'resumable paused task stays visible in its thread');
    assert.ok(!scopedIds.includes('hold-ball-retired-tombstone'), 'retired tombstone stays out of thread scope');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/schedule/tasks/hold-ball-retired-tombstone',
      payload: { enabled: true },
    });
    assert.equal(patchRes.statusCode, 404);
    assert.equal(store.getById('hold-ball-retired-tombstone').enabled, false, 'PATCH must not revive tombstone');

    const deleteRes = await app.inject({ method: 'DELETE', url: '/api/schedule/tasks/hold-ball-retired-tombstone' });
    assert.equal(deleteRes.statusCode, 404);
    assert.ok(store.getById('hold-ball-retired-tombstone'), 'DELETE must not remove lifecycle tombstone');
  });

  it('allows run history for paused dynamic tasks but not retired hold tombstones', async () => {
    store.insert({
      id: 'dyn-paused-run-history',
      templateId: 'reminder',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { message: 'has run history' },
      display: { label: 'Paused reminder with history', category: 'thread', description: 'paused after running' },
      deliveryThreadId: 'thread-runs-scope',
      enabled: false,
      createdBy: 'codex',
      createdAt: '2026-07-07T07:02:00.000Z',
    });
    ledger.record({
      task_id: 'dyn-paused-run-history',
      subject_key: 'thread:thread-runs-scope',
      outcome: 'RUN_DELIVERED',
      signal_summary: null,
      duration_ms: 25,
      started_at: '2026-07-07T07:03:00.000Z',
      assigned_cat_id: 'codex',
    });
    store.insert({
      id: 'hold-ball-retired-tombstone',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: {
        message: 'retired hold wake',
        targetCatId: 'codex',
        triggerUserId: 'default-user',
        holdLifecycle: {
          mode: 'timer',
          status: 'retired_by_event',
          subjectKey: 'zts212653/cat-cafe#2779',
          expectedSignalKey: 'review_posted',
          wakeAt: Date.now() + 60_000,
          createdBy: 'hold-ball:codex',
        },
      },
      display: { label: '持球唤醒 (codex)', category: 'system', description: 'retired hold tombstone' },
      deliveryThreadId: 'thread-runs-scope',
      enabled: false,
      createdBy: 'hold-ball:codex',
      createdAt: '2026-07-07T07:04:00.000Z',
    });
    ledger.record({
      task_id: 'hold-ball-retired-tombstone',
      subject_key: 'thread:thread-runs-scope',
      outcome: 'RUN_DELIVERED',
      signal_summary: null,
      duration_ms: 10,
      started_at: '2026-07-07T07:05:00.000Z',
      assigned_cat_id: 'codex',
    });

    const pausedRunsRes = await app.inject({
      method: 'GET',
      url: '/api/schedule/tasks/dyn-paused-run-history/runs',
    });
    assert.equal(pausedRunsRes.statusCode, 200);
    assert.deepEqual(
      pausedRunsRes.json().runs.map((run) => run.task_id),
      ['dyn-paused-run-history'],
    );

    const scopedRunsRes = await app.inject({
      method: 'GET',
      url: '/api/schedule/tasks/dyn-paused-run-history/runs?threadId=thread-runs-scope',
    });
    assert.equal(scopedRunsRes.statusCode, 200);
    assert.deepEqual(
      scopedRunsRes.json().runs.map((run) => run.subject_key),
      ['thread:thread-runs-scope'],
    );

    const tombstoneRunsRes = await app.inject({
      method: 'GET',
      url: '/api/schedule/tasks/hold-ball-retired-tombstone/runs',
    });
    assert.equal(tombstoneRunsRes.statusCode, 404);
  });
});
