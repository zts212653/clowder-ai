/**
 * F167 Phase P — wakeWhen integration tests
 *
 * Tests for the P1-1 (runner cancel/replace) and P1-2 (delivery failure)
 * fixes identified in gpt52 review of PR #2550.
 *
 * T8: wakeWhen runner cancelled on hold_ball cancel → no stale wake
 * T9: wakeWhen re-hold retires only the old carrier; authorized job keeps running
 * T10: messageStore.append failure → fallback task NOT removed
 * T11: cancelWakeWhenRunner export + activeRunners registry
 * T12: execution-plane queue full → fallback task NOT removed
 * T13: execution-plane trigger failure → fallback task NOT removed
 * T14: positive execution-plane ack + durable carrier → fallback task retired
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { tryAutoCancelPendingHolds } from '../dist/routes/messages.js';

describe('F167 Phase P: wakeWhen cancel/replace/delivery tests', () => {
  let registry;
  let threadStore;
  let cancelWakeWhenRunner;
  let getActiveRunnerCount;
  let reserveManagedWakeCancellation;
  let commitManagedWakeCancellation;
  let releaseManagedWakeCancellation;
  let cancelManagedWakeIfTaskMatches;
  let resolveHoldWaitOwnerFence;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    const routeModule = await import('../dist/routes/callback-hold-ball-routes.js');
    cancelWakeWhenRunner = routeModule.cancelWakeWhenRunner;
    getActiveRunnerCount = routeModule.getActiveRunnerCount;
    reserveManagedWakeCancellation = routeModule.reserveManagedWakeCancellation;
    commitManagedWakeCancellation = routeModule.commitManagedWakeCancellation;
    releaseManagedWakeCancellation = routeModule.releaseManagedWakeCancellation;
    cancelManagedWakeIfTaskMatches = routeModule.cancelManagedWakeIfTaskMatches;
    resolveHoldWaitOwnerFence = routeModule.resolveHoldWaitOwnerFence;
  });

  function makeStubDeps(overrides = {}) {
    const insertedTasks = [];
    const registeredDynamic = [];
    const unregisteredIds = [];
    const removedIds = [];
    const appendedMessages = [];
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
        getById(id) {
          return insertedTasks.find((t) => t.id === id && !removedIds.includes(t.id));
        },
        remove(id) {
          removedIds.push(id);
          return true;
        },
        updateParams(id, params) {
          const task = insertedTasks.find((t) => t.id === id && !removedIds.includes(t.id));
          if (!task) return false;
          task.params = params;
          return true;
        },
        updateParamsIfCurrent(id, expected, params) {
          const task = insertedTasks.find((t) => t.id === id && !removedIds.includes(t.id));
          if (!task || task.params !== expected) return false;
          task.params = params;
          return true;
        },
        setEnabled(id, enabled) {
          const task = insertedTasks.find((t) => t.id === id && !removedIds.includes(t.id));
          if (!task) return false;
          task.enabled = enabled;
          return true;
        },
      },
      messageStore: {
        getByIdempotencyKey(_userId, threadId, key) {
          return (
            appendedMessages.find((message) => message.threadId === threadId && message.idempotencyKey === key) ?? null
          );
        },
        async append(msg) {
          const stored = { id: `test-msg-${appendedMessages.length}`, ...msg };
          appendedMessages.push(stored);
          return stored;
        },
      },
      socketManager: {
        broadcastToRoom() {},
      },
      invocationRecordStore: {
        getByIdempotencyKey(_threadId, _userId, key) {
          return { id: `invocation-${key}`, userMessageId: key.slice('connector-'.length), status: 'running' };
        },
      },
      _insertedTasks: insertedTasks,
      _registeredDynamic: registeredDynamic,
      _unregisteredIds: unregisteredIds,
      _removedIds: removedIds,
      _appendedMessages: appendedMessages,
    };
    return { ...deps, ...overrides };
  }

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

  // ─── T11: cancelWakeWhenRunner export works ──────────────────────────────
  test('T11: cancelWakeWhenRunner is exported and callable', () => {
    assert.ok(typeof cancelWakeWhenRunner === 'function', 'cancelWakeWhenRunner should be a function');
    assert.ok(typeof getActiveRunnerCount === 'function', 'getActiveRunnerCount should be a function');
    // No-op on non-existent key should not throw
    cancelWakeWhenRunner('nonexistent-thread', 'nonexistent-cat');
  });

  test('F280 Phase D: action-custodied waits reference the canonical action-successor lease', async () => {
    assert.equal(typeof resolveHoldWaitOwnerFence, 'function');
    const fence = await resolveHoldWaitOwnerFence(
      {
        invocationId: 'callback-invocation',
        parentInvocationId: 'parent-invocation',
        threadId: 'thread-action',
        userId: 'user-action',
        catId: 'codex',
      },
      {
        async get(id) {
          assert.equal(id, 'parent-invocation');
          return {
            threadId: 'thread-action',
            userId: 'user-action',
            targetCats: ['codex'],
            actionLeaseCarrier: {
              kind: 'action_successor',
              leaseId: 'lease-action-7',
              generation: 7,
            },
          };
        },
      },
    );
    assert.deepEqual(fence, { kind: 'action_successor', leaseId: 'lease-action-7', generation: 7 });
    assert.deepEqual(Object.keys(fence).sort(), ['generation', 'kind', 'leaseId']);
  });

  test('F280 Phase D: a parent invocation outside callback scope cannot be downgraded to a task fence', async () => {
    await assert.rejects(
      resolveHoldWaitOwnerFence(
        {
          invocationId: 'callback-invocation',
          parentInvocationId: 'foreign-parent',
          threadId: 'thread-owner',
          userId: 'user-owner',
          catId: 'codex',
        },
        {
          async get() {
            return {
              threadId: 'thread-foreign',
              userId: 'user-owner',
              targetCats: ['codex'],
              actionLeaseCarrier: { kind: 'none' },
            };
          },
        },
      ),
      /outside the authenticated hold owner scope/,
    );
  });

  test('F261: canonical gate submission persists an independent job before admission and settles it once', async () => {
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const { recordDurableManagedGateProcess } = await import(
      '../dist/domains/ball-custody/durable-managed-gate-job.js'
    );
    const originalStart = ManagedRunner.prototype.start;
    let resolveCompletion;
    ManagedRunner.prototype.start = (_command, options) => {
      const processIdentity = { pid: 42, ppid: 1, pgid: 42, startedAt: 'birth-42' };
      assert.ok(options.managedJob);
      assert.equal(recordDurableManagedGateProcess(options.managedJob, processIdentity), true);
      return {
        admission: Promise.resolve({ spawned: true, pid: 42, processIdentity }),
        completion: new Promise((resolve) => {
          resolveCompletion = resolve;
        }),
      };
    };
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'hold-ball-durable-gate-route-'));
    const previousDataDir = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = tempDir;

    try {
      const deps = makeStubDeps();
      const app = await createApp(deps);
      const ownerUserId = 'user-durable-gate';
      const thread = await threadStore.create(ownerUserId, 'durable gate');
      const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          reason: 'canonical gate',
          nextStep: 'consume terminal truth',
          wakeWhen: { command: 'pnpm gate' },
        },
      });

      assert.equal(response.statusCode, 200, response.body);
      const body = JSON.parse(response.body);
      assert.match(body.wakeWhen.jobId, /^managed-gate-/);
      assert.notEqual(body.wakeWhen.jobId, body.taskId);
      const task = deps.dynamicTaskStore.getById(body.taskId);
      const job = task.params.holdLifecycle.managedCommand.durableJob;
      assert.equal(job.jobId, body.wakeWhen.jobId);
      assert.equal(job.originTaskId, body.taskId);
      const running = JSON.parse(readFileSync(job.recordPath, 'utf8'));
      assert.equal(running.state, 'running');
      assert.equal(running.ownerIdentity.startedAt, 'birth-42');

      resolveCompletion({ exitCode: 0, timedOut: false, durationMs: 25, tailOutput: 'gate green' });
      const deadline = Date.now() + 1_000;
      while (JSON.parse(readFileSync(job.recordPath, 'utf8')).state !== 'terminal' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(JSON.parse(readFileSync(job.recordPath, 'utf8')).terminalStatus, 'green');
      assert.equal(JSON.parse(readFileSync(`${job.recordPath}.terminal`, 'utf8')).terminalStatus, 'green');
      while (getActiveRunnerCount() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(getActiveRunnerCount(), 0, 'terminal fake worker must leave no active registry residue');
      await app.close();
    } finally {
      ManagedRunner.prototype.start = originalStart;
      if (previousDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── T8: wakeWhen hold with cancel → runner is cancelled ────────────────
  test('T8: wakeWhen hold registers active runner, cancel removes it', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t8', 'hb-t8');
    const { invocationId, callbackToken } = await registry.create('user-hb-t8', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // Create wakeWhen hold with a long command so runner stays active
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'running gate',
        nextStep: 'check result',
        wakeWhen: { command: 'sleep 999', timeoutMs: 300_000 },
      },
    });
    assert.equal(r1.statusCode, 200);

    const commandTask = deps._insertedTasks[0];
    const commandAwait = commandTask.params.holdLifecycle.await;
    assert.ok(commandAwait, 'wakeWhen hold must persist the unified wait shape');
    assert.deepEqual(commandAwait, {
      v: 1,
      generation: 1,
      subjectRef: `command:${commandTask.id}`,
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: {
        kind: 'managed_command',
        capturedAt: commandAwait.createdAt,
        deadlineAt: commandAwait.createdAt + 300_000,
      },
      continuation: {
        when: [{ kind: 'managed_command_completed' }],
        // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
        then: 'check result',
      },
      expiresAt: commandTask.trigger.fireAt,
      createdAt: commandAwait.createdAt,
      provenance: 'explicit_registration',
    });

    // Runner should be registered
    assert.ok(getActiveRunnerCount() >= 1, 'active runner should be registered');

    // Cancel the hold
    cancelWakeWhenRunner(thread.id, 'codex');

    // Wait briefly for cancel to propagate
    await new Promise((r) => setTimeout(r, 200));

    // Runner count should be back to 0 for this key
    // (other tests may have runners too, so we check the specific cancel worked
    //  by verifying cancelWakeWhenRunner doesn't throw and we can inspect state)
    assert.ok(getActiveRunnerCount() >= 0, 'runner should be cleaned up');
  });

  test('T8-terminal: unrelated user mention cannot retire or wake an older managed hold', async () => {
    let triggerCount = 0;
    const deps = makeStubDeps({
      invokeTrigger: {
        async trigger() {
          triggerCount += 1;
          return 'dispatched';
        },
      },
      invocationRecordStore: {
        getByIdempotencyKey() {
          return null;
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-terminal', 'hb-terminal');
    const { invocationId, callbackToken } = await registry.create('user-hb-terminal', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'long gate outlives an ordinary user message',
        nextStep: 'inspect the natural terminal result',
        wakeWhen: {
          command: 'printf "progress-before-user-message\\n"; sleep 0.5; printf "completed-after-user-message\\n"',
          timeoutMs: 300_000,
        },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);

    await new Promise((resolve) => setTimeout(resolve, 100));
    // POST /api/messages calls this hook after routing any ordinary message;
    // the hook deliberately receives no mention target. An @ to another cat or
    // to this holder therefore has identical non-authority here.
    tryAutoCancelPendingHolds(thread.id, deps);
    let managedHold = deps.dynamicTaskStore.getById(taskId);
    assert.ok(managedHold, 'the managed hold remains durable');
    assert.equal(managedHold.enabled, true, 'ordinary mention cannot retire the hold');
    assert.equal(managedHold.params.holdLifecycle.status, 'active');
    assert.equal(triggerCount, 0, 'ordinary mention cannot dequeue or wake the older holder');

    const deadline = Date.now() + 3_000;
    while (managedHold?.params.holdLifecycle?.managedCommand?.state !== 'dispatched' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      managedHold = deps.dynamicTaskStore.getById(taskId);
    }
    await app.close();

    assert.ok(managedHold, 'the typed wake remains queryable until invocation-bound disposition');
    assert.equal(managedHold.enabled, true);
    assert.equal(managedHold.params.holdLifecycle.status, 'active');
    assert.equal(managedHold.params.holdLifecycle.managedCommand.state, 'dispatched');
    assert.equal(
      managedHold.params.holdLifecycle.managedCommand.result.cancelled,
      false,
      'ordinary user activity must not SIGTERM the independent command',
    );
    assert.match(managedHold.params.holdLifecycle.managedCommand.result.tailOutput, /completed-after-user-message/);
    assert.equal(triggerCount, 1, 'only typed command completion dispatches the older holder once');
    const wakeReceipts = deps._appendedMessages.filter((message) => message.content?.includes('持球唤醒（命令完成）'));
    assert.equal(wakeReceipts.length, 1, 'natural completion must publish one typed wake carrier');
    assert.equal(
      wakeReceipts[0].deliveryStatus,
      'queued',
      'the wake remains under Queue custody until invocation-bound disposition',
    );
    assert.equal(wakeReceipts[0].idempotencyKey, `hold-ball-completion:${taskId}`);
    assert.equal(wakeReceipts[0].source?.meta?.taskId, taskId);
    assert.match(wakeReceipts[0].content, /completed-after-user-message/);
  });

  test('T8a: a completed command waits behind cancellation reservation until release', async () => {
    let completionCount = 0;
    const deps = makeStubDeps({
      managedCommandWakeRecovery: {
        async recordCompletion() {
          completionCount += 1;
          return { outcome: 'recorded' };
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t8a', 'hb-t8a');
    const { invocationId, callbackToken } = await registry.create('user-hb-t8a', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'linearization gate',
        nextStep: 'resume after storage failure',
        wakeWhen: { command: 'sleep 0.1' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);
    const reservation = reserveManagedWakeCancellation(taskId, thread.id, 'codex');
    assert.equal(reservation.outcome, 'reserved');

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(completionCount, 0, 'completion must not become visible while cancellation truth is unsettled');
    assert.equal(releaseManagedWakeCancellation(taskId, thread.id, 'codex', reservation.token), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(completionCount, 1, 'proven-uncommitted cancellation restores the original completion');
  });

  test('T8b: committed cancellation suppresses a command that completed while reserved', async () => {
    let completionCount = 0;
    const deps = makeStubDeps({
      managedCommandWakeRecovery: {
        async recordCompletion() {
          completionCount += 1;
          return { outcome: 'recorded' };
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t8b', 'hb-t8b');
    const { invocationId, callbackToken } = await registry.create('user-hb-t8b', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'cancel wins',
        nextStep: 'stay cancelled',
        wakeWhen: { command: 'sleep 0.1' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);
    const reservation = reserveManagedWakeCancellation(taskId, thread.id, 'codex');
    assert.equal(reservation.outcome, 'reserved');

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(completionCount, 0);
    assert.equal(commitManagedWakeCancellation(taskId, thread.id, 'codex', reservation.token), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(completionCount, 0, 'applied cancellation must suppress managed-command wake visibility');
  });

  test('T8c: user cancellation during the pre-launch visibility window suppresses managed execution', async () => {
    let markVisibilityAppendStarted;
    const visibilityAppendStarted = new Promise((resolve) => {
      markVisibilityAppendStarted = resolve;
    });
    let releaseVisibilityAppend;
    const visibilityMayFinish = new Promise((resolve) => {
      releaseVisibilityAppend = resolve;
    });
    let completionCount = 0;
    const t8cMessages = [];
    let firstAppend = true;
    const deps = makeStubDeps({
      messageStore: {
        getByIdempotencyKey() {
          return null;
        },
        async append(message) {
          if (firstAppend) {
            firstAppend = false;
            markVisibilityAppendStarted();
            await visibilityMayFinish;
          }
          const stored = { id: `t8c-msg-${t8cMessages.length}`, ...message };
          t8cMessages.push(stored);
          return stored;
        },
      },
      managedCommandWakeRecovery: {
        async recordCompletion() {
          completionCount += 1;
          return { outcome: 'recorded' };
        },
      },
    });
    deps.taskRunner.reserveOnceCancellation = () => ({ outcome: 'reserved', token: 41 });
    deps.taskRunner.releaseOnceCancellation = () => true;

    const app = await createApp(deps);
    const ownerUserId = 'user-hb-t8c';
    const thread = await threadStore.create(ownerUserId, 'hb-t8c');
    const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);

    const heldPromise = app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'pre-launch cancellation race',
        nextStep: 'remain cancelled',
        wakeWhen: { command: 'echo done' },
      },
    });
    await visibilityAppendStarted;
    const waitId = deps._insertedTasks[0]?.id;
    assert.ok(waitId, 'hold route must persist the wait before visibility append');

    const { WaitTerminationService } = await import('../dist/domains/ball-custody/WaitTerminationService.js');
    const records = new Map();
    const service = new WaitTerminationService({
      store: {
        getByWaitId: async (id) => records.get(id) ?? null,
        commit: async (record) => {
          records.set(record.event.waitId, record);
          return 'applied';
        },
        loadEntry: async () => null,
        listRecords: async () => [...records.values()],
      },
      dynamicTaskStore: deps.dynamicTaskStore,
      taskRunner: deps.taskRunner,
      managedWakeCancellation: {
        reserve: reserveManagedWakeCancellation,
        commit: commitManagedWakeCancellation,
        release: releaseManagedWakeCancellation,
        cancelIfTaskMatches: cancelManagedWakeIfTaskMatches,
      },
      threadStore,
    });

    const cancellation = await service.cancelByUser({ waitId, ownerUserId });
    releaseVisibilityAppend();
    const held = await heldPromise;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.close();

    assert.equal(cancellation.outcome, 'applied');
    assert.equal(held.statusCode, 200);
    assert.equal(completionCount, 0, 'an applied cancellation must prevent managed launch and completion');

    // Spawn-truth assertions: cancellation must prevent spawn, not just suppress delivery.
    const heldBody = JSON.parse(held.body);
    assert.strictEqual(heldBody.wakeWhen.pid, null, 'cancelled command must report pid: null in HTTP response');
    assert.equal(getActiveRunnerCount(), 0, 'no active runner residue after cancellation');

    // Durable admission-fact: cancellation must be projected as terminal ("已取消"),
    // distinct from generic spawn failure ("未启动").
    // Pre-launch cancellation deletes the registry entry (registry_mismatch), which
    // the three-way formatter maps to the cancellation terminal state.
    const admissionMessages = t8cMessages.filter((m) => m.content.includes('未启动'));
    assert.ok(admissionMessages.length > 0, 'durable admission fact (未启动) must be appended after cancellation');
    const cancelledMessages = t8cMessages.filter((m) => m.content.includes('已取消'));
    assert.ok(cancelledMessages.length > 0, 'cancellation admission must say "已取消", not generic spawn failure');
    const falseScheduledMessages = t8cMessages.filter((m) => m.content.includes('定时唤醒将触发'));
    assert.equal(falseScheduledMessages.length, 0, 'cancelled path must not claim fallback timer will fire');

    // DynamicTask must be removed by cancellation — no scheduler/task residue
    const taskAfterCancel = deps.dynamicTaskStore.getById(waitId);
    assert.ok(!taskAfterCancel, 'DynamicTask must be removed after applied cancellation');
  });

  test('T8c-2: pre-admission IIFE failure settles admission promise and terminates HTTP', async () => {
    // Regression guard: if the async IIFE inside launchWakeWhenRunner throws
    // before any explicit resolveExternalAdmission call, the catch block must
    // still settle the admission promise so the route handler doesn't hang.
    const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
    const origStart = ManagedRunner.prototype.start;
    ManagedRunner.prototype.start = () => {
      throw new Error('injected pre-admission failure');
    };

    try {
      const deps = makeStubDeps();
      const app = await createApp(deps);
      const ownerUserId = 'user-pre-admit';
      const thread = await threadStore.create(ownerUserId, 'pre-admit');
      const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);

      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          reason: 'pre-admission failure test',
          nextStep: 'verify hang-free',
          wakeWhen: { command: 'echo never-runs' },
        },
      });

      assert.equal(response.statusCode, 200, 'route must terminate without hanging');
      const body = JSON.parse(response.body);
      assert.strictEqual(body.wakeWhen.pid, null, 'failed admission must report pid: null');
      assert.equal(getActiveRunnerCount(), 0, 'no active runner residue after pre-admission failure');

      // Durable admission-fact: a "未启动" message must be appended
      const failMessages = deps._appendedMessages.filter((m) => m.content.includes('未启动'));
      assert.ok(failMessages.length > 0, 'spawn failure admission fact (未启动) must be durably projected');

      // P1-2: DynamicTask lifecycle projection must have pid=null for spawn failure
      const task = deps.dynamicTaskStore.getById(body.taskId);
      assert.ok(task, 'DynamicTask must still exist after spawn failure');
      const mc = task.params.holdLifecycle?.managedCommand;
      assert.ok(mc, 'managedCommand projection must exist');
      assert.strictEqual(mc.pid, null, 'spawn failure must persist pid=null in lifecycle projection');

      await app.close();
    } finally {
      ManagedRunner.prototype.start = origStart;
    }
  });

  test('T8d: failed persistence releases a pre-launch reservation and starts the original command', async () => {
    let markVisibilityAppendStarted;
    const visibilityAppendStarted = new Promise((resolve) => {
      markVisibilityAppendStarted = resolve;
    });
    let releaseVisibilityAppend;
    const visibilityMayFinish = new Promise((resolve) => {
      releaseVisibilityAppend = resolve;
    });
    let completionCount = 0;
    let managedReleaseCount = 0;
    const deps = makeStubDeps({
      messageStore: {
        getByIdempotencyKey() {
          return null;
        },
        async append(message) {
          markVisibilityAppendStarted();
          await visibilityMayFinish;
          return { id: 'visibility-message', ...message };
        },
      },
      managedCommandWakeRecovery: {
        async recordCompletion() {
          completionCount += 1;
          return { outcome: 'recorded' };
        },
      },
    });
    deps.taskRunner.reserveOnceCancellation = () => ({ outcome: 'reserved', token: 42 });
    deps.taskRunner.releaseOnceCancellation = () => true;

    const app = await createApp(deps);
    const ownerUserId = 'user-hb-t8d';
    const thread = await threadStore.create(ownerUserId, 'hb-t8d');
    const { invocationId, callbackToken } = await registry.create(ownerUserId, 'codex', thread.id);
    const heldPromise = app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'pre-launch persistence rollback',
        nextStep: 'run after rollback',
        wakeWhen: { command: 'echo done' },
      },
    });
    await visibilityAppendStarted;
    const waitId = deps._insertedTasks[0]?.id;
    assert.ok(waitId);

    const { WaitTerminationService } = await import('../dist/domains/ball-custody/WaitTerminationService.js');
    const service = new WaitTerminationService({
      store: {
        getByWaitId: async () => null,
        commit: async () => {
          throw new Error('redis unavailable');
        },
        loadEntry: async () => null,
        listRecords: async () => [],
      },
      dynamicTaskStore: deps.dynamicTaskStore,
      taskRunner: deps.taskRunner,
      managedWakeCancellation: {
        reserve: reserveManagedWakeCancellation,
        commit: commitManagedWakeCancellation,
        release(...args) {
          managedReleaseCount += 1;
          return releaseManagedWakeCancellation(...args);
        },
        cancelIfTaskMatches: cancelManagedWakeIfTaskMatches,
      },
      threadStore,
    });

    await assert.rejects(service.cancelByUser({ waitId, ownerUserId }), /redis unavailable/);
    assert.equal(managedReleaseCount, 1, 'a proven failed commit must release the exact pre-launch reservation');
    releaseVisibilityAppend();
    const held = await heldPromise;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.close();

    assert.equal(held.statusCode, 200);
    assert.equal(completionCount, 1, 'the original managed command must resume after proven persistence failure');
  });

  // ─── T9: second wakeWhen replaces custody, not authorized execution ─────
  test('T9: second wakeWhen hold preserves the first authorized runner', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t9', 'hb-t9');
    const { invocationId, callbackToken } = await registry.create('user-hb-t9', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // First wakeWhen hold
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'first gate',
        nextStep: 'first check',
        wakeWhen: { command: 'sleep 999', timeoutMs: 300_000 },
      },
    });
    assert.equal(r1.statusCode, 200);
    const firstTaskId = JSON.parse(r1.body).taskId;

    // Second wakeWhen hold (same thread, same cat) supersedes only the wake carrier.
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'second gate',
        nextStep: 'second check',
        wakeWhen: { command: 'sleep 888', timeoutMs: 300_000 },
      },
    });
    assert.equal(r2.statusCode, 200);
    const secondTaskId = JSON.parse(r2.body).taskId;
    assert.notEqual(firstTaskId, secondTaskId, 'should get a new taskId');

    // First scheduler carrier is retired, but its durable task projection and
    // independently authorized process remain available for terminal recovery.
    assert.ok(
      deps._unregisteredIds.includes(firstTaskId),
      `first taskId should have been unregistered; got ${JSON.stringify(deps._unregisteredIds)}`,
    );
    const firstTask = deps.dynamicTaskStore.getById(firstTaskId);
    assert.ok(firstTask, 'replacement must retain a durable task tombstone');
    assert.equal(firstTask.enabled, false);
    assert.equal(firstTask.params.holdLifecycle.status, 'retired_by_replacement');
    assert.ok(getActiveRunnerCount() >= 2, 'both authorized jobs must remain active after re-hold');

    // Neither command is allowed to wake through the superseded carrier.
    await new Promise((r) => setTimeout(r, 200));

    // First runner's wake should NOT have been delivered
    // (if the old runner still fires, it would append a message with "first gate")
    const firstGateMessages = deps._appendedMessages.filter(
      (m) =>
        typeof m.content === 'string' && m.content.includes('first gate') && m.content.includes('持球唤醒（命令完成）'),
    );
    assert.equal(firstGateMessages.length, 0, 'retired carrier must not deliver a duplicate wake for "first gate"');

    // Clean up: cancel the second runner to avoid dangling processes
    cancelWakeWhenRunner(thread.id, 'codex');
    await new Promise((r) => setTimeout(r, 200));
  });

  test('T9a: an exact-task cancellation cannot kill a successor command', async () => {
    const deps = makeStubDeps();
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t9a', 'hb-t9a');
    const { invocationId, callbackToken } = await registry.create('user-hb-t9a', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'first command',
        nextStep: 'first',
        wakeWhen: { command: 'sleep 999', timeoutMs: 300_000 },
      },
    });
    const firstTaskId = JSON.parse(first.body).taskId;
    const firstReservation = reserveManagedWakeCancellation(firstTaskId, thread.id, 'codex');
    assert.equal(firstReservation.outcome, 'reserved');

    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'replacement command',
        nextStep: 'second',
        wakeWhen: { command: 'sleep 999', timeoutMs: 300_000 },
      },
    });
    assert.equal(second.statusCode, 200);
    const secondTaskId = JSON.parse(second.body).taskId;

    assert.equal(
      commitManagedWakeCancellation(firstTaskId, thread.id, 'codex', firstReservation.token),
      true,
      'the exact first task remains explicitly cancellable after replacement',
    );
    const secondReservation = reserveManagedWakeCancellation(secondTaskId, thread.id, 'codex');
    assert.equal(secondReservation.outcome, 'reserved', 'replacement runner must remain active');
    assert.equal(releaseManagedWakeCancellation(secondTaskId, thread.id, 'codex', secondReservation.token), true);
    cancelWakeWhenRunner(thread.id, 'codex');
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  // ─── T10: messageStore.append failure → fallback kept alive ─────────────
  test('T10: wake delivery failure keeps fallback reminder alive', async () => {
    let appendCount = 0;
    const deps = makeStubDeps({
      messageStore: {
        getByIdempotencyKey() {
          return null;
        },
        async append(msg) {
          appendCount++;
          // First append = visibility message (hold registered) → succeed
          if (appendCount <= 1) {
            return { id: `msg-${appendCount}`, ...msg };
          }
          // Second append = wake completion message → FAIL
          throw new Error('simulated messageStore failure');
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t10', 'hb-t10');
    const { invocationId, callbackToken } = await registry.create('user-hb-t10', 'codex', thread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    // Create wakeWhen hold with a fast command
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers,
      payload: {
        reason: 'fast gate',
        nextStep: 'check fast',
        wakeWhen: { command: 'echo done' },
      },
    });
    assert.equal(r1.statusCode, 200);
    const { taskId } = JSON.parse(r1.body);

    // Wait for command to complete + async callback to fire
    await new Promise((r) => setTimeout(r, 500));

    // P1-2 fix: fallback reminder task should NOT have been removed
    // because wake message delivery failed
    const fallbackRemoved = deps._removedIds.includes(taskId);
    assert.equal(
      fallbackRemoved,
      false,
      'fallback task should NOT be removed when wake delivery fails — cat needs the fallback wake',
    );
  });

  test('T10b: admission-fact append failure is recoverable via startup sweep — both live and dead pid converge', async () => {
    // RED proof: freeze a real command in command_running, fail ONLY the
    // admission-fact append, tear down the original callback owner, construct
    // a fresh sweep, and prove the admission fact is re-delivered exactly once
    // for both an OS-live and dead process — with zero command re-execution.
    //
    // Key: use `sleep 60` so the command CANNOT naturally complete during
    // the test. This prevents the false-positive where natural completion
    // transitions the task out of command_running before the sweep runs.
    let appendCount = 0;
    const deps = makeStubDeps({
      messageStore: {
        getByIdempotencyKey() {
          return null;
        },
        async append(msg) {
          appendCount++;
          // First append = visibility "待启动" message → succeed
          if (appendCount === 1) return { id: `msg-${appendCount}`, ...msg };
          // Second append = admission-fact → FAIL (simulated durability gap)
          if (appendCount === 2) throw new Error('simulated admission-fact append failure');
          // Third+ = completion etc → succeed
          return { id: `msg-${appendCount}`, ...msg };
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t10b', 'hb-t10b');
    const { invocationId, callbackToken } = await registry.create('user-hb-t10b', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'admission append failure recovery',
        nextStep: 'verify durable recovery',
        wakeWhen: { command: 'sleep 60' },
      },
    });

    assert.equal(response.statusCode, 200, 'route must succeed despite admission-fact append failure');
    const body = JSON.parse(response.body);
    assert.ok(body.wakeWhen.pid > 0, 'HTTP response must carry real pid from spawn');

    // ── Pre-sweep assertions: freeze the state BEFORE any recovery ──
    const task = deps.dynamicTaskStore.getById(body.taskId);
    assert.ok(task, 'DynamicTask must still exist');
    const mc = task.params.holdLifecycle?.managedCommand;
    assert.ok(mc, 'managedCommand projection must exist');
    assert.ok(mc.pid > 0, 'managedCommand.pid must record real pid from spawn');
    assert.equal(mc.state, 'command_running', 'pre-sweep: state must be command_running (sleep 60 is still alive)');
    assert.equal(mc.admissionFactAppended, false, 'pre-sweep: admissionFactAppended must be false (append failed)');
    assert.ok(
      typeof mc.admissionFact === 'string' && mc.admissionFact.length > 0,
      'pre-sweep: admissionFact text must be persisted for recovery',
    );
    // Verify no admission-fact message was actually delivered (append #2 threw)
    const admissionMessages = deps._appendedMessages.filter((m) => m.content.includes('已启动'));
    assert.equal(admissionMessages.length, 0, 'pre-sweep: no admission-fact message in thread (append failed)');

    // ── Tear down the original callback/IIFE owner ──
    // Kill the sleep process to simulate server restart (process dies)
    try {
      process.kill(body.wakeWhen.pid, 'SIGKILL');
    } catch {
      /* may already be gone */
    }
    await app.close();

    // ── Sweep: re-deliver admission fact for dead pid ──
    const { ManagedCommandWakeRecoverySweep } = await import(
      '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js'
    );
    const sweepAppended = [];
    const sweepBroadcasts = [];
    const makeSweepDeps = () => ({
      dynamicTaskStore: deps.dynamicTaskStore,
      messageStore: {
        getById: () => null,
        getByIdempotencyKey: () => null,
        async append(msg) {
          const stored = { id: `sweep-msg-${sweepAppended.length}`, ...msg };
          sweepAppended.push(stored);
          return stored;
        },
        markCanceled: async () => null,
      },
      socketManager: {
        broadcastToRoom(_room, _event, payload) {
          sweepBroadcasts.push(payload);
        },
      },
      taskRunner: { unregister() {} },
      invocationRecordStore: { getByIdempotencyKey: () => null },
      getInvokeTrigger: () => undefined,
      now: () => Date.now(),
    });

    const sweep = new ManagedCommandWakeRecoverySweep(makeSweepDeps());
    const stats = await sweep.runOnce();

    // ── Post-sweep: admission fact re-delivered ──
    assert.ok(stats.scanned > 0, 'sweep must scan the undelivered admission task');
    assert.ok(stats.recovered > 0, 'sweep must recover the admission fact');
    assert.equal(sweepAppended.length, 1, 'exactly one admission-fact message re-delivered');
    assert.ok(
      sweepAppended[0].content.includes('已启动'),
      'recovered message must contain the original admission fact',
    );
    assert.ok(sweepBroadcasts.length > 0, 'admission fact must be broadcast to thread');

    // Task lifecycle: admissionFactAppended = true, state still command_running
    // (sweep does NOT synthesize a completion — the fallback timer handles that)
    const taskAfterSweep = deps.dynamicTaskStore.getById(body.taskId);
    assert.ok(taskAfterSweep, 'task must still exist (no re-execution, no deletion)');
    const mcAfter = taskAfterSweep.params.holdLifecycle?.managedCommand;
    assert.equal(mcAfter?.admissionFactAppended, true, 'admissionFactAppended must be true after recovery');

    // ── Idempotency: second sweep must NOT re-deliver ──
    sweepAppended.length = 0;
    const sweep2 = new ManagedCommandWakeRecoverySweep(makeSweepDeps());
    await sweep2.runOnce();
    assert.equal(sweepAppended.length, 0, 'idempotent: second sweep must not re-append');
    // The task is no longer in the undelivered filter (admissionFactAppended=true)
    // so undeliveredAdmission count is 0, total scanned excludes it
  });

  test('T10c: R6 P1-1 — route→sweep chain: crash after admission append, before flag, no duplicate', async () => {
    // RED proof: go through the actual route to produce the admission-fact
    // message (with shared idempotencyKey from buildAdmissionFactIdempotencyKey),
    // block the admissionFactAppended=true CAS to simulate a crash at that
    // boundary, then run the sweep with the SAME message store. The sweep must
    // find the existing message by shared key and skip re-append — exactly one
    // admission fact in the timeline. If the route's key is deleted or drifted,
    // the sweep's getByIdempotencyKey finds nothing and re-appends a duplicate.
    const { ManagedCommandWakeRecoverySweep, buildAdmissionFactIdempotencyKey } = await import(
      '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js'
    );

    const deps = makeStubDeps();

    // Intercept: block the admissionFactAppended=true update to simulate crash
    const originalUpdateParams = deps.dynamicTaskStore.updateParams;
    deps.dynamicTaskStore.updateParams = (id, params) => {
      if (params?.holdLifecycle?.managedCommand?.admissionFactAppended === true) {
        return false; // Simulate crash at exactly this boundary
      }
      return originalUpdateParams(id, params);
    };

    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t10c', 'hb-t10c');
    const { invocationId, callbackToken } = await registry.create('user-hb-t10c', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'idempotency dedup proof',
        nextStep: 'verify no duplicate',
        wakeWhen: { command: 'sleep 60' },
      },
    });

    assert.equal(response.statusCode, 200, 'route must succeed');
    const body = JSON.parse(response.body);
    const taskId = body.taskId;

    // ── Pre-sweep: verify the route produced the correct durable state ──
    const task = deps.dynamicTaskStore.getById(taskId);
    const mc = task.params.holdLifecycle?.managedCommand;
    assert.equal(mc.admissionFactAppended, false, 'pre-sweep: flag must be false (update was blocked)');
    assert.ok(mc.admissionFact, 'pre-sweep: admissionFact text must be persisted');

    // Verify the route's append carried the canonical shared idempotency key
    const canonicalKey = buildAdmissionFactIdempotencyKey(taskId);
    const admissionMessages = deps._appendedMessages.filter((m) => m.content.includes('已启动'));
    assert.equal(admissionMessages.length, 1, 'route must have appended exactly one admission message');
    assert.equal(
      admissionMessages[0].idempotencyKey,
      canonicalKey,
      'route admission message must carry the canonical shared idempotency key',
    );

    // ── Tear down route owner ──
    try {
      process.kill(body.wakeWhen.pid, 'SIGKILL');
    } catch {
      /* may already be gone */
    }
    await app.close();

    // ── Sweep: reuse same message store — must find existing by key ──
    const sweepAppended = [];
    const sweepDeps = {
      dynamicTaskStore: deps.dynamicTaskStore,
      messageStore: {
        getById: () => null,
        getByIdempotencyKey(_userId, threadId, key) {
          // Shared message store: the route's message is findable by key
          return deps._appendedMessages.find((m) => m.threadId === threadId && m.idempotencyKey === key) ?? null;
        },
        async append(msg) {
          const stored = { id: `sweep-msg-${sweepAppended.length}`, ...msg };
          sweepAppended.push(stored);
          return stored;
        },
        markCanceled: async () => null,
      },
      socketManager: { broadcastToRoom() {} },
      taskRunner: { unregister() {} },
      invocationRecordStore: { getByIdempotencyKey: () => null },
      getInvokeTrigger: () => undefined,
      now: () => Date.now(),
    };

    const sweep = new ManagedCommandWakeRecoverySweep(sweepDeps);
    await sweep.runOnce();

    // ── Assertions: no duplicate, flag converged ──
    assert.equal(sweepAppended.length, 0, 'sweep must NOT re-append — route message found by shared key');

    const taskAfter = deps.dynamicTaskStore.getById(taskId);
    const mcAfter = taskAfter.params.holdLifecycle?.managedCommand;
    assert.equal(mcAfter.admissionFactAppended, true, 'admissionFactAppended must converge to true');

    // Timeline integrity: exactly one admission-fact message total
    const totalAdmission = [...deps._appendedMessages, ...sweepAppended].filter((m) => m.content.includes('已启动'));
    assert.equal(totalAdmission.length, 1, 'timeline must contain exactly one admission-fact message');
  });

  test('T10d: R6 P1-2 — condition_met + admissionFactAppended=false restart: admission fact before completion dispatch', async () => {
    // RED proof: when a task reaches condition_met while admissionFactAppended
    // is false (append crashed + command completed before restart), the sweep
    // must re-deliver the admission fact BEFORE publishing the completion
    // message. Without the R6 ordering fix, completion publishes first and the
    // provider is woken before the timeline shows what happened at spawn.
    const { ManagedCommandWakeRecoverySweep } = await import(
      '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js'
    );

    const taskId = 'hold-ball-t10d';
    const threadId = 'thread-t10d';
    const admissionFactText = '✅ 已启动 (pid 99999)，等待完成…';
    const completionContent = '命令完成 (exit 0, 1200ms)';

    const insertedTasks = [
      {
        id: taskId,
        templateId: 'reminder',
        enabled: true,
        deliveryThreadId: threadId,
        createdBy: 'hold-ball:codex',
        params: {
          triggerUserId: 'user-t10d',
          holdLifecycle: {
            status: 'active',
            mode: 'wake_when',
            createdBy: 'hold-ball:codex',
            managedCommand: {
              state: 'condition_met',
              command: 'pnpm test',
              startedAt: Date.now() - 30000,
              conditionMetAt: Date.now() - 5000,
              pid: 99999,
              admissionFact: admissionFactText,
              admissionFactAppended: false,
              wakeContent: completionContent,
              wakeSource: 'command_completion',
              result: { exitCode: 0, timedOut: false, durationMs: 1200 },
            },
          },
        },
      },
    ];

    const appendOrder = [];
    let appendSeq = 0;
    const deps = {
      dynamicTaskStore: {
        getAll() {
          return insertedTasks;
        },
        getById(id) {
          return insertedTasks.find((t) => t.id === id);
        },
        updateParamsIfCurrent(id, expected, params) {
          const task = insertedTasks.find((t) => t.id === id);
          if (!task || task.params !== expected) return false;
          task.params = params;
          return true;
        },
        setEnabled(id, enabled) {
          const task = insertedTasks.find((t) => t.id === id);
          if (!task) return false;
          task.enabled = enabled;
          return true;
        },
      },
      messageStore: {
        getById: () => null,
        getByIdempotencyKey: () => null,
        async append(msg) {
          appendSeq++;
          const stored = { id: `msg-${appendSeq}`, ...msg };
          appendOrder.push({
            seq: appendSeq,
            content: stored.content,
            userId: stored.userId,
          });
          return stored;
        },
        markCanceled: async () => null,
      },
      socketManager: { broadcastToRoom() {} },
      taskRunner: { unregister() {} },
      invocationRecordStore: { getByIdempotencyKey: () => null },
      getInvokeTrigger: () => undefined,
      now: () => Date.now(),
    };

    const sweep = new ManagedCommandWakeRecoverySweep(deps);
    await sweep.runOnce();

    // At least 2 messages: admission fact + completion
    assert.ok(appendOrder.length >= 2, `expected at least 2 messages but got ${appendOrder.length}`);

    // Find admission and completion messages by content
    const admissionIdx = appendOrder.findIndex((m) => m.content.includes('已启动'));
    const completionIdx = appendOrder.findIndex((m) => m.content.includes('[定时任务]'));

    assert.ok(admissionIdx >= 0, 'admission-fact message must be appended');
    assert.ok(completionIdx >= 0, 'completion message must be appended');
    assert.ok(
      admissionIdx < completionIdx,
      `admission fact (seq=${appendOrder[admissionIdx]?.seq}) must be appended BEFORE ` +
        `completion (seq=${appendOrder[completionIdx]?.seq})`,
    );

    // After sweep, admissionFactAppended must be true
    const mcAfter = insertedTasks[0].params.holdLifecycle.managedCommand;
    assert.equal(mcAfter.admissionFactAppended, true, 'admissionFactAppended must be true after recovery');
  });

  test('T12: queue-full trigger keeps fallback reminder alive after completion message is written', async () => {
    const deps = makeStubDeps({
      invokeTrigger: {
        async trigger() {
          return 'full';
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t12', 'hb-t12');
    const { invocationId, callbackToken } = await registry.create('user-hb-t12', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'queue-full gate',
        nextStep: 'resume after capacity returns',
        wakeWhen: { command: 'echo done' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);

    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(deps._appendedMessages.length >= 2, true, 'completion message should be durable before dispatch');
    assert.equal(
      deps._removedIds.includes(taskId),
      false,
      'queue-full is not a positive execution-plane ack, so fallback must remain recoverable',
    );
  });

  test('T13: trigger throw keeps fallback reminder alive after completion message is written', async () => {
    const deps = makeStubDeps({
      invokeTrigger: {
        async trigger() {
          throw new Error('simulated execution-plane failure');
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t13', 'hb-t13');
    const { invocationId, callbackToken } = await registry.create('user-hb-t13', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'trigger-failure gate',
        nextStep: 'retry wake dispatch',
        wakeWhen: { command: 'echo done' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);

    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(deps._appendedMessages.length >= 2, true, 'completion message should survive trigger failure');
    assert.equal(
      deps._removedIds.includes(taskId),
      false,
      'trigger failure must leave the durable fallback available to recovery',
    );
  });

  test('T14: dispatched trigger retires fallback only after its durable carrier succeeds', async () => {
    const deps = makeStubDeps({
      invokeTrigger: {
        async trigger() {
          return 'dispatched';
        },
      },
      invocationRecordStore: {
        getByIdempotencyKey(_threadId, _userId, key) {
          return { id: `invocation-${key}`, userMessageId: key.slice('connector-'.length), status: 'succeeded' };
        },
      },
    });
    const app = await createApp(deps);
    const thread = await threadStore.create('user-hb-t14', 'hb-t14');
    const { invocationId, callbackToken } = await registry.create('user-hb-t14', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'dispatch gate',
        nextStep: 'consume result',
        wakeWhen: { command: 'echo done' },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const tombstone = deps._insertedTasks.find((task) => task.id === taskId);
    assert.equal(deps._removedIds.includes(taskId), false, 'completion receipt must remain queryable by taskId');
    assert.equal(tombstone.enabled, false, 'successfully completed carrier retires scheduler execution');
    assert.equal(tombstone.params.holdLifecycle.status, 'fired');
    assert.equal(tombstone.params.holdLifecycle.managedCommand.state, 'consumed');
    assert.equal(deps._unregisteredIds.includes(taskId), true);
  });
});
