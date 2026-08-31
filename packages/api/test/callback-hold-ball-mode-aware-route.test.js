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

  // ── P1: concurrency safety (atomic reservation) ───────────────────────────

  test('P1 concurrency: from count 4, concurrent command requests admit at most 1', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-conc', 'ma-conc');
    const { invocationId, callbackToken } = await registry.create('user-ma-conc', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // Pre-fill command counter to 4 (one below limit of 5)
    for (let i = 1; i <= 4; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers,
        payload: {
          reason: `prefill-${i}`,
          nextStep: `next-${i}`,
          wakeWhen: { command: `echo prefill-${i}`, timeoutMs: 30_000 },
        },
      });
      assert.equal(r.statusCode, 200, `prefill hold #${i} should succeed`);
    }

    // Fire 8 concurrent requests (all arrive at the route handler "simultaneously")
    const concurrentRequests = Array.from({ length: 8 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers,
        payload: {
          reason: `concurrent-${i}`,
          nextStep: `next-${i}`,
          wakeWhen: { command: `echo concurrent-${i}`, timeoutMs: 30_000 },
        },
      }),
    );
    const results = await Promise.all(concurrentRequests);
    const accepted = results.filter((r) => r.statusCode === 200);
    const rejected = results.filter((r) => r.statusCode === 429);

    assert.equal(
      accepted.length,
      1,
      `from count 4 (max 5), exactly 1 concurrent request should be admitted; got ${accepted.length}`,
    );
    assert.equal(
      rejected.length,
      7,
      `from count 4 (max 5), 7 concurrent requests should be rejected; got ${rejected.length}`,
    );

    // Verify the admitted request has the correct count
    const admittedBody = JSON.parse(accepted[0].body);
    assert.equal(admittedBody.holdsInWindow, 5);
    assert.equal(admittedBody.holdMode, 'command');

    // Verify rejected requests report the correct count
    for (const r of rejected) {
      const body = JSON.parse(r.body);
      assert.equal(body.holdMode, 'command');
      assert.equal(body.holdsInWindow, 5);
      assert.equal(body.maxHoldsPerWindow, 5);
    }
  });

  test('P1 rollback: insert failure releases reservation (sol R2 P1)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-insert-fail', 'ma-insert-fail');
    const { invocationId, callbackToken } = await registry.create('user-ma-insert-fail', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // First hold succeeds (count=1)
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'first',
        nextStep: 'next',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(JSON.parse(r1.body).holdsInWindow, 1);

    // Make insert() throw for the next request
    deps.dynamicTaskStore.insert = () => {
      throw new Error('insert boom');
    };

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'will-fail-insert',
        nextStep: 'irrelevant',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r2.statusCode, 500, 'insert failure returns 500');

    // Restore insert
    const insertedTasks = deps._insertedTasks;
    deps.dynamicTaskStore.insert = (record) => {
      insertedTasks.push(record);
    };

    // Third hold should succeed with count=2 (not 3), proving rollback worked
    const r3 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'after-insert-rollback',
        nextStep: 'continue',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r3.statusCode, 200);
    assert.equal(JSON.parse(r3.body).holdsInWindow, 2, 'after insert failure rollback, counter should be 2 not 3');
  });

  test('P1 concurrency: scheduler failure rolls back reservation', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-rollback', 'ma-rollback');
    const { invocationId, callbackToken } = await registry.create('user-ma-rollback', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // First hold succeeds
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'first',
        nextStep: 'next',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(JSON.parse(r1.body).holdsInWindow, 1);

    // Make scheduler fail for the next request
    deps.taskRunner.registerDynamic = () => {
      throw new Error('scheduler boom');
    };

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'will-fail',
        nextStep: 'irrelevant',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r2.statusCode, 500, 'scheduler failure returns 500');

    // Restore scheduler
    deps.taskRunner.registerDynamic = (spec, taskId) => {
      deps._registeredDynamic.push({ spec, taskId });
    };

    // Third hold should succeed with count=2 (not 3), proving rollback worked
    const r3 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'after-rollback',
        nextStep: 'continue',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r3.statusCode, 200);
    assert.equal(JSON.parse(r3.body).holdsInWindow, 2, 'after scheduler failure rollback, counter should be 2 not 3');
  });

  test('P1 rollback: getAll failure does not leak reservation (sol R3)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-getall-fail', 'ma-getall-fail');
    const { invocationId, callbackToken } = await registry.create('user-ma-getall-fail', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // First hold succeeds (count=1)
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'first',
        nextStep: 'next',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(JSON.parse(r1.body).holdsInWindow, 1);

    // Make getAll() throw for the next request
    deps.dynamicTaskStore.getAll = () => {
      throw new Error('getAll boom');
    };

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'will-fail-getall',
        nextStep: 'irrelevant',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r2.statusCode, 500, 'getAll failure returns 500');

    // Restore getAll
    const insertedTasks = deps._insertedTasks;
    const removedIds = deps._removedIds;
    deps.dynamicTaskStore.getAll = () => insertedTasks.filter((t) => !removedIds.includes(t.id));

    // Third hold should succeed with count=2 (not 3), proving no leaked reservation
    const r3 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'after-getall-rollback',
        nextStep: 'continue',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r3.statusCode, 200);
    assert.equal(
      JSON.parse(r3.body).holdsInWindow,
      2,
      'getAll failure must not leak reservation — count should be 2 not 3',
    );
  });

  test('P1 rollback: insert + remove double failure still releases reservation (sol R3)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-ma-dbl-fail', 'ma-dbl-fail');
    const { invocationId, callbackToken } = await registry.create('user-ma-dbl-fail', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // First hold succeeds (count=1)
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'first',
        nextStep: 'next',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(JSON.parse(r1.body).holdsInWindow, 1);

    // Make registerDynamic throw, AND make remove throw (double failure)
    deps.taskRunner.registerDynamic = () => {
      throw new Error('register boom');
    };
    deps.dynamicTaskStore.remove = () => {
      throw new Error('remove boom');
    };

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'will-double-fail',
        nextStep: 'irrelevant',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r2.statusCode, 500, 'double failure returns 500');

    // Restore both
    deps.taskRunner.registerDynamic = (spec, taskId) => {
      deps._registeredDynamic.push({ spec, taskId });
    };
    deps.dynamicTaskStore.remove = (id) => {
      deps._removedIds.push(id);
      return true;
    };

    // Third hold should succeed with count=2 (not 3), proving reservation was released
    // despite remove() throwing in the catch block
    const r3 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'after-double-failure',
        nextStep: 'continue',
        wakeAfterMs: 60_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });
    assert.equal(r3.statusCode, 200);
    assert.equal(
      JSON.parse(r3.body).holdsInWindow,
      2,
      'double failure (insert+remove) must still release reservation — count should be 2 not 3',
    );
  });

  test('P2 rollback: lastAt is restored, not extended by failed request (sol R2 P2)', async () => {
    // Test directly on counter module: a failed reservation should not extend
    // the window for legitimate holds.
    const { tryReserveHold, releaseHoldReservation, getTimerHoldCount, HOLD_MODE_TIMER, HOLD_WINDOW_MS } = await import(
      '../dist/routes/hold-ball-counter.js'
    );

    const tid = 'thread_lastat_test';
    const cid = 'cat_lastat';

    // Hold #1 at time T_old (near the start of a window)
    const T_old = Date.now() - HOLD_WINDOW_MS + 60_000; // 1 min before window expires
    const r1 = tryReserveHold(HOLD_MODE_TIMER, tid, cid, T_old);
    assert.equal(r1.admitted, true);
    assert.equal(r1.count, 1);

    // Failed hold at T_new (much later, refreshes window)
    const T_new = Date.now();
    const r2 = tryReserveHold(HOLD_MODE_TIMER, tid, cid, T_new);
    assert.equal(r2.admitted, true);
    assert.equal(r2.count, 2);

    // Rollback the failed hold with prior snapshot
    releaseHoldReservation(HOLD_MODE_TIMER, tid, cid, r2._prior);

    // Count should be 1 (decremented)
    const countAfter = getTimerHoldCount(tid, cid, T_new);
    assert.equal(countAfter, 1, 'count should be 1 after rollback');

    // The window should reflect T_old, not T_new.
    // If lastAt was correctly restored, checking at T_old + WINDOW + 1ms
    // should show the window expired (count=0). If lastAt stayed at T_new,
    // the window would still be active.
    const pastOldWindow = T_old + HOLD_WINDOW_MS + 1;
    const countPastOld = getTimerHoldCount(tid, cid, pastOldWindow);
    assert.equal(
      countPastOld,
      0,
      'window should expire at T_old + WINDOW_MS, not T_new + WINDOW_MS (lastAt must be restored)',
    );
  });
});
