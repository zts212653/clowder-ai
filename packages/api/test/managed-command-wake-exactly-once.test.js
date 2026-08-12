import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function makeTask() {
  return {
    id: 'hold-ball-exactly-once',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 99_000 },
    params: {
      message: 'fallback wake',
      targetCatId: 'codex-sol',
      triggerUserId: 'user-1',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        wakeAt: 99_000,
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
  };
}

function makeHarness(triggerOutcomes = ['enqueued']) {
  let now = 10_000;
  const task = makeTask();
  const tasks = new Map([[task.id, task]]);
  const messages = new Map();
  const triggerCalls = [];
  const outcomes = [...triggerOutcomes];
  const deps = {
    dynamicTaskStore: {
      getAll: () => [...tasks.values()],
      getById: (id) => tasks.get(id) ?? null,
      updateParams(id, params) {
        const current = tasks.get(id);
        if (!current) return false;
        tasks.set(id, { ...current, params });
        return true;
      },
      updateParamsIfCurrent(id, expected, params) {
        const current = tasks.get(id);
        if (!current || current.params !== expected) return false;
        tasks.set(id, { ...current, params });
        return true;
      },
      setEnabled(id, enabled) {
        const current = tasks.get(id);
        if (!current) return false;
        tasks.set(id, { ...current, enabled });
        return true;
      },
    },
    messageStore: {
      getByIdempotencyKey(_userId, _threadId, key) {
        return messages.get(key) ?? null;
      },
      async append(input) {
        const existing = messages.get(input.idempotencyKey);
        if (existing) return existing;
        const stored = { ...input, id: `message-${messages.size + 1}` };
        messages.set(input.idempotencyKey, stored);
        return stored;
      },
    },
    socketManager: { broadcastToRoom() {} },
    taskRunner: { unregister() {} },
    invocationRecordStore: { getByIdempotencyKey: () => null },
    getInvokeTrigger: () => ({
      async trigger(...args) {
        triggerCalls.push(args);
        const outcome = outcomes.shift() ?? 'enqueued';
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    }),
    now: () => now,
    dispatchedCarrierGraceMs: 1_000,
  };
  return {
    deps,
    task,
    tasks,
    messages,
    triggerCalls,
    setNow(value) {
      now = value;
    },
  };
}

async function loadRuntime() {
  const [{ ManagedCommandWakeRecoverySweep }, { reminderTemplate }] = await Promise.all([
    import('../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js'),
    import('../dist/infrastructure/scheduler/templates/reminder.js'),
  ]);
  return { ManagedCommandWakeRecoverySweep, reminderTemplate };
}

describe('F167 managed-command terminal reinvocation exactly-once', () => {
  test('completion and fallback timer converge on one user-visible reinvocation', async () => {
    const { ManagedCommandWakeRecoverySweep, reminderTemplate } = await loadRuntime();
    const h = makeHarness();
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);
    const spec = reminderTemplate.createSpec(h.task.id, {
      trigger: h.task.trigger,
      params: h.task.params,
      deliveryThreadId: h.task.deliveryThreadId,
    });
    const fallbackTriggerCalls = [];

    await Promise.all([
      sweep.recordCompletion({
        taskId: h.task.id,
        wakeContent: 'command completed',
        result: { exitCode: 0, timedOut: false, durationMs: 9_000 },
      }),
      spec.run.execute('fallback wake', `thread-${h.task.deliveryThreadId}`, {
        assignedCatId: null,
        deliver: async () => 'fallback-message',
        invokeTrigger: {
          trigger(...args) {
            fallbackTriggerCalls.push(args);
            return 'enqueued';
          },
        },
        managedCommandWakeRecovery: (taskId) => sweep.recordFallbackDue(taskId),
      }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      h.triggerCalls.length + fallbackTriggerCalls.length,
      1,
      'completion and fallback must share one dispatch/terminal fence',
    );
    assert.equal(h.messages.size, 1, 'both paths must share one durable source-message identity');
  });

  test('late completion replaces fallback evidence before the shared wake becomes visible', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    const h = makeHarness();
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);
    const append = h.deps.messageStore.append;
    let failFirstAppend = true;
    h.deps.messageStore.append = async (...args) => {
      if (failFirstAppend) {
        failFirstAppend = false;
        throw new Error('message plane unavailable before completion');
      }
      return append(...args);
    };

    assert.equal(await sweep.recordFallbackDue(h.task.id), 'pending');
    assert.equal(h.messages.size, 0);

    await sweep.recordCompletion({
      taskId: h.task.id,
      wakeContent: 'real command completed',
      result: { exitCode: 0, timedOut: false, durationMs: 9_000, tailOutput: 'real output' },
    });

    const command = h.tasks.get(h.task.id).params.holdLifecycle.managedCommand;
    assert.equal(command.wakeSource, 'command_completion');
    assert.equal(command.wakeContent, 'real command completed');
    assert.deepEqual(command.result, {
      exitCode: 0,
      timedOut: false,
      durationMs: 9_000,
      tailOutput: 'real output',
    });
    assert.equal([...h.messages.values()][0].content, '[定时任务] real command completed');
    assert.equal(h.triggerCalls.length, 1);
  });

  test('an in-flight fallback append cannot diverge from the shared receipt and dispatch payload', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    const h = makeHarness();
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);
    const append = h.deps.messageStore.append;
    let firstAppend = true;
    let appendCalls = 0;
    let releaseFirstAppend;
    let markFirstAppendDone;
    const firstAppendDone = new Promise((resolve) => {
      markFirstAppendDone = resolve;
    });
    const firstAppendStarted = new Promise((resolve) => {
      h.deps.messageStore.append = async (...args) => {
        appendCalls += 1;
        if (firstAppend) {
          firstAppend = false;
          resolve();
          await new Promise((release) => {
            releaseFirstAppend = release;
          });
          try {
            return await append(...args);
          } finally {
            markFirstAppendDone();
          }
        }
        await firstAppendDone;
        return append(...args);
      };
    });

    const fallback = sweep.recordFallbackDue(h.task.id);
    await firstAppendStarted;
    const completion = sweep.recordCompletion({
      taskId: h.task.id,
      wakeContent: 'real command completed during fallback append',
      result: { exitCode: 0, timedOut: false, durationMs: 11_000, tailOutput: 'serialized output' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstAppend();
    await Promise.all([fallback, completion]);

    const command = h.tasks.get(h.task.id).params.holdLifecycle.managedCommand;
    const storedContent = [...h.messages.values()][0].content;
    const dispatchedContent = h.triggerCalls[0][3];
    assert.equal(storedContent, dispatchedContent, 'one receipt must select the same source and dispatch content');
    assert.deepEqual(command.result, {
      exitCode: 0,
      timedOut: false,
      durationMs: 11_000,
      tailOutput: 'serialized output',
    });
    assert.equal(h.messages.size, 1);
    assert.equal(h.triggerCalls.length, 1);
    assert.equal(appendCalls, 1, 'the durable content claim must fence the losing publisher before append');
  });

  test('recovery steals an expired message-content claim without duplicating visibility', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    const h = makeHarness();
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);
    const task = h.tasks.get(h.task.id);
    h.setNow(50_000);
    task.params = {
      ...task.params,
      holdLifecycle: {
        ...task.params.holdLifecycle,
        managedCommand: {
          ...task.params.holdLifecycle.managedCommand,
          state: 'condition_met',
          conditionMetAt: 10_000,
          wakeContent: 'fallback wake',
          wakeSource: 'fallback_timer',
          messageClaimGeneration: 1,
          messageClaimedAt: 10_000,
        },
      },
    };

    assert.equal(await sweep.recoverTask(h.task.id), 'pending');

    const command = h.tasks.get(h.task.id).params.holdLifecycle.managedCommand;
    assert.equal(command.messageClaimGeneration, 2);
    assert.equal(command.messageClaimedAt, undefined);
    assert.equal(h.messages.size, 1);
    assert.equal(h.triggerCalls.length, 1);
    assert.equal([...h.messages.values()][0].content, h.triggerCalls[0][3]);
  });

  test('an append that commits before throwing preserves its selected content and dispatches once', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    const h = makeHarness();
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);
    const append = h.deps.messageStore.append;
    h.deps.messageStore.append = async (...args) => {
      await append(...args);
      throw new Error('message commit acknowledgement lost');
    };

    assert.equal(await sweep.recordFallbackDue(h.task.id), 'pending');

    const command = h.tasks.get(h.task.id).params.holdLifecycle.managedCommand;
    assert.equal(command.state, 'enqueued');
    assert.equal(h.messages.size, 1);
    assert.equal(h.triggerCalls.length, 1);
    assert.equal([...h.messages.values()][0].content, h.triggerCalls[0][3]);
  });

  test('late completion enriches an already visible fallback without redispatching it', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    const h = makeHarness();
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.equal(await sweep.recordFallbackDue(h.task.id), 'pending');
    assert.equal(h.messages.size, 1);
    assert.equal(h.triggerCalls.length, 1);

    await sweep.recordCompletion({
      taskId: h.task.id,
      wakeContent: 'real command completed after fallback',
      result: { exitCode: 0, timedOut: false, durationMs: 12_000, tailOutput: 'late real output' },
    });

    const command = h.tasks.get(h.task.id).params.holdLifecycle.managedCommand;
    assert.equal(command.wakeSource, 'fallback_timer', 'published delivery provenance must stay truthful');
    assert.equal(command.wakeContent, 'fallback wake', 'published content cannot be rewritten after visibility');
    assert.deepEqual(command.result, {
      exitCode: 0,
      timedOut: false,
      durationMs: 12_000,
      tailOutput: 'late real output',
    });
    assert.equal(h.messages.size, 1);
    assert.equal(h.triggerCalls.length, 1);
  });

  test('late completion enriches a consumed fallback receipt without resurrecting it', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    const h = makeHarness();
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.equal(await sweep.recordFallbackDue(h.task.id), 'pending');
    h.deps.invocationRecordStore.getByIdempotencyKey = () => ({ id: 'invocation-1', status: 'succeeded' });
    assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 1, pending: 0 });

    const consumed = h.tasks.get(h.task.id);
    assert.equal(consumed.enabled, false);
    assert.equal(consumed.params.holdLifecycle.status, 'fired');
    assert.equal(consumed.params.holdLifecycle.managedCommand.state, 'consumed');

    assert.equal(
      await sweep.recordCompletion({
        taskId: h.task.id,
        wakeContent: 'real command completed after terminal invocation',
        result: { exitCode: 0, timedOut: false, durationMs: 14_000, tailOutput: 'terminal output' },
      }),
      'recovered',
    );

    const enriched = h.tasks.get(h.task.id);
    assert.equal(enriched.enabled, false, 'late evidence must not resurrect a disabled terminal receipt');
    assert.equal(enriched.params.holdLifecycle.status, 'fired');
    assert.equal(enriched.params.holdLifecycle.managedCommand.state, 'consumed');
    assert.deepEqual(enriched.params.holdLifecycle.managedCommand.result, {
      exitCode: 0,
      timedOut: false,
      durationMs: 14_000,
      tailOutput: 'terminal output',
    });
    assert.equal(h.messages.size, 1);
    assert.equal(h.triggerCalls.length, 1);
  });

  test('concurrent recovery sweeps do not redispatch while carrier persistence lags', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    const h = makeHarness(['dispatched']);
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    await sweep.recordCompletion({
      taskId: h.task.id,
      wakeContent: 'command completed',
      result: { exitCode: 0, timedOut: false, durationMs: 9_000 },
    });
    await Promise.all([sweep.runOnce(), sweep.runOnce()]);

    assert.equal(h.triggerCalls.length, 1, 'a recent accepted dispatch must wait for its durable carrier');
    assert.equal(new Set(h.triggerCalls.map((call) => call[4])).size, 1);
  });

  test('concurrent recovery after a failed first dispatch retries the same wake exactly once', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    for (const firstOutcome of [new Error('transient dispatch failure'), 'full']) {
      const h = makeHarness([firstOutcome, 'enqueued']);
      const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

      await sweep.recordCompletion({
        taskId: h.task.id,
        wakeContent: 'command completed',
        result: { exitCode: 0, timedOut: false, durationMs: 9_000 },
      });
      h.setNow(12_000);
      await Promise.all([sweep.runOnce(), sweep.runOnce()]);

      assert.equal(h.triggerCalls.length, 2, 'one failed attempt permits only one concurrent recovery dispatch');
      assert.equal(new Set(h.triggerCalls.map((call) => call[4])).size, 1, 'recovery must preserve source identity');
    }
  });
});
