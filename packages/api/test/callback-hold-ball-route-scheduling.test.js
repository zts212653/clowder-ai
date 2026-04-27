/**
 * F167 C1 — hold-ball callback route scheduling + error-path tests
 *
 * Sibling to `callback-hold-ball-route.test.js` (auth + 400 body validation).
 * Split per PR #1290 cloud review P2 (file-size guidance: ≤200 lines per file).
 *
 * Scope: the side-effect half of /api/callbacks/hold-ball contract —
 *   - 200 on valid request → scheduler + dynamicTaskStore side effects fired
 *   - 429 on maxHoldsPerWindow exhaustion (counter guard)
 *   - 500 when reminder template is missing
 *
 * Counter state lives in a module-local Map, so each test uses a distinct
 * (threadId, catId) pair to avoid cross-test contamination.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 C1: /api/callbacks/hold-ball scheduling + errors', () => {
  let registry;
  let threadStore;

  function makeStubDeps(overrides = {}) {
    const insertedTasks = [];
    const registeredDynamic = [];
    const unregisteredIds = [];
    const removedIds = [];
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
        unregister(taskId) {
          unregisteredIds.push(taskId);
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
          return insertedTasks.filter((t) => !removedIds.includes(t.id));
        },
        remove(id) {
          removedIds.push(id);
          return true;
        },
      },
      // gpt52 non-blocking cleanup: satisfy deps.messageStore + deps.socketManager
      // so hold_ball visibility broadcast doesn't emit warn noise in tests.
      messageStore: {
        async append(msg) {
          return { id: `test-msg-${insertedTasks.length}`, ...msg };
        },
      },
      socketManager: {
        broadcastToRoom() {},
      },
      _insertedTasks: insertedTasks,
      _registeredDynamic: registeredDynamic,
      _unregisteredIds: unregisteredIds,
      _removedIds: removedIds,
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

  test('200 on valid request — schedules task + increments counter', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-200', 'hb200');
    const { invocationId, callbackToken } = await registry.create('user-hb-200', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'CI still running', nextStep: 'check build status', wakeAfterMs: 60_000 },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.held, true);
    assert.ok(typeof body.taskId === 'string' && body.taskId.startsWith('hold-ball-'));
    assert.equal(body.holdsInWindow, 1);
    assert.equal(body.maxHoldsPerWindow, 3);
    assert.equal(body.windowMs, 3_600_000);
    assert.ok(typeof body.wakeAt === 'string' && !Number.isNaN(Date.parse(body.wakeAt)));

    assert.equal(deps._insertedTasks.length, 1, 'dynamicTaskStore.insert called once');
    assert.equal(deps._registeredDynamic.length, 1, 'taskRunner.registerDynamic called once');
    const [task] = deps._insertedTasks;
    assert.equal(task.templateId, 'reminder');
    assert.equal(task.trigger.type, 'once');
    assert.equal(task.deliveryThreadId, thread.id);
    assert.equal(task.params.targetCatId, 'codex');
    assert.equal(task.params.triggerUserId, 'user-hb-200');
    assert.match(task.params.message, /持球唤醒/);
    assert.match(task.params.message, /CI still running/);
    assert.match(task.params.message, /check build status/);
    assert.equal(task.createdBy, 'hold-ball:codex');
  });

  test('F167-G AC-G3/G5: second hold_ball replaces first pending (single-slot semantics, KD-23)', async () => {
    // KD-23: hold_ball 是单-槽语义。同 (thread, cat) 同时只有一个 pending hold wake；
    // 二次调用覆盖前者（unregister + remove 旧 task，insert 新的）。
    // 避免 stale wake 累积（持球中被 external 唤醒，再次 hold_ball 时前一个 wake
    // 的 nextStep 已经过时——不应仍 fire）。
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-replace', 'hbreplace');
    const { invocationId, callbackToken } = await registry.create('user-hb-replace', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // First hold_ball
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-A', nextStep: 'continue-A', wakeAfterMs: 10_000 },
    });
    assert.equal(r1.statusCode, 200, 'first hold should succeed');
    const firstTaskId = JSON.parse(r1.body).taskId;

    // Second hold_ball (same thread, same cat)
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-B', nextStep: 'continue-B', wakeAfterMs: 20_000 },
    });
    assert.equal(r2.statusCode, 200, 'second hold should succeed');
    const secondTaskId = JSON.parse(r2.body).taskId;
    assert.notEqual(firstTaskId, secondTaskId, 'second hold must produce a distinct taskId');

    // First task must be cancelled (taskRunner.unregister) and deleted (dynamicTaskStore.remove)
    assert.ok(
      deps._unregisteredIds.includes(firstTaskId),
      `first taskId should have been unregistered; got ${JSON.stringify(deps._unregisteredIds)}`,
    );
    assert.ok(
      deps._removedIds.includes(firstTaskId),
      `first taskId should have been removed from dynamicTaskStore; got ${JSON.stringify(deps._removedIds)}`,
    );
    // Only the second task remains in the store's live view
    const liveTasks = deps.dynamicTaskStore.getAll();
    assert.equal(liveTasks.length, 1, `exactly one pending hold task should remain; got ${liveTasks.length}`);
    assert.equal(liveTasks[0].id, secondTaskId);
    assert.match(liveTasks[0].params.message, /wait-B/);
    assert.match(liveTasks[0].params.message, /continue-B/);
  });

  test('F167-G cloud P1: registerDynamic failure rolls back new insert and retains prior hold (atomic swap)', async () => {
    // Cloud Codex P1 on c04c5552a: if taskRunner.registerDynamic throws AFTER
    // the prior hold was already cancelled, cat ends up with ZERO scheduled wakes.
    // Fix: insert + register NEW first; only on success cancel prior. If register
    // throws: remove the just-inserted row (rollback) + return 500; prior hold
    // (if any) stays authoritative.
    const deps = makeStubDeps();
    // First hold succeeds normally.
    const app1 = await createApp(deps);
    const thread = await threadStore.create('user-hb-rollback', 'hbrollback');
    const { invocationId, callbackToken } = await registry.create('user-hb-rollback', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    const r1 = await app1.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-A', nextStep: 'continue-A', wakeAfterMs: 10_000 },
    });
    assert.equal(r1.statusCode, 200);
    const firstTaskId = JSON.parse(r1.body).taskId;
    const firstInsertCount = deps._insertedTasks.length;

    // Now fail the second hold's taskRunner.registerDynamic.
    deps.taskRunner.registerDynamic = () => {
      throw new Error('simulated scheduler failure');
    };

    const r2 = await app1.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'wait-B', nextStep: 'continue-B', wakeAfterMs: 20_000 },
    });

    // Caller must see 500 (clear signal that new hold didn't stick).
    assert.equal(r2.statusCode, 500, 'failed scheduler register must return 500');

    // New insert must have been rolled back — only firstTaskId remains active.
    const liveAfterRollback = deps.dynamicTaskStore.getAll();
    assert.equal(
      liveAfterRollback.length,
      1,
      `after rollback exactly one task should remain; got ${liveAfterRollback.length}`,
    );
    assert.equal(liveAfterRollback[0].id, firstTaskId, 'prior hold must be retained after rollback');

    // Prior was NOT cancelled (since new never fully committed).
    assert.ok(
      !deps._unregisteredIds.includes(firstTaskId),
      `prior taskId must NOT have been unregistered on failed swap; got ${JSON.stringify(deps._unregisteredIds)}`,
    );

    // But we did insert one row and then remove it (the rolled-back attempt).
    const insertedDuringSecondCall = deps._insertedTasks.length - firstInsertCount;
    assert.equal(insertedDuringSecondCall, 1, 'second call should have inserted one row (then rolled back)');
    const rolledBackId = deps._insertedTasks[firstInsertCount].id;
    assert.ok(
      deps._removedIds.includes(rolledBackId),
      `rolled-back taskId must be removed from store; got ${JSON.stringify(deps._removedIds)}`,
    );
  });

  test('F167-G AC-G3: different cats in same thread do NOT cancel each others holds', async () => {
    // Single-slot is PER (threadId, catId). Two different cats holding in the
    // same thread must both have their own pending wake.
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-multicat', 'hbmulticat');
    const codex = await registry.create('user-hb-multicat', 'codex', thread.id);
    const opus = await registry.create('user-hb-multicat', 'opus', thread.id);

    // codex holds
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': codex.invocationId, 'x-callback-token': codex.callbackToken },
      payload: { reason: 'codex-wait', nextStep: 'codex-next', wakeAfterMs: 10_000 },
    });
    // opus holds
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': opus.invocationId, 'x-callback-token': opus.callbackToken },
      payload: { reason: 'opus-wait', nextStep: 'opus-next', wakeAfterMs: 10_000 },
    });

    // Neither should have been cancelled by the other — single-slot is per (thread, cat).
    assert.equal(deps._unregisteredIds.length, 0, 'different cats should not trigger cross-cancel');
    const liveTasks = deps.dynamicTaskStore.getAll();
    assert.equal(liveTasks.length, 2, 'both cats should have their own pending hold');
  });

  test('F167-G cloud P2 round-2 (gpt52 pushback): forged panel dyn-* task with matching createdBy MUST NOT be cancelled', async () => {
    // Attack surface: /api/schedule/tasks lets panel callers pass body.createdBy
    // AND body.display.category (both cast to valid values). A malicious or
    // accidental task with `createdBy: 'hold-ball:codex' + category: anything`
    // must NOT be deleted by subsequent hold_ball calls.
    // Defense: anchor pending-hold match on taskId prefix 'hold-ball-' + templateId.
    // Panel-created tasks always have `dyn-*` ids (server-generated).
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-forge', 'hbforge');
    const { invocationId, callbackToken } = await registry.create('user-hb-forge', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // Forge a panel-created reminder task with SAME createdBy + thread,
    // as if a panel user posted { createdBy: 'hold-ball:codex', ... }.
    // The dyn-* id prefix is the unforgeable marker.
    deps._insertedTasks.push({
      id: 'dyn-forged-12345',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 900_000 },
      params: { message: 'unrelated reminder', targetCatId: 'codex', triggerUserId: 'user-hb-forge' },
      display: { label: 'panel reminder', category: 'system', description: '…' },
      deliveryThreadId: thread.id,
      enabled: true,
      createdBy: 'hold-ball:codex',
      createdAt: new Date().toISOString(),
    });

    // Now codex calls hold_ball once. Pending-hold filter must NOT match the
    // forged dyn-* task even though createdBy matches.
    const r = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: { reason: 'real-hold', nextStep: 'real-next', wakeAfterMs: 10_000 },
    });
    assert.equal(r.statusCode, 200, 'hold_ball must succeed');

    // The forged task must still be present; only the newly-inserted
    // hold-ball-* task should exist alongside it.
    assert.ok(
      !deps._unregisteredIds.includes('dyn-forged-12345'),
      `forged dyn-* task MUST NOT be unregistered; got ${JSON.stringify(deps._unregisteredIds)}`,
    );
    assert.ok(
      !deps._removedIds.includes('dyn-forged-12345'),
      `forged dyn-* task MUST NOT be removed; got ${JSON.stringify(deps._removedIds)}`,
    );
    const liveTasks = deps.dynamicTaskStore.getAll();
    assert.equal(liveTasks.length, 2, 'forged task + new hold-ball task both alive');
    assert.ok(
      liveTasks.some((t) => t.id === 'dyn-forged-12345'),
      'forged dyn-* task survives',
    );
    assert.ok(
      liveTasks.some((t) => t.id.startsWith('hold-ball-')),
      'new hold-ball task was inserted',
    );
  });

  test('429 after maxHoldsPerWindow (3) exhaustion — counter guard', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-429', 'hb429');
    const { invocationId, callbackToken } = await registry.create('user-hb-429', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const payload = { reason: 'waiting', nextStep: 'continue', wakeAfterMs: 10_000 };

    for (let i = 1; i <= 3; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/callbacks/hold-ball', headers, payload });
      assert.equal(r.statusCode, 200, `hold #${i} should succeed`);
      assert.equal(JSON.parse(r.body).holdsInWindow, i);
    }

    const r4 = await app.inject({ method: 'POST', url: '/api/callbacks/hold-ball', headers, payload });
    assert.equal(r4.statusCode, 429);
    const body = JSON.parse(r4.body);
    assert.match(body.error, /maxHoldsPerWindow/);
    assert.match(body.error, /pass the ball now/);
    assert.equal(body.maxHoldsPerWindow, 3);
    assert.equal(body.holdsInWindow, 3);
    assert.equal(body.windowMs, 3_600_000);
    assert.equal(deps._insertedTasks.length, 3, 'blocked hold must NOT schedule a new task');
  });

  test('500 when reminder template is missing', async () => {
    const deps = makeStubDeps({
      templateRegistry: { get: () => undefined },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-500', 'hb500');
    const { invocationId, callbackToken } = await registry.create('user-hb-500', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'x', nextStep: 'y', wakeAfterMs: 10_000 },
    });

    assert.equal(response.statusCode, 500);
    assert.match(JSON.parse(response.body).error, /reminder template/);
    assert.equal(deps._insertedTasks.length, 0);
  });
});
