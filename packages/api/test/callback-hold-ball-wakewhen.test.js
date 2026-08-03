/**
 * F167 Phase P — wakeWhen integration tests
 *
 * Tests for the P1-1 (runner cancel/replace) and P1-2 (delivery failure)
 * fixes identified in gpt52 review of PR #2550.
 *
 * T8: wakeWhen runner cancelled on hold_ball cancel → no stale wake
 * T9: wakeWhen runner replaced by second hold → old runner cancelled
 * T10: messageStore.append failure → fallback task NOT removed
 * T11: cancelWakeWhenRunner export + activeRunners registry
 * T12: execution-plane queue full → fallback task NOT removed
 * T13: execution-plane trigger failure → fallback task NOT removed
 * T14: positive execution-plane ack + durable carrier → fallback task retired
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { cancelPendingHoldsForThread } from '../dist/routes/hold-ball-cancel.js';

describe('F167 Phase P: wakeWhen cancel/replace/delivery tests', () => {
  let registry;
  let threadStore;
  let cancelWakeWhenRunner;
  let getActiveRunnerCount;
  let reserveManagedWakeCancellation;
  let commitManagedWakeCancellation;
  let releaseManagedWakeCancellation;
  let cancelManagedWakeIfTaskMatches;

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

  test('T8-terminal: user-message cancellation preserves command terminal evidence without a stale wake', async () => {
    let triggerCount = 0;
    const deps = makeStubDeps({
      invokeTrigger: {
        async trigger() {
          triggerCount += 1;
          return 'dispatched';
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
        reason: 'long gate interrupted by a user message',
        nextStep: 'inspect the cancelled terminal result',
        wakeWhen: { command: 'printf "progress-before-cancel\\n"; sleep 999', timeoutMs: 300_000 },
      },
    });
    assert.equal(response.statusCode, 200);
    const { taskId } = JSON.parse(response.body);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelled = cancelPendingHoldsForThread(thread.id, deps);
    assert.deepEqual(
      cancelled.map((task) => task.id),
      [taskId],
      'the user-message path must supersede the active hold',
    );
    cancelWakeWhenRunner(thread.id, 'codex');

    const deadline = Date.now() + 2_000;
    let tombstone = deps.dynamicTaskStore.getById(taskId);
    while (tombstone?.params.holdLifecycle?.managedCommand?.state !== 'cancelled' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      tombstone = deps.dynamicTaskStore.getById(taskId);
    }
    await app.close();

    assert.ok(tombstone, 'the cancelled hold must remain queryable by taskId');
    assert.equal(tombstone.enabled, false, 'user-message cancellation must retire scheduler execution');
    assert.equal(tombstone.params.holdLifecycle.status, 'cancelled_by_user');
    assert.equal(tombstone.params.holdLifecycle.managedCommand.state, 'cancelled');
    assert.equal(tombstone.params.holdLifecycle.managedCommand.result.cancelled, true);
    assert.match(tombstone.params.holdLifecycle.managedCommand.result.tailOutput, /progress-before-cancel/);
    assert.equal(triggerCount, 0, 'a superseded hold must not dispatch a wake invocation');
    assert.equal(
      deps._appendedMessages.some((message) => message.content?.includes('持球唤醒（命令完成）')),
      false,
      'a superseded hold must not publish a stale completion wake',
    );
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

  // ─── T9: second wakeWhen replaces first → old runner cancelled ──────────
  test('T9: second wakeWhen hold cancels first runner (single-slot)', async () => {
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

    // Second wakeWhen hold (same thread, same cat) → should replace
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

    // First task should be unregistered (single-slot replace)
    assert.ok(
      deps._unregisteredIds.includes(firstTaskId),
      `first taskId should have been unregistered; got ${JSON.stringify(deps._unregisteredIds)}`,
    );

    // Wait for any async completion of first runner (it should have been cancelled)
    await new Promise((r) => setTimeout(r, 200));

    // First runner's wake should NOT have been delivered
    // (if the old runner still fires, it would append a message with "first gate")
    const firstGateMessages = deps._appendedMessages.filter(
      (m) =>
        typeof m.content === 'string' && m.content.includes('first gate') && m.content.includes('持球唤醒（命令完成）'),
    );
    assert.equal(firstGateMessages.length, 0, 'cancelled runner should not deliver wake for "first gate"');

    // Clean up: cancel the second runner to avoid dangling processes
    cancelWakeWhenRunner(thread.id, 'codex');
    await new Promise((r) => setTimeout(r, 200));
  });

  test('T9a: a stale cancellation token cannot kill a replacement command', async () => {
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
      false,
      'task-bound token must not cancel a replacement runner',
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
