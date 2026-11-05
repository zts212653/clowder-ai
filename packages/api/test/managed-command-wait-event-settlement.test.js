import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ManagedCommandWakeRecoverySweep } from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { createManagedCommandWakeCarrierAdapter } from '../dist/domains/ball-custody/managed-command-wake-carrier-adapter.js';
import {
  commitLifecycleResponseFromAppendInput,
  MessageStore,
} from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';

function fixture(t) {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const tasks = new DynamicTaskStore(db);
  const messages = new MessageStore();
  const source = messages.append({
    from: { kind: 'system', service: 'managed-command-wake' },
    userId: 'owner',
    threadId: 'thread',
    content: 'original result',
    mentions: [],
    timestamp: 1,
    deliveryStatus: 'queued',
    lifecycle: { kind: 'input', orderKey: 'source', dispatchRefs: [] },
  });
  assert.equal(messages.markDelivered(source.id, 2).deliveryTransitioned, true);
  const response = messages.append({
    from: { kind: 'agent', catId: 'codex61-sol' },
    userId: 'owner',
    threadId: 'thread',
    content: '',
    mentions: [],
    timestamp: 2,
    lifecycle: {
      kind: 'response',
      orderKey: 'response',
      from: { kind: 'agent', catId: 'codex61-sol' },
      targetId: 'codex61-sol',
      invocationId: 'exact-turn',
      status: 'processing',
      inputEntryIds: ['original-entry'],
      inputMessageIds: [source.id],
      startedAt: 2,
    },
  });
  assert.equal(
    messages.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle.orderKey,
      targetId: 'codex61-sol',
      phase: 'dispatched',
      statusMessageId: response.id,
      dispatchedAt: 2,
    }).kind,
    'applied',
  );
  const task = {
    id: 'hold-ball-event',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 99999 },
    params: {
      targetCatId: 'codex61-sol',
      triggerUserId: 'owner',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        await: { v: 1, generation: 1 },
        managedCommand: {
          state: 'enqueued',
          command: 'original',
          startedAt: 1,
          conditionMetAt: 2,
          messageId: source.id,
          result: { exitCode: 3, timedOut: false, durationMs: 1 },
        },
      },
    },
    display: { label: 'original', category: 'system', description: 'original' },
    deliveryThreadId: 'thread',
    enabled: true,
    createdBy: 'hold-ball:codex61-sol',
    createdAt: new Date(1).toISOString(),
  };
  tasks.insert(task, { ownerAuthProvenance: 'strict' });
  const adapter = createManagedCommandWakeCarrierAdapter({
    messageStore: messages,
    invocationRecordStore: { get: async () => null },
    invocationQueue: { getDurableEntriesForMessages: async () => new Map() },
  });
  const deps = {
    dynamicTaskStore: tasks,
    messageStore: messages,
    socketManager: { broadcastToRoom() {} },
    invocationRecordStore: { getByIdempotencyKey: () => null },
    taskRunner: { unregister() {} },
    now: () => 100,
    admitWake: async () => {
      throw new Error('settlement must never admit a new execution');
    },
    ...adapter,
  };
  const sweep = new ManagedCommandWakeRecoverySweep(deps);
  const observed = [];
  messages.onTimelineChanged = (message) => {
    const settlement = sweep.onMessageLifecycleChanged?.(message);
    observed.push(settlement);
    return settlement;
  };
  const complete = () =>
    commitLifecycleResponseFromAppendInput(
      messages,
      response.id,
      'exact-turn',
      { status: 'completed', completedAt: 100 },
      {
        from: { kind: 'agent', catId: 'codex61-sol' },
        userId: 'owner',
        threadId: 'thread',
        content: 'done',
        mentions: [],
        timestamp: 100,
      },
    );
  return { tasks, messages, source, response, task, sweep, deps, observed, complete };
}

for (const fault of ['terminal-event', 'terminal-during-observation', 'late-old-generation']) {
  test(`${fault}: exact History events settle without a periodic sweep or a new admission`, async (t) => {
    const h = fixture(t);
    let running;
    let release;
    if (fault === 'terminal-during-observation') {
      const read = h.deps.getEventCarrier;
      let entered;
      const reading = new Promise((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise((resolve) => {
        release = resolve;
      });
      let first = true;
      h.deps.getEventCarrier = async (input) => {
        const carrier = await read(input);
        if (first) {
          first = false;
          entered();
          await barrier;
        }
        return carrier;
      };
      running = h.sweep.recoverTask(h.task.id);
      await reading;
    }
    if (fault === 'late-old-generation') {
      const current = h.tasks.getById(h.task.id);
      assert.equal(
        h.tasks.updateParamsIfCurrent(current.id, current.params, {
          ...current.params,
          holdLifecycle: { ...current.params.holdLifecycle, await: { v: 1, generation: 2 } },
        }),
        true,
      );
    }
    await h.complete();
    release?.();
    await running;
    await Promise.all(h.observed);
    const current = h.tasks.getById(h.task.id);
    assert.equal(
      current.params.holdLifecycle.managedCommand.state,
      fault === 'late-old-generation' ? 'enqueued' : 'consumed',
    );
    assert.equal(current.enabled, fault === 'late-old-generation');
    if (fault === 'late-old-generation')
      assert.equal(h.tasks.getManagedCommandRecoveryState(h.task.id).fact.waitGeneration, 2);
    else assert.equal(h.tasks.getManagedCommandRecoveryState(h.task.id).fact.nextAttemptAt, null);
  });
}
