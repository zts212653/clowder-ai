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

function makeHarness(triggerOutcomes = ['enqueued'], leaseStore) {
  let now = 10_000;
  const task = makeTask();
  const tasks = new Map([[task.id, task]]);
  const messages = new Map();
  const triggerCalls = [];
  const cancelCalls = [];
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
      getById(id) {
        return [...messages.values()].find((message) => message.id === id) ?? null;
      },
      markCanceled(id) {
        cancelCalls.push(id);
        const stored = [...messages.values()].find((message) => message.id === id);
        if (!stored) return null;
        if (stored.deliveryStatus !== 'queued') return { ...stored, deliveryTransitioned: false };
        stored.deliveryStatus = 'canceled';
        return { ...stored, deliveryTransitioned: true };
      },
    },
    socketManager: { broadcastToRoom() {} },
    taskRunner: { unregister() {} },
    invocationRecordStore: { getByIdempotencyKey: () => null },
    // F117 Phase I: one transaction commits the Message and its Queue row, so the harness observes
    // that admission rather than a separate trigger. An Error in `outcomes` models a refusal.
    async admitWake(input) {
      triggerCalls.push(input);
      const outcome = outcomes.shift() ?? 'enqueued';
      if (outcome instanceof Error) throw outcome;
      if (outcome !== 'enqueued' && outcome !== 'dispatched') return {};
      const existing = messages.get(input.message.idempotencyKey);
      if (existing) return { messageId: existing.id };
      const stored = { ...input.message, id: `message-${messages.size + 1}` };
      messages.set(input.message.idempotencyKey, stored);
      return { messageId: stored.id };
    },
    // The lease is verified against the envelope before anything is written. A harness that wants a
    // stale generation supplies a store whose lease no longer matches.
    ...(leaseStore ? { actionSuccessorLeaseStore: leaseStore } : {}),
    now: () => now,
    dispatchedCarrierGraceMs: 1_000,
  };
  return {
    deps,
    task,
    tasks,
    messages,
    triggerCalls,
    cancelCalls,
    setNow(value) {
      now = value;
    },
  };
}

async function loadRuntime() {
  const [{ ManagedCommandWakeRecoverySweep }, { ManagedCommandWakeActionLeaseAdmissionError }, { reminderTemplate }] =
    await Promise.all([
      import('../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js'),
      import('../dist/domains/ball-custody/managed-command-wake-action-lease-admission.js'),
      import('../dist/infrastructure/scheduler/templates/reminder.js'),
    ]);
  return { ManagedCommandWakeRecoverySweep, ManagedCommandWakeActionLeaseAdmissionError, reminderTemplate };
}

describe('F167 managed-command terminal reinvocation exactly-once', () => {
  test('a permanently stale managed-review generation is refused before any write, and retires', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    // The canonical lease has moved on: generation 3 is live, the wake still carries 2.
    const h = makeHarness(['enqueued'], {
      get: async () => ({
        leaseId: 'lease-review-stale',
        generation: 3,
        status: 'active',
        tenantScope: 'user-1',
        holderThreadId: 'thread-1',
        holderCatIds: ['codex-sol'],
        dispatchId: 'dispatch-1',
      }),
    });
    h.task.params.holdLifecycle.await = {
      v: 1,
      generation: 1,
      subjectRef: `command:${h.task.id}`,
      ownerFence: {
        kind: 'action_successor',
        leaseId: 'lease-review-stale',
        generation: 2,
      },
    };
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    assert.equal(
      await sweep.recordCompletion({
        taskId: h.task.id,
        wakeContent: 'stale review wake',
        result: { exitCode: 0, timedOut: false, durationMs: 9_000 },
      }),
      'recovered',
    );
    h.setNow(12_000);
    assert.deepEqual(await sweep.runOnce(), { scanned: 0, recovered: 0, pending: 0 });
    h.setNow(14_000);
    assert.deepEqual(await sweep.runOnce(), { scanned: 0, recovered: 0, pending: 0 });

    // This case used to assert that a message was appended and then cancelled exactly once. The
    // lease is now checked before the write, so the stronger statement holds: there was never a
    // message to cancel, and `markCanceled` — which existed only to undo one — is never called.
    assert.equal(h.triggerCalls.length, 0, 'a refused generation must not reach admission at all');
    assert.equal(h.messages.size, 0, 'and nothing may be persisted for it');
    assert.equal(h.cancelCalls.length, 0, 'so there is nothing to retract');
    const command = h.tasks.get(h.task.id).params.holdLifecycle.managedCommand;
    assert.equal(command.state, 'consumed', 'the stale wake is retired rather than retried forever');
    assert.equal(command.carrierTerminalReason, 'canceled');
  });

  test('managed review wake persists the exact action-successor generation for terminal settlement', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    // The lease is now verified before the write, so the canonical store has to agree with the
    // generation the envelope claims — otherwise the wake is correctly refused.
    const h = makeHarness(['enqueued'], {
      get: async () => ({
        leaseId: 'lease-review-1',
        generation: 3,
        status: 'active',
        tenantScope: 'user-1',
        holderThreadId: 'thread-1',
        holderCatIds: ['codex-sol'],
        dispatchId: 'dispatch-review-1',
        terminalPredicate: { kind: 'task_done' },
      }),
    });
    h.task.params.holdLifecycle.await = {
      v: 1,
      generation: 1,
      subjectRef: `command:${h.task.id}`,
      ownerFence: {
        kind: 'action_successor',
        leaseId: 'lease-review-1',
        generation: 3,
      },
    };
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);

    await sweep.recordCompletion({
      taskId: h.task.id,
      wakeContent: 'review command completed',
      result: { exitCode: 0, timedOut: false, durationMs: 9_000 },
    });

    const stored = [...h.messages.values()][0];
    assert.deepEqual(stored.source.meta.actionLeaseRef, {
      leaseId: 'lease-review-1',
      generation: 3,
    });
  });

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
    const admit = h.deps.admitWake;
    let failFirstAdmit = true;
    h.deps.admitWake = async (...args) => {
      if (failFirstAdmit) {
        failFirstAdmit = false;
        throw new Error('message plane unavailable before completion');
      }
      return admit(...args);
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

  test('an in-flight admission cannot diverge from the shared receipt and dispatch payload', async () => {
    const { ManagedCommandWakeRecoverySweep } = await loadRuntime();
    const h = makeHarness();
    const sweep = new ManagedCommandWakeRecoverySweep(h.deps);
    // The write is the admission now, not a bare append, so that is what this gates. The property
    // is unchanged: one durable content claim fences the losing publisher before anything is written.
    const admit = h.deps.admitWake;
    let firstAdmit = true;
    let admitCalls = 0;
    let releaseFirstAdmit;
    let markFirstAdmitDone;
    const firstAdmitDone = new Promise((resolve) => {
      markFirstAdmitDone = resolve;
    });
    const firstAdmitStarted = new Promise((resolve) => {
      h.deps.admitWake = async (...args) => {
        admitCalls += 1;
        if (firstAdmit) {
          firstAdmit = false;
          resolve();
          await new Promise((release) => {
            releaseFirstAdmit = release;
          });
          try {
            return await admit(...args);
          } finally {
            markFirstAdmitDone();
          }
        }
        await firstAdmitDone;
        return admit(...args);
      };
    });

    const fallback = sweep.recordFallbackDue(h.task.id);
    await firstAdmitStarted;
    const completion = sweep.recordCompletion({
      taskId: h.task.id,
      wakeContent: 'real command completed during fallback append',
      result: { exitCode: 0, timedOut: false, durationMs: 11_000, tailOutput: 'serialized output' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstAdmit();
    await Promise.all([fallback, completion]);

    const command = h.tasks.get(h.task.id).params.holdLifecycle.managedCommand;
    const storedContent = [...h.messages.values()][0].content;
    // Source and dispatch content are now the same envelope by construction — there is no second
    // payload to drift from the one that was persisted.
    assert.equal(storedContent, h.triggerCalls[0].content, 'one envelope is both the receipt and the dispatch');
    assert.deepEqual(command.result, {
      exitCode: 0,
      timedOut: false,
      durationMs: 11_000,
      tailOutput: 'serialized output',
    });
    assert.equal(h.messages.size, 1);
    assert.equal(h.triggerCalls.length, 1);
    assert.equal(admitCalls, 1, 'the durable content claim must fence the losing publisher before admission');
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
    assert.equal([...h.messages.values()][0].content, h.triggerCalls[0].content);
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
    assert.equal([...h.messages.values()][0].content, h.triggerCalls[0].content);
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
