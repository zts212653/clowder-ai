/**
 * F182 Phase D — disable-impact endpoint tests
 *
 * Covers AC-D1: GET /api/cats/:catId/disable-impact aggregates active task +
 * scheduledTask references for a cat (no PR tracking, no done tasks).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

function mockDynamicStore(items = []) {
  return { getAll: () => items };
}

async function createApp(opts = {}) {
  const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
  const { registerDisableImpactRoute } = await import('../dist/routes/disable-impact.js');
  const ts = opts.taskStore ?? new TaskStore();
  const dt = opts.dynamicTaskStore ?? mockDynamicStore();
  const a = Fastify({ logger: false });
  registerDisableImpactRoute(a, { taskStore: ts, dynamicTaskStore: dt });
  await a.ready();
  return { app: a, taskStore: ts };
}

describe('F182 D1 - GET /api/cats/:catId/disable-impact', () => {
  let currentApp = null;

  afterEach(async () => {
    if (currentApp) {
      await currentApp.close();
      currentApp = null;
    }
  });

  test('D1-a: 404 for unknown catId', async () => {
    const { app } = await createApp();
    currentApp = app;

    const res = await app.inject({ method: 'GET', url: '/api/cats/nonexistent-cat/disable-impact' });
    assert.equal(res.statusCode, 404);
    assert.ok(JSON.parse(res.body).error, 'should have error message');
  });

  test('D1-b: empty impact for known cat with no references', async () => {
    const { app } = await createApp();
    currentApp = app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/cats/codex/disable-impact',
      headers: { 'x-cat-cafe-user': 'u1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.tasks, []);
    assert.deepEqual(body.scheduledTasks, []);
  });

  test('D1-c: active work tasks owned by cat included', async () => {
    const { app, taskStore } = await createApp();
    currentApp = app;

    taskStore.create({
      threadId: 'thread1',
      title: 'Write tests',
      why: '',
      createdBy: 'opus',
      kind: 'work',
      subjectKey: null,
      ownerCatId: 'codex',
      userId: 'u1',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/cats/codex/disable-impact',
      headers: { 'x-cat-cafe-user': 'u1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].ownerCatId, 'codex');
    assert.equal(body.tasks[0].title, 'Write tests');
    assert.ok(body.tasks[0].status !== 'done');
  });

  test('D1-d: done tasks excluded from impact', async () => {
    const { app, taskStore } = await createApp();
    currentApp = app;

    const task = taskStore.create({
      threadId: 'thread1',
      title: 'Done task',
      why: '',
      createdBy: 'opus',
      kind: 'work',
      subjectKey: null,
      ownerCatId: 'codex',
      userId: 'u1',
    });
    taskStore.update(task.id, { status: 'done' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/cats/codex/disable-impact',
      headers: { 'x-cat-cafe-user': 'u1' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).tasks, []);
  });

  test('D1-e: active scheduled tasks targeting cat included, disabled excluded', async () => {
    const dt = mockDynamicStore([
      {
        id: 'sched1',
        templateId: 'tpl1',
        params: { targetCatId: 'codex', triggerUserId: 'u1' },
        display: { label: 'Weekly Report', category: 'scheduled' },
        enabled: true,
        deliveryThreadId: null,
        trigger: { type: 'cron', cron: '0 9 * * 1' },
        createdBy: 'opus',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'sched2',
        templateId: 'tpl1',
        params: { targetCatId: 'codex', triggerUserId: 'u1' },
        display: { label: 'Paused Report', category: 'scheduled' },
        enabled: false,
        deliveryThreadId: null,
        trigger: { type: 'cron', cron: '0 9 * * 2' },
        createdBy: 'opus',
        createdAt: new Date().toISOString(),
      },
    ]);
    const { app } = await createApp({ dynamicTaskStore: dt });
    currentApp = app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/cats/codex/disable-impact',
      headers: { 'x-cat-cafe-user': 'u1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.scheduledTasks.length, 1, 'only enabled scheduled tasks');
    assert.equal(body.scheduledTasks[0].id, 'sched1');
    assert.equal(body.scheduledTasks[0].label, 'Weekly Report');
  });

  // Cloud P1: cross-user task isolation — userId scoping
  test('D1-cloud-P1: user-b must not see user-a tasks (cross-tenant isolation)', async () => {
    const { app, taskStore } = await createApp();
    currentApp = app;

    // User-a's task assigned to codex
    taskStore.create({
      threadId: 'thread1',
      title: 'User A confidential task',
      why: '',
      createdBy: 'opus',
      kind: 'work',
      subjectKey: null,
      ownerCatId: 'codex',
      userId: 'user-a',
    });

    // User-b requests disable-impact for codex — must NOT see user-a's task
    const res = await app.inject({
      method: 'GET',
      url: '/api/cats/codex/disable-impact',
      headers: { 'x-cat-cafe-user': 'user-b' },
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    assert.deepEqual(JSON.parse(res.body).tasks, [], 'user-b must not see user-a tasks');
  });

  // Cloud P1b/P1c: scheduledTask isolation via params.triggerUserId (not createdBy)
  // createdBy is always a catId or 'user' — never a userId (see deriveScheduleActor)
  test('D1-cloud-P1b: user-b must not see user-a scheduled tasks (cross-tenant isolation)', async () => {
    const dt = mockDynamicStore([
      {
        id: 'sched-a',
        templateId: 'tpl1',
        params: { targetCatId: 'codex', triggerUserId: 'user-a' },
        display: { label: 'User A Schedule', category: 'scheduled' },
        enabled: true,
        deliveryThreadId: null,
        trigger: { type: 'cron', cron: '0 9 * * 1' },
        createdBy: 'opus',
        createdAt: new Date().toISOString(),
      },
    ]);
    const { app } = await createApp({ dynamicTaskStore: dt });
    currentApp = app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/cats/codex/disable-impact',
      headers: { 'x-cat-cafe-user': 'user-b' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).scheduledTasks, [], 'user-b must not see user-a scheduled tasks');
  });

  test('D1-cloud-P1c: user-a CAN see their own scheduled tasks (triggerUserId not createdBy)', async () => {
    const dt = mockDynamicStore([
      {
        id: 'sched-a',
        templateId: 'tpl1',
        params: { targetCatId: 'codex', triggerUserId: 'user-a' },
        display: { label: 'User A Schedule', category: 'scheduled' },
        enabled: true,
        deliveryThreadId: null,
        trigger: { type: 'cron', cron: '0 9 * * 1' },
        createdBy: 'opus',
        createdAt: new Date().toISOString(),
      },
    ]);
    const { app } = await createApp({ dynamicTaskStore: dt });
    currentApp = app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/cats/codex/disable-impact',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).scheduledTasks.length, 1, 'user-a must see their own scheduled tasks');
  });

  test('D1-f: tasks of other cats not included', async () => {
    const { app, taskStore } = await createApp();
    currentApp = app;

    taskStore.create({
      threadId: 'thread1',
      title: 'Task for opus',
      why: '',
      createdBy: 'codex',
      kind: 'work',
      subjectKey: null,
      ownerCatId: 'opus',
      userId: 'u1',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/cats/codex/disable-impact',
      headers: { 'x-cat-cafe-user': 'u1' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).tasks, []);
  });
});
