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
  const messagesById = new Map((options.messages ?? []).map((message) => [message.id, message]));
  const appended = [];
  const triggerOutcomes = [...(options.triggerOutcomes ?? ['enqueued'])];
  const triggerCalls = [];
  const retryEventCarrierCalls = [];
  const retryEventCarrierOutcomes = [...(options.retryEventCarrierOutcomes ?? ['retried'])];
  const invocationRecords = new Map();
  const unregistered = [];
  let eventCarrier = options.eventCarrier;
  let appendError = options.appendError;

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
      updateParamsIfCurrent(id, expected, params) {
        const task = tasks.get(id);
        if (!task || task.params !== expected) return false;
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
      getById(messageId) {
        return messagesById.get(messageId) ?? null;
      },
      getByIdempotencyKey(_userId, _threadId, key) {
        return messages.get(key) ?? null;
      },
      async append(input) {
        if (appendError) throw appendError;
        const existing = messages.get(input.idempotencyKey);
        if (existing) return existing;
        const stored = { ...input, id: `message-${messages.size + 1}`, threadId: input.threadId };
        messages.set(input.idempotencyKey, stored);
        messagesById.set(stored.id, stored);
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
    ...(options.eventCarrier ? { getEventCarrier: () => eventCarrier } : {}),
    ...(options.retryEventCarrierOutcomes
      ? {
          retryEventCarrier: async (input) => {
            retryEventCarrierCalls.push(input);
            return retryEventCarrierOutcomes.shift() ?? 'unavailable';
          },
        }
      : {}),
    now: () => now,
    dispatchedCarrierGraceMs: 1_000,
  };

  return {
    deps,
    tasks,
    appended,
    triggerCalls,
    retryEventCarrierCalls,
    invocationRecords,
    unregistered,
    setNow: (value) => {
      now = value;
    },
    setEventCarrier: (value) => {
      eventCarrier = value;
    },
    setAppendError: (value) => {
      appendError = value;
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

  test('publishes a naturally completed retired command exactly once without dispatching an invocation', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.enabled = false;
    task.params.holdLifecycle.status = 'cancelled_by_user';
    const h = makeHarness({ task });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);
    const completion = {
      taskId: task.id,
      wakeContent: 'gate finished\nexitCode=0\nok',
      result: { exitCode: 0, timedOut: false, cancelled: false, durationMs: 9_000, tailOutput: 'ok' },
    };

    assert.equal(await sweep.recordRetiredCompletion(completion), 'recovered');
    assert.equal(await sweep.recordRetiredCompletion(completion), 'recovered');

    const lifecycle = h.tasks.get(task.id).params.holdLifecycle;
    assert.equal(lifecycle.status, 'cancelled_by_user', 'publishing a receipt must not resurrect obsolete custody');
    assert.equal(lifecycle.managedCommand.state, 'consumed');
    assert.equal(h.appended.length, 1);
    assert.equal(h.appended[0].deliveryStatus, undefined, 'the terminal receipt is immediately timeline-visible');
    assert.equal(h.appended[0].idempotencyKey, `hold-ball-completion:${task.id}`);
    assert.equal(h.appended[0].source.meta.taskId, task.id);
    assert.match(h.appended[0].content, /exitCode=0/);
    assert.equal(h.triggerCalls.length, 0, 'retired carrier completion must not wake the cat again');
  });

  test('publishes a nonzero retired result but keeps an explicitly cancelled command silent', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const failedTask = makeTask({ id: 'hold-ball-failed' });
    failedTask.enabled = false;
    failedTask.params.holdLifecycle.status = 'cancelled_by_user';
    const failedHarness = makeHarness({ task: failedTask });
    const failedSweep = new ManagedCommandWakeRecoverySweep(failedHarness.deps);

    assert.equal(
      await failedSweep.recordRetiredCompletion({
        taskId: failedTask.id,
        wakeContent: 'gate failed\nexitCode=2\nfailed',
        result: { exitCode: 2, timedOut: false, cancelled: false, durationMs: 7_000, tailOutput: 'failed' },
      }),
      'recovered',
    );
    assert.equal(failedHarness.appended.length, 1);
    assert.match(failedHarness.appended[0].content, /exitCode=2/);
    assert.equal(failedHarness.triggerCalls.length, 0);

    const cancelledTask = makeTask({ id: 'hold-ball-cancelled' });
    cancelledTask.enabled = false;
    cancelledTask.params.holdLifecycle.status = 'cancelled_by_user';
    const cancelledHarness = makeHarness({ task: cancelledTask });
    const cancelledSweep = new ManagedCommandWakeRecoverySweep(cancelledHarness.deps);

    assert.equal(
      await cancelledSweep.recordRetiredCompletion({
        taskId: cancelledTask.id,
        wakeContent: 'must stay suppressed',
        result: { exitCode: null, timedOut: false, cancelled: true, durationMs: 1_000 },
      }),
      'recovered',
    );
    assert.equal(cancelledHarness.appended.length, 0);
    assert.equal(cancelledHarness.triggerCalls.length, 0);
    assert.equal(cancelledHarness.tasks.get(cancelledTask.id).params.holdLifecycle.managedCommand.state, 'cancelled');
  });

  test('recovers a retired terminal receipt after the message plane becomes available', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.enabled = false;
    task.params.holdLifecycle.status = 'cancelled_by_user';
    const h = makeHarness({ task, appendError: new Error('message plane unavailable') });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.equal(
      await sweep.recordRetiredCompletion({
        taskId: task.id,
        wakeContent: 'gate finished after carrier retirement',
        result: { exitCode: 0, timedOut: false, cancelled: false, durationMs: 9_000 },
      }),
      'pending',
    );
    assert.equal(h.tasks.get(task.id).params.holdLifecycle.managedCommand.state, 'condition_met');
    assert.equal(h.appended.length, 0);

    h.setAppendError(undefined);
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 1, pending: 0 });
    assert.equal(h.tasks.get(task.id).params.holdLifecycle.managedCommand.state, 'consumed');
    assert.equal(h.appended.length, 1);
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
    assert.equal(h.appended[0].deliveryStatus, 'queued', 'managed wake stays under F264 receipt custody');
    assert.equal(
      h.triggerCalls[0][6].forceQueue,
      true,
      'managed event always uses one Queue carrier even when the thread is idle',
    );

    const graceAttempt = await sweep.runOnce();
    assert.deepEqual(graceAttempt, { scanned: 1, recovered: 0, pending: 1 });
    let task = h.tasks.get('hold-ball-task-1');
    assert.equal(task.enabled, true, 'an in-memory queue entry cannot retire the durable fallback');
    assert.equal(task.params.holdLifecycle.managedCommand.state, 'dispatch_pending');
    assert.equal(h.triggerCalls.length, 1, 'a recent attempt must wait for its durable carrier');

    h.setNow(12_000);
    const volatileAttempt = await sweep.runOnce();
    assert.deepEqual(volatileAttempt, { scanned: 1, recovered: 0, pending: 1 });
    assert.equal(h.tasks.get('hold-ball-task-1').params.holdLifecycle.managedCommand.state, 'enqueued');

    h.setNow(14_000);
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
    h.setNow(16_000);
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

  test('force-queued event carrier is not duplicated and retires only from exact F264 handled truth', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const h = makeHarness({ triggerOutcomes: ['enqueued', 'enqueued'], eventCarrier: { state: 'missing' } });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.equal(
      await sweep.recordCompletion({
        taskId: 'hold-ball-task-1',
        wakeContent: 'gate finished',
        result: { exitCode: 0, timedOut: false, durationMs: 9_000 },
      }),
      'pending',
    );
    h.setEventCarrier({ state: 'pending' });
    h.setNow(12_000);
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 0, pending: 1 });
    assert.equal(h.triggerCalls.length, 1, 'seen/pending Queue truth keeps the single event carrier');

    h.setEventCarrier({ state: 'handled', invocationId: 'child-exact-1' });
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 1, pending: 0 });
    assert.equal(h.triggerCalls.length, 1);
    assert.equal(h.tasks.get('hold-ball-task-1').params.holdLifecycle.managedCommand.invocationId, 'child-exact-1');
  });

  test('retries one exact missing-disposition attempt once, then escalates on its failed successor', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.params.holdLifecycle.managedCommand = {
      state: 'enqueued',
      command: 'pnpm gate',
      startedAt: 1_000,
      conditionMetAt: 8_000,
      wakeContent: 'gate finished',
      result: { exitCode: 0, timedOut: false, durationMs: 7_000 },
      messageId: 'message-managed',
      messageWrittenAt: 8_100,
      dispatchAttemptCount: 1,
      lastDispatchAt: 8_200,
      lastDispatchOutcome: 'enqueued',
    };
    const h = makeHarness({
      task,
      eventCarrier: {
        state: 'failed',
        attemptId: 'entry-managed:codex-sol:1',
        attemptSequence: 1,
        invocationId: 'invocation-missing-1',
        errorCode: 'managed_hold_disposition_missing',
      },
      retryEventCarrierOutcomes: ['retried'],
    });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 0, pending: 1 });
    assert.deepEqual(h.retryEventCarrierCalls, [
      {
        taskId: task.id,
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'codex-sol',
        messageId: 'message-managed',
        attemptId: 'entry-managed:codex-sol:1',
      },
    ]);
    let managed = h.tasks.get(task.id).params.holdLifecycle.managedCommand;
    assert.equal(managed.dispositionRetryCount, 1);
    assert.equal(managed.lastDispositionFailedAttemptId, 'entry-managed:codex-sol:1');

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 0, pending: 1 });
    assert.equal(h.retryEventCarrierCalls.length, 1, 'the same failed attempt must not hot-loop');

    h.setEventCarrier({
      state: 'failed',
      attemptId: 'entry-managed:codex-sol:2',
      attemptSequence: 2,
      invocationId: 'invocation-missing-2',
      errorCode: 'managed_hold_disposition_missing',
    });
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 1, pending: 0 });
    const escalated = h.tasks.get(task.id);
    managed = escalated.params.holdLifecycle.managedCommand;
    assert.equal(escalated.enabled, false);
    assert.equal(escalated.params.holdLifecycle.status, 'escalated');
    assert.equal(managed.state, 'escalated');
    assert.equal(managed.dispositionEscalationReason, 'managed_hold_disposition_missing');
    assert.equal(managed.dispositionEscalatedAttemptId, 'entry-managed:codex-sol:2');
    assert.equal(managed.dispositionEscalatedAt, 10_000);
    assert.deepEqual(h.unregistered, [task.id]);
    assert.equal(h.retryEventCarrierCalls.length, 1, 'exhaustion escalates instead of adding another attempt');
  });

  test('uses durable Queue attempt sequence when restart loses the task-side retry audit', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.params.holdLifecycle.managedCommand = {
      state: 'enqueued',
      command: 'pnpm gate',
      startedAt: 1_000,
      conditionMetAt: 8_000,
      wakeContent: 'gate finished',
      messageId: 'message-managed',
    };
    const h = makeHarness({
      task,
      eventCarrier: {
        state: 'failed',
        attemptId: 'entry-managed:codex-sol:2',
        attemptSequence: 2,
        invocationId: 'invocation-missing-2',
        errorCode: 'managed_hold_disposition_missing',
      },
      retryEventCarrierOutcomes: ['retried'],
    });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 1, pending: 0 });
    assert.equal(h.retryEventCarrierCalls.length, 0, 'a durable successor attempt consumes the bounded retry');
    assert.equal(h.tasks.get(task.id).params.holdLifecycle.status, 'escalated');
  });

  test('does not retry a failed managed carrier without the missing-disposition error code', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.params.holdLifecycle.managedCommand = {
      state: 'enqueued',
      command: 'pnpm gate',
      startedAt: 1_000,
      conditionMetAt: 8_000,
      wakeContent: 'gate finished',
      messageId: 'message-provider-failed',
    };
    const h = makeHarness({
      task,
      eventCarrier: {
        state: 'failed',
        attemptId: 'entry-provider:codex-sol:1',
        attemptSequence: 1,
        invocationId: 'invocation-provider-failed',
        errorCode: 'provider_failure',
      },
      retryEventCarrierOutcomes: ['retried'],
    });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 0, pending: 1 });
    assert.equal(h.retryEventCarrierCalls.length, 0);
    assert.equal(h.tasks.get(task.id).enabled, true);
  });

  test('terminal F264 carrier retires the managed producer and cannot revive after restart', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.params.holdLifecycle.managedCommand = {
      state: 'enqueued',
      command: 'pnpm gate',
      startedAt: 1_000,
      conditionMetAt: 8_000,
      wakeContent: 'gate finished',
      result: { exitCode: 0, timedOut: false, durationMs: 7_000 },
      messageId: 'message-withdrawn',
      messageWrittenAt: 8_100,
      dispatchAttemptCount: 1,
      lastDispatchAt: 8_200,
      lastDispatchOutcome: 'enqueued',
    };
    const h = makeHarness({
      task,
      triggerOutcomes: ['enqueued'],
      eventCarrier: { state: 'terminal', reason: 'withdrawn' },
    });
    h.setNow(10_000);

    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 1, pending: 0 });

    const retired = h.tasks.get(task.id);
    assert.equal(retired.enabled, false);
    assert.equal(retired.params.holdLifecycle.status, 'fired');
    assert.equal(retired.params.holdLifecycle.managedCommand.state, 'consumed');
    assert.equal(retired.params.holdLifecycle.managedCommand.carrierTerminalReason, 'withdrawn');
    assert.equal(h.triggerCalls.length, 0, 'terminal custody must fence every successor dispatch');

    const restartedSweep = new ManagedCommandWakeRecoverySweep(h.deps);
    assert.deepEqual(await restartedSweep.runOnce(), { scanned: 0, recovered: 0, pending: 0 });
    assert.equal(h.triggerCalls.length, 0, 'restart must not revive the retired producer');
  });

  test('projects canceled, withdrawn, and terminal F264 receipts without crossing source thread', async () => {
    const { resolveManagedCommandWakeEventCarrier } = await loadSweep();
    const expected = { threadId: 'thread-1', catId: 'codex-sol' };
    const custody = {
      status: 'queued',
      handledByCatIds: [],
      pendingTargetCats: ['codex-sol'],
    };

    assert.deepEqual(
      resolveManagedCommandWakeEventCarrier(
        { threadId: 'thread-1', userId: 'scheduler', deliveryStatus: 'canceled' },
        expected,
      ),
      { state: 'terminal', reason: 'canceled' },
    );
    assert.deepEqual(
      resolveManagedCommandWakeEventCarrier(
        {
          threadId: 'thread-1',
          userId: 'scheduler',
          deliveryStatus: 'queued',
          queueCustody: { ...custody, withdrawnByCatIds: ['codex-sol'] },
        },
        expected,
      ),
      { state: 'terminal', reason: 'withdrawn' },
    );
    assert.deepEqual(
      resolveManagedCommandWakeEventCarrier(
        {
          threadId: 'thread-1',
          userId: 'scheduler',
          deliveryStatus: 'queued',
          queueCustody: { ...custody, status: 'terminal', pendingTargetCats: [] },
        },
        expected,
      ),
      { state: 'terminal', reason: 'terminal' },
    );
    assert.deepEqual(
      resolveManagedCommandWakeEventCarrier(
        {
          threadId: 'thread-foreign',
          userId: 'scheduler',
          deliveryStatus: 'queued',
          queueCustody: { ...custody, status: 'terminal', pendingTargetCats: [] },
        },
        expected,
      ),
      { state: 'missing' },
    );
    assert.deepEqual(
      resolveManagedCommandWakeEventCarrier(
        {
          threadId: 'thread-1',
          userId: 'scheduler',
          deliveryStatus: 'queued',
          queueCustody: { ...custody, entryId: 'entry-old' },
        },
        { ...expected, activeQueueEntryId: null },
      ),
      { state: 'orphaned' },
    );
    assert.deepEqual(
      resolveManagedCommandWakeEventCarrier(
        {
          threadId: 'thread-1',
          userId: 'scheduler',
          deliveryStatus: 'queued',
          queueCustody: {
            ...custody,
            entryId: 'entry-failed',
            failedByCatIds: ['codex-sol'],
            targetAttempts: [
              {
                id: 'entry-failed:codex-sol:1',
                targetCatId: 'codex-sol',
                sequence: 1,
                state: 'failed',
                createdAt: 1_000,
                updatedAt: 2_000,
                invocationId: 'invocation-missing-disposition',
                terminalReason: 'invocation_failed',
              },
            ],
          },
        },
        { ...expected, activeQueueEntryId: 'entry-failed' },
      ),
      {
        state: 'failed',
        attemptId: 'entry-failed:codex-sol:1',
        attemptSequence: 1,
        invocationId: 'invocation-missing-disposition',
      },
    );
  });

  test('carrier retirement is fenced to the exact current source message', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const task = makeTask();
    task.params.holdLifecycle.managedCommand = {
      state: 'enqueued',
      command: 'pnpm gate',
      startedAt: 1_000,
      conditionMetAt: 8_000,
      wakeContent: 'new result',
      messageId: 'message-current',
      messageWrittenAt: 8_100,
      dispatchAttemptCount: 1,
      lastDispatchAt: 8_200,
      lastDispatchOutcome: 'enqueued',
    };
    const staleMessage = {
      id: 'message-stale',
      threadId: 'thread-1',
      userId: 'user-1',
      source: { connector: 'hold-ball', meta: { wakeWhen: true, taskId: task.id } },
    };
    const h = makeHarness({ task, messages: [staleMessage] });
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.equal(await sweep.retireCarrier([staleMessage.id], 'withdrawn'), 0);
    assert.equal(h.tasks.get(task.id).enabled, true);
    assert.equal(h.tasks.get(task.id).params.holdLifecycle.status, 'active');
    assert.equal(h.tasks.get(task.id).params.holdLifecycle.managedCommand.messageId, 'message-current');
  });

  test('thread retirement is owner-scoped and returns only exact managed carrier ids', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadSweep();
    const owned = makeTask();
    owned.params.holdLifecycle.managedCommand = {
      state: 'enqueued',
      command: 'pnpm gate',
      startedAt: 1_000,
      messageId: 'message-owned',
    };
    const h = makeHarness({ task: owned });
    const foreign = makeTask({ id: 'hold-ball-task-foreign' });
    foreign.params.triggerUserId = 'user-foreign';
    foreign.params.holdLifecycle.managedCommand = {
      state: 'enqueued',
      command: 'pnpm gate',
      startedAt: 1_000,
      messageId: 'message-foreign',
    };
    h.tasks.set(foreign.id, foreign);
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.deepEqual(await sweep.retireThread('thread-1', 'user-1', 'force_reset'), {
      retired: 1,
      messageIds: ['message-owned'],
    });
    assert.equal(h.tasks.get(owned.id).enabled, false);
    assert.equal(h.tasks.get(foreign.id).enabled, true);
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
