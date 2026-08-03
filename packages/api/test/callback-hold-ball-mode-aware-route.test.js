/**
 * F167 Mode-Aware Hold Quota — Route-Level Tests
 *
 * RED→GREEN tests for the three review findings from PR #1274:
 *   P1: command admission must be bounded (separate counter, MAX=5/hr)
 *   P1: route-level tests (not just counter helper)
 *   P2: no holdsInWindow:0 forgery in command mode
 *
 * These go through the actual /api/callbacks/hold-ball route (not just
 * the counter module), verifying holdMode in responses and F257 telemetry.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const VALID_WAIT_SOURCE_REF = {
  kind: 'github_issue',
  value: 'AgeOfLearning/cat-cafe#999',
  expectedSignal: 'issue closed',
  slaUntilMs: 3_600_000,
};

describe('F167 mode-aware hold quota — route level', () => {
  let registry;
  let threadStore;

  function makeStubDeps(overrides = {}) {
    const insertedTasks = [];
    const registeredDynamic = [];
    const unregisteredIds = [];
    const removedIds = [];
    const guardRejectionEvents = [];
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
      messageStore: {
        async append(msg) {
          return { id: `test-msg-${insertedTasks.length}`, ...msg };
        },
      },
      socketManager: {
        broadcastToRoom() {},
      },
      guardRejectionLog: {
        async append(event) {
          guardRejectionEvents.push(event);
        },
      },
      _insertedTasks: insertedTasks,
      _registeredDynamic: registeredDynamic,
      _unregisteredIds: unregisteredIds,
      _removedIds: removedIds,
      _guardRejectionEvents: guardRejectionEvents,
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

  // ── holdMode in success responses ─────────────────────────────────────────

  test('timer mode (wakeAfterMs): response includes holdMode:"timer"', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-timer', 'ma-timer');
    const { invocationId, callbackToken } = await registry.create('user-ma-timer', 'codex', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'CI running',
        nextStep: 'check CI',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.holdMode, 'timer', 'timer mode response must include holdMode');
    assert.equal(body.holdsInWindow, 1);
    assert.equal(body.maxHoldsPerWindow, 3, 'timer mode limit is 3');
  });

  test('command mode (wakeWhen): response includes holdMode:"command"', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-cmd', 'ma-cmd');
    const { invocationId, callbackToken } = await registry.create('user-ma-cmd', 'codex', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'build running',
        nextStep: 'check result',
        wakeWhen: { command: 'echo hello', timeoutMs: 30_000 },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.holdMode, 'command', 'command mode response must include holdMode');
    assert.equal(body.holdsInWindow, 1);
    assert.equal(body.maxHoldsPerWindow, 5, 'command mode limit is 5');
  });

  // ── P2: no holdsInWindow forgery ──────────────────────────────────────────

  test('P2: command mode reports real command counter, not hardcoded 0', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-p2', 'ma-p2');
    const { invocationId, callbackToken } = await registry.create('user-ma-p2', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // First command hold
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'build-1',
        nextStep: 'check-1',
        wakeWhen: { command: 'echo 1', timeoutMs: 30_000 },
      },
    });
    assert.equal(JSON.parse(r1.body).holdsInWindow, 1, 'first command hold: count=1');

    // Second command hold
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'build-2',
        nextStep: 'check-2',
        wakeWhen: { command: 'echo 2', timeoutMs: 30_000 },
      },
    });
    const body2 = JSON.parse(r2.body);
    assert.equal(body2.holdsInWindow, 2, 'second command hold: count=2, not forged 0');
    assert.notEqual(body2.holdsInWindow, 0, 'must NOT be hardcoded 0');
  });

  // ── P1: command admission is bounded ──────────────────────────────────────

  test('P1: command mode 429 at MAX_COMMAND_HOLDS_PER_WINDOW (5)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-cmd429', 'ma-cmd429');
    const { invocationId, callbackToken } = await registry.create('user-ma-cmd429', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // Exhaust command holds (5)
    for (let i = 1; i <= 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers,
        payload: {
          reason: `cmd-${i}`,
          nextStep: `next-${i}`,
          wakeWhen: { command: `echo ${i}`, timeoutMs: 30_000 },
        },
      });
      assert.equal(r.statusCode, 200, `command hold #${i} should succeed`);
      assert.equal(JSON.parse(r.body).holdsInWindow, i);
    }

    // 6th command hold should be rejected
    const r6 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'cmd-6',
        nextStep: 'next-6',
        wakeWhen: { command: 'echo 6', timeoutMs: 30_000 },
      },
    });
    assert.equal(r6.statusCode, 429, 'command mode must hit 429 at limit');
    const body = JSON.parse(r6.body);
    assert.equal(body.holdMode, 'command', '429 must include holdMode');
    assert.equal(body.holdsInWindow, 5);
    assert.equal(body.maxHoldsPerWindow, 5);
  });

  // ── Counter independence: timer and command don't cross-contaminate ───────

  test('timer and command counters are independent', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-indep', 'ma-indep');
    const { invocationId, callbackToken } = await registry.create('user-ma-indep', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // 3 timer holds (exhaust timer quota)
    for (let i = 1; i <= 3; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers,
        payload: {
          reason: `timer-${i}`,
          nextStep: `next-${i}`,
          wakeAfterMs: 60_000,
          waitSourceRef: VALID_WAIT_SOURCE_REF,
        },
      });
      assert.equal(r.statusCode, 200, `timer hold #${i} should succeed`);
    }

    // Timer quota exhausted
    const rTimerBlocked = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'timer-4',
        nextStep: 'next-4',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(rTimerBlocked.statusCode, 429, 'timer should be blocked at 3');

    // Command mode should still work (independent counter)
    const rCmd = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'cmd-after-timer-exhaust',
        nextStep: 'check',
        wakeWhen: { command: 'echo ok', timeoutMs: 30_000 },
      },
    });
    assert.equal(rCmd.statusCode, 200, 'command mode must NOT be blocked by timer counter');
    const cmdBody = JSON.parse(rCmd.body);
    assert.equal(cmdBody.holdMode, 'command');
    assert.equal(cmdBody.holdsInWindow, 1, 'command counter starts at 1 (independent)');
  });

  // ── F257: holdMode in guard rejection event ───────────────────────────────

  test('F257: 429 event includes holdMode for mode-aware telemetry', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-f257', 'ma-f257');
    const { invocationId, callbackToken } = await registry.create('user-ma-f257', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // Exhaust timer quota
    for (let i = 1; i <= 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers,
        payload: {
          reason: `t-${i}`,
          nextStep: `n-${i}`,
          wakeAfterMs: 60_000,
          waitSourceRef: VALID_WAIT_SOURCE_REF,
        },
      });
    }

    // Trigger 429
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'blocked',
        nextStep: 'pass ball',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });

    // Check the guard rejection event
    const rateLimitEvents = deps._guardRejectionEvents.filter((e) => e.kind === 'http_rate_limit');
    assert.ok(rateLimitEvents.length >= 1, 'at least one http_rate_limit event');
    assert.equal(rateLimitEvents[0].holdMode, 'timer', 'event must carry holdMode');
  });
});
