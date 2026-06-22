/**
 * F167 gate-keeping thread guard — hold_ball endpoint.
 *
 * 守门 thread default-block hold_ball——已 cross_post / propose 分发后不再
 * 替下游 hold（opensource-ops SKILL Common Mistakes #8）。
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 gate-keeping guard: POST /api/callbacks/hold-ball', () => {
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
        unregister() {},
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
        remove() {},
        getAll() {
          return [];
        },
      },
      messageStore: {
        async append(msg) {
          return { id: 'msg-1', timestamp: Date.now(), ...msg };
        },
      },
      socketManager: {
        broadcastToRoom() {},
      },
      threadStore,
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

  test('INV-G4: non-gate-keeping thread → 200 (regression cover)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-g4', 'normal-thread');
    const { invocationId, callbackToken } = await registry.create('user-hb-g4', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'waiting CI', nextStep: 'verify merge', wakeAfterMs: 60_000 },
    });

    assert.equal(response.statusCode, 200, 'normal thread hold_ball must succeed');
    assert.equal(deps._insertedTasks.length, 1, 'hold task must be scheduled');
  });

  test('INV-G2: gate-keeping thread + long SLA → 400 gate_keeping_thread_default_blocked', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-g2', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-hb-g2', 'opus', thread.id);

    // PR-O3: use long SLA (> 10 min) to trigger block. Short SLAs are now allowed.
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'waiting external author', nextStep: 'check reply', wakeAfterMs: 1_800_000 },
    });

    assert.equal(response.statusCode, 400, 'gate-keeping thread must block long-SLA hold_ball');
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'gate_keeping_thread_default_blocked');
    assert.equal(body.tool, 'hold_ball');
    assert.equal(body.threadKind, 'gate-keeping');

    // 关键：guard 在 task insert 之前 short-circuit
    assert.equal(deps._insertedTasks.length, 0, 'hold task must NOT be scheduled when guard blocks');
  });

  test("INV-G3': override claim ignored, guard still hard-blocks long-SLA hold_ball (R1 review fix)", async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-g3', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-hb-g3', 'opus', thread.id);

    // PR-O3: use long SLA so override is truly the variable under test.
    // With short SLA, the hold would be allowed by policy (not by override).
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'waiting CI on downstream PR I own',
        nextStep: 'verify merge',
        wakeAfterMs: 1_800_000,
        override: 'i-am-the-downstream-owner',
      },
    });

    assert.equal(response.statusCode, 400, 'override claim must NOT escape — gate-keeping is hard-block');
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'gate_keeping_thread_default_blocked');
    assert.equal(deps._insertedTasks.length, 0, 'hold task must NOT be scheduled');
  });

  // ── PR-O3: structured allow for short-SLA holds ─────────────────

  test('PR-O3→O4: gate-keeping + short SLA + waitSourceRef → 200 allowed (grounded hold)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-o3a', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-hb-o3a', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'checking 👀 reaction',
        nextStep: 'verify cloud accepted',
        wakeAfterMs: 120_000,
        waitSourceRef: {
          kind: 'github_comment',
          value: 'https://github.com/owner/repo/issues/42#issuecomment-123',
          expectedSignal: 'cloud review reaction',
          slaUntilMs: 1781972000000,
        },
      },
    });

    assert.equal(response.statusCode, 200, 'short-SLA grounded hold must be allowed in gate-keeping thread');
    assert.equal(deps._insertedTasks.length, 1, 'hold task must be scheduled');
  });

  test('PR-O3: gate-keeping + long SLA (30 min) → 400 blocked', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-o3b', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-hb-o3b', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'waiting for external author response', nextStep: 'check reply', wakeAfterMs: 1_800_000 },
    });

    assert.equal(response.statusCode, 400, 'long-SLA hold must be blocked in gate-keeping thread');
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'gate_keeping_thread_default_blocked');
    assert.equal(deps._insertedTasks.length, 0, 'hold task must NOT be scheduled');
  });

  test('PR-O3→O4: gate-keeping + exactly 10 min SLA + waitSourceRef → 200 allowed (boundary)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-o3c', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-hb-o3c', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'operational check',
        nextStep: 'verify result',
        wakeAfterMs: 600_000,
        waitSourceRef: {
          kind: 'github_issue',
          value: 'https://github.com/owner/repo/issues/99',
          expectedSignal: 'issue label change',
          slaUntilMs: 1781972000000,
        },
      },
    });

    assert.equal(response.statusCode, 200, 'grounded hold at exactly 10 min must be allowed');
    assert.equal(deps._insertedTasks.length, 1, 'hold task must be scheduled');
  });

  test('PR-O4: gate-keeping + short SLA + NO waitSourceRef → 400 (ungrounded hold)', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-o4-ung', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-hb-o4-ung', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      // Short SLA but NO waitSourceRef → ungrounded → blocked
      payload: { reason: 'checking something', nextStep: 'verify', wakeAfterMs: 120_000 },
    });

    assert.equal(response.statusCode, 400, 'ungrounded short-SLA hold must be blocked in gate-keeping thread');
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'gate_keeping_thread_default_blocked');
    assert.match(body.reason, /waitSourceRef/, 'reason must mention waitSourceRef requirement');
    assert.equal(deps._insertedTasks.length, 0, 'hold task must NOT be scheduled');
  });

  // ── PR-O4: event callback detection via cross-store query ──────────

  test('PR-O4 R1: gate-keeping + short SLA + waitSourceRef + UNRELATED tracking → 200 (hold NOT redundant)', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const taskStoreInstance = new TaskStore();

    const thread = await threadStore.create('user-hb-o4r1', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');

    // Active tracking for issue #99 — UNRELATED to the hold's subject (issue #42)
    taskStoreInstance.create({
      threadId: thread.id,
      userId: 'user-hb-o4r1',
      title: 'Issue tracking for org/repo#99',
      kind: 'issue_tracking',
      subjectKey: 'issue:org/repo#99',
    });

    const deps = makeStubDeps({ taskStore: taskStoreInstance });
    const app = await createApp(deps);
    const { invocationId, callbackToken } = await registry.create('user-hb-o4r1', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'checking cloud review reaction',
        nextStep: 'verify acceptance',
        wakeAfterMs: 120_000,
        // waitSourceRef points to issue #42 — unrelated to tracking for issue #99
        waitSourceRef: {
          kind: 'github_issue',
          value: 'https://github.com/org/repo/issues/42',
          expectedSignal: 'reaction check',
          slaUntilMs: 1781972000000,
        },
      },
    });

    assert.equal(response.statusCode, 200, 'unrelated tracking must NOT block grounded hold (P1 fix: 误杀 prevention)');
    assert.equal(deps._insertedTasks.length, 1, 'hold task must be scheduled');
  });

  test('PR-O4: gate-keeping + short SLA + active PR tracking → 400 (event-backed hold redundant)', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const taskStoreInstance = new TaskStore();

    const thread = await threadStore.create('user-hb-o4a', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');

    // Pre-register PR tracking in the same thread
    taskStoreInstance.create({
      threadId: thread.id,
      userId: 'user-hb-o4a',
      title: 'PR tracking for owner/repo#42',
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#42',
    });

    const deps = makeStubDeps({ taskStore: taskStoreInstance });
    const app = await createApp(deps);
    const { invocationId, callbackToken } = await registry.create('user-hb-o4a', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      // Short SLA would normally be allowed — but event callback makes hold redundant
      payload: { reason: 'waiting CI', nextStep: 'check result', wakeAfterMs: 120_000 },
    });

    assert.equal(response.statusCode, 400, 'event-backed hold must be blocked (redundant)');
    const body = JSON.parse(response.body);
    assert.match(body.reason, /冗余/, 'reason must mention redundancy');
    assert.equal(deps._insertedTasks.length, 0, 'hold task must NOT be scheduled');
  });

  test('PR-O4: gate-keeping + short SLA + waitSourceRef + no taskStore → 200 (fail-open, no callback assumed)', async () => {
    // No taskStore injected → detectEventCallback defaults to false → hold allowed
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-o4b', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-hb-o4b', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'quick check',
        nextStep: 'verify',
        wakeAfterMs: 120_000,
        waitSourceRef: {
          kind: 'github_issue',
          value: 'https://github.com/owner/repo/issues/7',
          expectedSignal: 'status update',
          slaUntilMs: 1781972000000,
        },
      },
    });

    assert.equal(response.statusCode, 200, 'no taskStore → fail-open → grounded hold allowed');
  });

  test('PR-O4: gate-keeping + short SLA + waitSourceRef + done tracking only → 200 (no active callback)', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const taskStoreInstance = new TaskStore();

    const thread = await threadStore.create('user-hb-o4c', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');

    // PR tracking exists but is done → not an active callback
    const task = taskStoreInstance.create({
      threadId: thread.id,
      userId: 'user-hb-o4c',
      title: 'PR tracking completed',
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#99',
    });
    taskStoreInstance.update(task.id, { status: 'done' });

    const deps = makeStubDeps({ taskStore: taskStoreInstance });
    const app = await createApp(deps);
    const { invocationId, callbackToken } = await registry.create('user-hb-o4c', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'quick check',
        nextStep: 'verify',
        wakeAfterMs: 120_000,
        waitSourceRef: {
          kind: 'github_issue',
          value: 'https://github.com/owner/repo/issues/99',
          expectedSignal: 'issue closure',
          slaUntilMs: 1781972000000,
        },
      },
    });

    assert.equal(response.statusCode, 200, 'done tracking → no active callback → grounded hold allowed');
  });
});
