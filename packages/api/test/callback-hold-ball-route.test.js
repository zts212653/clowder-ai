/**
 * F167 C1 — hold-ball callback route auth + body-validation tests
 *
 * gpt52 non-blocking note on PR #1289:
 *   "C1 仍然缺 callback route 行为级测试，现在锁住的是 counter 语义，
 *    不是 /api/callbacks/hold-ball 端到端行为。"
 *
 * This file covers the reject paths of POST /api/callbacks/hold-ball:
 *   - 401 on missing/invalid callback auth
 *   - 400 on invalid request body (schema violations — reason / wakeAfterMs bounds)
 *
 * Scheduling + counter + template-error paths live in
 * `callback-hold-ball-route-scheduling.test.js` (split per PR #1290 P2 for
 * ≤200-lines-per-file guidance).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 C1: /api/callbacks/hold-ball auth + body validation', () => {
  let registry;
  let threadStore;

  function makeStubDeps(overrides = {}) {
    const insertedTasks = [];
    const registeredDynamic = [];
    const defaultTemplate = {
      createSpec(taskId, taskParams) {
        return { taskId, taskParams };
      },
    };
    const deps = {
      registry,
      taskRunner: {
        registerDynamic(spec, taskId) {
          registeredDynamic.push({ spec, taskId });
        },
      },
      templateRegistry: {
        get(id) {
          return id === 'reminder' ? defaultTemplate : undefined;
        },
      },
      dynamicTaskStore: {
        insert(record) {
          insertedTasks.push(record);
        },
      },
      _insertedTasks: insertedTasks,
      _registeredDynamic: registeredDynamic,
    };
    return { ...deps, ...overrides };
  }

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

  async function createApp(holdBallDeps) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps,
    });
    return app;
  }

  test('401 when callback auth headers are missing', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      payload: { reason: 'x', nextStep: 'y', wakeAfterMs: 10_000 },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(deps._insertedTasks.length, 0, 'must not schedule a task when auth fails');
  });

  test('400 on invalid body: reason missing', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-400a', 'hb400a');
    const { invocationId, callbackToken } = await registry.create('user-hb-400a', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { nextStep: 'do thing', wakeAfterMs: 10_000 },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(deps._insertedTasks.length, 0);
  });

  test('400 on invalid body: wakeAfterMs below 5s minimum', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-400b', 'hb400b');
    const { invocationId, callbackToken } = await registry.create('user-hb-400b', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'wait for CI', nextStep: 'check build', wakeAfterMs: 1_000 },
    });
    assert.equal(response.statusCode, 400);
  });

  test('400 on invalid body: wakeAfterMs above 1h maximum', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-400c', 'hb400c');
    const { invocationId, callbackToken } = await registry.create('user-hb-400c', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'wait', nextStep: 'go', wakeAfterMs: 3_600_001 },
    });
    assert.equal(response.statusCode, 400);
  });
});
