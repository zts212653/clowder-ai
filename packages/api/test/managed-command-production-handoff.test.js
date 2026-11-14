import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ManagedCommandWakeRecoverySweep } from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { createManagedCommandWakeAdmission } from '../dist/domains/ball-custody/managed-command-wake-admission.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';

function fixture(t, failVisibility = false) {
  let now = 10_000;
  let visibilityBlocked = failVisibility;
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const tasks = new DynamicTaskStore(db);
  const task = {
    id: 'hold-ball-original',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 100_000 },
    params: {
      targetCatId: 'codex61-sol',
      triggerUserId: 'owner',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        await: { v: 1, generation: 1 },
        managedCommand: {
          state: 'condition_met',
          command: 'original',
          startedAt: 1,
          wakeContent: 'original result',
          productionIntentKey: 'job:epoch:target',
          result: { exitCode: 3, timedOut: false, durationMs: 9 },
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
  const messageStore = new MessageStore();
  const queue = new InvocationQueue();
  let admissions = 0;
  const send = queue.send.bind(queue);
  queue.send = async (...args) => {
    admissions++;
    return send(...args);
  };
  const admitWake = createManagedCommandWakeAdmission({
    queue,
    messageStore,
    notifyAdmitted: async () => {
      if (!failVisibility) throw new Error('post-commit notification failure');
    },
  });
  if (failVisibility) {
    const update = tasks.updateParamsIfCurrent.bind(tasks);
    tasks.updateParamsIfCurrent = (id, expected, next) => {
      if (visibilityBlocked && next.holdLifecycle.managedCommand.state === 'enqueued') return false;
      return update(id, expected, next);
    };
  }
  const deps = {
    dynamicTaskStore: tasks,
    messageStore,
    admitWake,
    socketManager: { broadcastToRoom() {} },
    taskRunner: { unregister() {} },
    invocationRecordStore: { getByIdempotencyKey: () => null },
    now: () => now,
    getEventCarrier: async () => ({ state: 'pending' }),
  };
  return {
    task,
    tasks,
    messageStore,
    queue,
    deps,
    admissions: () => admissions,
    advance: () => {
      now += 31_000;
      visibilityBlocked = false;
    },
  };
}

for (const fault of ['post-commit-notification', 'before-producer-ack']) {
  test(`${fault}: recovery reuses the committed source/target without another admission`, async (t) => {
    const h = fixture(t, fault === 'before-producer-ack');
    await new ManagedCommandWakeRecoverySweep(h.deps).recoverTask(h.task.id);
    assert.equal(h.queue.list('thread', 'owner').length, 1, 'real Queue admission already committed');
    h.advance();
    await new ManagedCommandWakeRecoverySweep(h.deps).recoverTask(h.task.id);
    assert.equal(h.admissions(), 1, 'a lost producer receipt never authorizes a second Queue send');
    const messages = await h.messageStore.getByThread('thread', 100, 'owner', { includeQueuedUserMessages: true });
    assert.equal(messages.length, 1);
    assert.equal((await h.messageStore.getByIdempotencyKey('owner', 'thread', 'job:epoch:target')).id, messages[0].id);
    assert.equal(h.tasks.getById(h.task.id).params.holdLifecycle.managedCommand.messageId, messages[0].id);
  });
}
