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
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 C1: /api/callbacks/hold-ball auth + body validation', () => {
  let registry;
  let threadStore;
  let holdQuotaStore;

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
        unregister() {
          return true;
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
        getAll() {
          return insertedTasks;
        },
        remove() {
          return true;
        },
      },
      messageStore: {
        async append(msg) {
          return { id: `test-msg-${insertedTasks.length}`, ...msg };
        },
      },
      socketManager: {
        broadcastToRoom() {},
      },
      holdQuotaStore,
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
    const { HoldQuotaStore } = await import('../dist/domains/ball-custody/hold-quota-store.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    holdQuotaStore = new HoldQuotaStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    holdQuotaStore?.close();
    holdQuotaStore = null;
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

  // ─── T7: wakeAfterMs + wakeWhen mutual exclusion ─────────────────────────
  test('T7: 400 when both wakeAfterMs and wakeWhen provided (mutual exclusion)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-mutex', 'hb-mutex');
    const { invocationId, callbackToken } = await registry.create('user-hb-mutex', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'wait for gate',
        nextStep: 'check result',
        wakeAfterMs: 60_000,
        wakeWhen: { command: 'pnpm gate' },
      },
    });
    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.ok(
      body.details?.some((d) => d.message?.includes('Exactly one')),
      'should mention mutual exclusion',
    );
  });

  test('T7b: 400 when neither wakeAfterMs nor wakeWhen provided', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-neither', 'hb-neither');
    const { invocationId, callbackToken } = await registry.create('user-hb-neither', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'wait', nextStep: 'go' },
    });
    assert.equal(response.statusCode, 400);
  });

  // ─── PR-O3: waitSourceRef enforcement ─────────────────────────────────────
  test('PR-O3: 400 when wakeAfterMs provided without waitSourceRef (ungrounded timer wait)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-o3a', 'hbo3a');
    const { invocationId, callbackToken } = await registry.create('user-hb-o3a', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'wait for reply', nextStep: 'continue', wakeAfterMs: 60_000 },
    });
    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.ok(
      body.details?.some((d) => d.message?.includes('waitSourceRef is required')),
      'error must mention waitSourceRef requirement',
    );
  });

  test('PR-O3: 200 when wakeAfterMs provided WITH valid waitSourceRef', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-o3b', 'hbo3b');
    const { invocationId, callbackToken } = await registry.create('user-hb-o3b', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'wait for CI',
        nextStep: 'check build',
        wakeAfterMs: 60_000,
        waitSourceRef: {
          kind: 'github_issue',
          value: 'AgeOfLearning/cat-cafe#999',
          expectedSignal: 'issue closed',
          slaUntilMs: 3_600_000,
        },
      },
    });
    assert.equal(response.statusCode, 200, 'grounded timer wait should succeed');
  });

  test('PR-O3: 200 when wakeWhen provided WITHOUT waitSourceRef (command is self-grounding)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-o3c', 'hbo3c');
    const { invocationId, callbackToken } = await registry.create('user-hb-o3c', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'running gate',
        nextStep: 'check result',
        wakeWhen: { command: 'echo ok' },
      },
    });
    assert.equal(response.statusCode, 200, 'wakeWhen without waitSourceRef should succeed (self-grounding)');
  });

  for (const wakeWhen of [
    { command: 'echo ok', executionSlaMs: 7_200_000 },
    { command: 'pnpm gate', executionSlaMs: 10_800_001 },
    { command: 'pnpm gate', executionSlaMs: 999 },
    { command: 'pnpm gate', executionSlaMs: 1_000.5 },
    { command: 'pnpm gate', timeoutMs: 3_600_001, executionSlaMs: 7_200_000 },
  ]) {
    test(`rejects unsupported execution budget before quota or scheduling: ${JSON.stringify(wakeWhen)}`, async (t) => {
      const deps = makeStubDeps({
        holdQuotaStore: {
          async tryAdmit() {
            assert.fail('invalid budget must be rejected before quota admission');
          },
        },
      });
      const app = await createApp(deps);
      t.after(() => app.close());
      const thread = await threadStore.create('budget-owner', 'budget validation');
      const { invocationId, callbackToken } = await registry.create('budget-owner', 'codex', thread.id);
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { reason: 'budget boundary', nextStep: 'consume result', wakeWhen },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(deps._insertedTasks.length, 0);
      assert.equal(deps._registeredDynamic.length, 0);
    });
  }

  test('PR-O3: 400 when pending_input kind used (removed backdoor)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-o3d', 'hbo3d');
    const { invocationId, callbackToken } = await registry.create('user-hb-o3d', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'wait for user',
        nextStep: 'continue',
        wakeAfterMs: 60_000,
        waitSourceRef: {
          kind: 'pending_input',
          value: 'design_choice',
          anchorRef: 'msg_123',
          expectedSignal: 'user picks option',
          slaUntilMs: 900_000,
        },
      },
    });
    assert.equal(response.statusCode, 400, 'pending_input kind must be rejected');
  });
});
