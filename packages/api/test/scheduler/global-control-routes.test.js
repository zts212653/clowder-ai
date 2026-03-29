/**
 * F139 Phase 3B: Global Control API Routes (AC-D1)
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

let db, app, globalControlStore, taskRunner;

const noop = () => {};
const silentLogger = { info: noop, error: noop };

/** Minimal TaskRunnerV2-compatible mock */
function createMockRunner(ledger, store) {
  return {
    getTaskSummaries: () => [],
    getRegisteredTasks: () => ['task-a', 'task-b'],
    getLedger: () => ledger,
    triggerNow: async () => {},
  };
}

describe('Global Control Routes (AC-D1)', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    applyMigrations(db);

    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { GlobalControlStore } = await import('../../dist/infrastructure/scheduler/GlobalControlStore.js');
    const { scheduleRoutes } = await import('../../dist/routes/schedule.js');

    const ledger = new RunLedger(db);
    globalControlStore = new GlobalControlStore(db);
    taskRunner = createMockRunner(ledger, globalControlStore);

    app = Fastify({ logger: false });
    await app.register(scheduleRoutes, {
      taskRunner,
      globalControlStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test('GET /api/schedule/control returns global state + overrides', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/schedule/control' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.global.enabled, true);
    assert.ok(Array.isArray(body.overrides));
    assert.equal(body.overrides.length, 0);
  });

  test('PATCH /api/schedule/control toggles global enabled', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/schedule/control',
      payload: { enabled: false, reason: '维护中', updatedBy: 'opus' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.global.enabled, false);
    assert.equal(body.global.reason, '维护中');

    // Verify persistent state
    assert.equal(globalControlStore.getGlobalEnabled(), false);
  });

  test('PATCH /api/schedule/control requires enabled field', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/schedule/control',
      payload: { reason: 'missing enabled' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('PUT /api/schedule/control/tasks/:id sets task override', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/schedule/control/tasks/task-a',
      payload: { enabled: false, updatedBy: 'opus' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.override.taskId, 'task-a');
    assert.equal(body.override.enabled, false);

    // Verify persistent
    const o = globalControlStore.getTaskOverride('task-a');
    assert.ok(o);
    assert.equal(o.enabled, false);
  });

  test('DELETE /api/schedule/control/tasks/:id removes override', async () => {
    globalControlStore.setTaskOverride('task-a', false, 'opus');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/schedule/control/tasks/task-a',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(globalControlStore.getTaskOverride('task-a'), null);
  });

  test('DELETE /api/schedule/control/tasks/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/schedule/control/tasks/nonexistent',
    });
    assert.equal(res.statusCode, 404);
  });

  test('GET includes overrides after PUT', async () => {
    globalControlStore.setTaskOverride('task-a', false, 'opus');
    globalControlStore.setTaskOverride('task-b', true, 'user');

    const res = await app.inject({ method: 'GET', url: '/api/schedule/control' });
    const body = JSON.parse(res.payload);
    assert.equal(body.overrides.length, 2);
  });

  test('POST trigger passes manual=true to triggerNow', async () => {
    let capturedOpts;
    taskRunner.triggerNow = async (_id, opts) => {
      capturedOpts = opts;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/schedule/tasks/task-a/trigger',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(capturedOpts, { manual: true });
  });
});
