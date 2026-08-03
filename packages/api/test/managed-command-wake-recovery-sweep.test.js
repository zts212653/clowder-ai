/**
 * F167 S.1-c — managed-command completion recovery.
 *
 * The dynamic hold task is the durable completion receipt. A thread message is
 * visibility, an in-memory queue entry is only a delivery attempt, and the
 * InvocationRecord identity is durable, but only its execution lifecycle can
 * prove completion. queued/failed must replay, running must remain pending,
 * and only succeeded may retire the fallback.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function makeTask(overrides = {}) {
  return {
    id: 'hold-ball-task-1',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 99_000 },
    params: {
      message: 'fallback',
      targetCatId: 'codex-sol',
      triggerUserId: 'user-1',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        wakeAt: 99_000,
        createdBy: 'hold-ball:codex-sol',
        managedCommand: {
          state: 'command_running',
          command: 'pnpm gate',
          startedAt: 1_000,
        },
      },
    },
    display: { label: 'hold', category: 'system', description: 'hold' },
    deliveryThreadId: 'thread-1',
    enabled: true,
    createdBy: 'hold-ball:codex-sol',
    createdAt: new Date(1_000).toISOString(),
    ...overrides,
  };
}

function makeHarness(options = {}) {
  let now = 10_000;
  const tasks = new Map([[options.task?.id ?? 'hold-ball-task-1', options.task ?? makeTask()]]);
  const messages = new Map();
  const appended = [];
  const triggerOutcomes = [...(options.triggerOutcomes ?? ['enqueued'])];
  const triggerCalls = [];
  const invocationRecords = new Map();
  const unregistered = [];

  const deps = {
    dynamicTaskStore: {
      getAll: () => [...tasks.values()],
      getById: (id) => tasks.get(id) ?? null,
      updateParams(id, params) {
        const task = tasks.get(id);
        if (!task) return false;
        tasks.set(id, { ...task, params });
        return true;
      },
      setEnabled(id, enabled) {
        const task = tasks.get(id);
        if (!task) return false;
        tasks.set(id, { ...task, enabled });
        return true;
      },
    },
    messageStore: {
      getByIdempotencyKey(_userId, _threadId, key) {
        return messages.get(key) ?? null;
      },
      async append(input) {
        if (options.appendError) throw options.appendError;
        const existing = messages.get(input.idempotencyKey);
        if (existing) return existing;
        const stored = { ...input, id: `message-${messages.size + 1}`, threadId: input.threadId };
        messages.set(input.idempotencyKey, stored);
        appended.push(stored);
        return stored;
      },
    },
    socketManager: { broadcastToRoom() {} },
    taskRunner: { unregister: (id) => unregistered.push(id) },
    invocationRecordStore: {
      getByIdempotencyKey(_threadId, _userId, key) {
        return invocationRecords.get(key) ?? null;
      },
    },
    getInvokeTrigger: () => ({
      async trigger(...args) {
        triggerCalls.push(args);
        return triggerOutcomes.shift() ?? 'full';
      },
    }),
    now: () => now,
    dispatchedCarrierGraceMs: 1_000,
  };

  return {
    deps,
    tasks,
    appended,
    triggerCalls,
    invocationRecords,
    unregistered,
    setNow: (value) => {
      now = value;
    },
  };
}

async function loadSweep() {
  return import('../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js');
}

describe('F167 S.1-c ManagedCommandWakeRecoverySweep', () => {
  test('persists the terminal result before attempting thread delivery', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const h = makeHarness({ appendError: new Error('message plane unavailable') });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    const result = await sweep.recordCompletion({
      taskId: 'hold-ball-task-1',
      wakeContent: 'gate finished',
      result: { exitCode: 0, timedOut: false, durationMs: 9_000, tailOutput: 'ok' },
    });

    assert.equal(result, 'pending');
    const lifecycle = h.tasks.get('hold-ball-task-1').params.holdLifecycle;
    assert.equal(lifecycle.managedCommand.state, 'condition_met');
    assert.deepEqual(lifecycle.managedCommand.result, {
      exitCode: 0,
      timedOut: false,
      durationMs: 9_000,
      tailOutput: 'ok',
    });
    assert.equal(lifecycle.managedCommand.wakeContent, 'gate finished');
    assert.equal(h.appended.length, 0);
  });

  test('records a cancelled runner into its user-cancelled tombstone without publishing or dispatching a wake', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.enabled = false;
    task.params.holdLifecycle.status = 'cancelled_by_user';
    const h = makeHarness({ task });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    const result = await sweep.recordCancelledCompletion({
      taskId: task.id,
      wakeContent: 'must stay suppressed',
      result: {
        exitCode: null,
        timedOut: false,
        cancelled: true,
        durationMs: 9_000,
        tailOutput: 'progress-before-cancel',
      },
    });

    assert.equal(result, 'recovered');
    const lifecycle = h.tasks.get(task.id).params.holdLifecycle;
    assert.equal(lifecycle.status, 'cancelled_by_user');
    assert.equal(lifecycle.managedCommand.state, 'cancelled');
    assert.deepEqual(lifecycle.managedCommand.result, {
      exitCode: null,
      timedOut: false,
      cancelled: true,
      durationMs: 9_000,
      tailOutput: 'progress-before-cancel',
    });
    assert.equal(h.appended.length, 0);
    assert.equal(h.triggerCalls.length, 0);
    assert.deepEqual(await sweep.runOnce(), { scanned: 0, recovered: 0, pending: 0 });
  });

  test('restart after volatile enqueue re-dispatches the same wake until a durable carrier exists', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const h = makeHarness({ triggerOutcomes: ['full', 'enqueued', 'enqueued'] });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.equal(
      await sweep.recordCompletion({
        taskId: 'hold-ball-task-1',
        wakeContent: 'gate finished',
        result: { exitCode: 0, timedOut: false, durationMs: 9_000, tailOutput: 'ok' },
      }),
      'pending',
    );
    assert.equal(h.tasks.get('hold-ball-task-1').params.holdLifecycle.managedCommand.state, 'dispatch_pending');
    assert.equal(h.appended.length, 1);

    const volatileAttempt = await sweep.runOnce();
    assert.deepEqual(volatileAttempt, { scanned: 1, recovered: 0, pending: 1 });
    let task = h.tasks.get('hold-ball-task-1');
    assert.equal(task.enabled, true, 'an in-memory queue entry cannot retire the durable fallback');
    assert.equal(task.params.holdLifecycle.managedCommand.state, 'enqueued');

    h.setNow(12_000);
    const restartedAttempt = await sweep.runOnce();
    assert.deepEqual(restartedAttempt, { scanned: 1, recovered: 0, pending: 1 });
    task = h.tasks.get('hold-ball-task-1');
    assert.equal(task.enabled, true);
    assert.equal(h.appended.length, 1, 'completion visibility must be idempotent');
    assert.equal(h.triggerCalls[0][4], h.triggerCalls[1][4], 'retry must reuse the exact source message');
    assert.equal(h.triggerCalls[1][4], h.triggerCalls[2][4], 'restart recovery must preserve wake identity');

    const messageId = task.params.holdLifecycle.managedCommand.messageId;
    const invocation = {
      id: 'invocation-after-restart',
      userMessageId: messageId,
      status: 'queued',
    };
    h.invocationRecords.set(`connector-${messageId}`, invocation);
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 0, pending: 1 });
    assert.equal(h.tasks.get('hold-ball-task-1').enabled, true, 'bare queued metadata is not recoverable execution');

    invocation.status = 'failed';
    h.setNow(14_000);
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 0, pending: 1 });
    assert.equal(h.tasks.get('hold-ball-task-1').enabled, true, 'failed execution must retain fallback custody');

    invocation.status = 'succeeded';
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 1, pending: 0 });
    task = h.tasks.get('hold-ball-task-1');
    assert.equal(task.enabled, false);
    assert.equal(task.params.holdLifecycle.status, 'fired');
    assert.equal(task.params.holdLifecycle.managedCommand.state, 'consumed');
    assert.equal(task.params.holdLifecycle.managedCommand.invocationId, 'invocation-after-restart');
    assert.deepEqual(h.unregistered, ['hold-ball-task-1']);
  });

  test('does not retire a dispatched wake until its InvocationRecord completed successfully', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const h = makeHarness({ triggerOutcomes: ['dispatched'] });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.equal(
      await sweep.recordCompletion({
        taskId: 'hold-ball-task-1',
        wakeContent: 'gate finished',
        result: { exitCode: 0, timedOut: false, durationMs: 9_000 },
      }),
      'pending',
    );
    const first = h.tasks.get('hold-ball-task-1');
    assert.equal(first.enabled, true);
    assert.equal(first.params.holdLifecycle.managedCommand.state, 'dispatched');

    const messageId = first.params.holdLifecycle.managedCommand.messageId;
    const invocation = {
      id: 'invocation-1',
      userMessageId: messageId,
      status: 'running',
    };
    h.invocationRecords.set(`connector-${messageId}`, invocation);
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 0, pending: 1 });
    assert.equal(h.tasks.get('hold-ball-task-1').enabled, true);

    invocation.status = 'succeeded';
    const stats = await sweep.runOnce();
    assert.deepEqual(stats, { scanned: 1, recovered: 1, pending: 0 });
    assert.equal(h.triggerCalls.length, 1, 'carrier reconciliation must not dispatch a duplicate wake');
    assert.equal(h.tasks.get('hold-ball-task-1').params.holdLifecycle.managedCommand.invocationId, 'invocation-1');
  });

  test('boot recovery resumes a persisted condition without publishing a second completion message', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.params.holdLifecycle.managedCommand = {
      state: 'condition_met',
      command: 'pnpm gate',
      startedAt: 1_000,
      conditionMetAt: 8_000,
      wakeContent: 'gate finished',
      result: { exitCode: 0, timedOut: false, durationMs: 7_000 },
    };
    const h = makeHarness({ task, triggerOutcomes: ['enqueued'] });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    const first = await sweep.runOnce();
    assert.deepEqual(first, { scanned: 1, recovered: 0, pending: 1 });
    assert.equal(h.appended.length, 1);

    const messageId = h.tasks.get(task.id).params.holdLifecycle.managedCommand.messageId;
    const invocation = {
      id: 'invocation-boot-recovery',
      userMessageId: messageId,
      status: 'running',
    };
    h.invocationRecords.set(`connector-${messageId}`, invocation);
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 0, pending: 1 });

    invocation.status = 'succeeded';
    const second = await sweep.runOnce();
    assert.deepEqual(second, { scanned: 1, recovered: 1, pending: 0 });
    assert.equal(h.tasks.get(task.id).params.holdLifecycle.managedCommand.state, 'consumed');
  });

  test('a removed replacement/cancel task cannot be resurrected by stale completion', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const h = makeHarness();
    h.tasks.delete('hold-ball-task-1');
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.equal(
      await sweep.recordCompletion({
        taskId: 'hold-ball-task-1',
        wakeContent: 'stale completion',
        result: { exitCode: 0, timedOut: false, durationMs: 1 },
      }),
      'missing',
    );
    assert.equal(h.appended.length, 0);
    assert.equal(h.triggerCalls.length, 0);
  });

  test('persists a single SLA-breach observation for an overdue unconsumed completion', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.params.holdLifecycle.managedCommand = {
      state: 'dispatch_pending',
      command: 'pnpm gate',
      startedAt: 1_000,
      conditionMetAt: 2_000,
      wakeContent: 'gate finished',
      result: { exitCode: 0, timedOut: false, durationMs: 1_000 },
      messageId: 'message-existing',
      messageWrittenAt: 2_100,
    };
    const h = makeHarness({ task, triggerOutcomes: ['full', 'full'] });
    h.deps.wakeSlaMs = 1_000;
    h.setNow(10_000);
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    await sweep.runOnce();
    const firstObservedAt = h.tasks.get(task.id).params.holdLifecycle.managedCommand.slaBreachObservedAt;
    await sweep.runOnce();

    assert.equal(firstObservedAt, 10_000);
    assert.equal(h.tasks.get(task.id).params.holdLifecycle.managedCommand.slaBreachObservedAt, firstObservedAt);
  });
});
