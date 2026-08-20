import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ManagedCommandWakeRecoverySweep,
  resolveManagedCommandWakeEventCarrier,
} from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ConnectorInvokeTrigger } from '../dist/infrastructure/email/ConnectorInvokeTrigger.js';

const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };

test('managed forceQueue starts the exact connector carrier through the real QueueProcessor', async () => {
  const queue = new InvocationQueue();
  const providerStarts = [];
  let releaseManaged;
  const managedRunning = new Promise((resolve) => {
    releaseManaged = resolve;
  });
  const invocationTracker = {
    start: () => new AbortController(),
    startAll: () => new AbortController(),
    complete: noop,
    completeAll: noop,
    has: () => false,
  };
  const invocationRecordStore = {
    async create() {
      return { outcome: 'created', invocationId: 'inv-managed-force-queue' };
    },
    async get() {
      return null;
    },
    async update() {
      return {};
    },
  };
  const router = {
    async *routeExecution(...args) {
      providerStarts.push(args);
      if (args[1] === '[managed wake] command complete') await managedRunning;
      yield { type: 'done', catId: 'codex-sol', timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
  const socketManager = {
    broadcastAgentMessage: noop,
    broadcastToRoom: noop,
    emitToUser: noop,
  };
  const messageStore = {
    async getById() {
      return null;
    },
    async getByIdempotencyKey() {
      return null;
    },
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker,
    invocationRecordStore,
    router,
    socketManager,
    messageStore,
    log,
  });
  const trigger = new ConnectorInvokeTrigger({
    router,
    socketManager,
    invocationRecordStore,
    invocationTracker,
    invocationQueue: queue,
    queueProcessor: processor,
    log,
  });

  const unrelated = queue.enqueue({
    threadId: 'thread-managed-force-queue',
    userId: 'user-original',
    ownerAuthProvenance: 'strict',
    content: 'unrelated automatic work',
    source: 'agent',
    targetCats: ['opus'],
    intent: 'execute',
    autoExecute: true,
  });

  const args = [
    'thread-managed-force-queue',
    'codex-sol',
    'user-original',
    '[managed wake] command complete',
    'message-managed-force-queue',
    undefined,
    { sourceCategory: 'scheduled', forceQueue: true },
  ];
  const outcomes = await Promise.all([trigger.trigger(...args), trigger.trigger(...args)]);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(outcomes, ['enqueued', 'enqueued']);
  assert.equal(
    providerStarts.length,
    1,
    `forceQueue must start once; starts=${JSON.stringify(providerStarts.map((args) => args.slice(0, 5)))}`,
  );
  const remaining = queue.list('thread-managed-force-queue', 'user-original');
  assert.equal(
    remaining.filter((entry) => entry.messageId === 'message-managed-force-queue').length,
    1,
    'concurrent replay must reuse one exact managed carrier',
  );
  assert.equal(
    remaining.find((entry) => entry.id === unrelated.entry.id)?.status,
    'queued',
    'the forceQueue bypass must not start unrelated automatic work while the managed carrier is running',
  );

  releaseManaged();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(providerStarts.length, 2, 'normal queue progression may start unrelated work after managed completion');
});

test('withdrawn managed carrier retires on sweep while a later Continue still starts the provider', async () => {
  const threadId = 'thread-terminal-managed-wake';
  const userId = 'user-original';
  const catId = 'codex-sol';
  const queue = new InvocationQueue();
  const messageStore = new MessageStore();
  const oldAdmission = queue.enqueue({
    threadId,
    userId,
    ownerAuthProvenance: 'strict',
    content: '[managed wake] old command complete',
    source: 'connector',
    sourceCategory: 'scheduled',
    targetCats: [catId],
    intent: 'execute',
    autoExecute: true,
  });
  assert.equal(oldAdmission.outcome, 'enqueued');
  const oldMessage = messageStore.append({
    threadId,
    userId: 'scheduler',
    catId: null,
    content: oldAdmission.entry.content,
    mentions: [catId],
    timestamp: oldAdmission.entry.createdAt,
    deliveryStatus: 'queued',
    source: {
      connector: 'hold-ball',
      label: 'managed wake',
      icon: '⏱️',
      meta: { wakeWhen: true, taskId: 'managed-task-terminal' },
    },
  });
  queue.backfillMessageId(threadId, userId, oldAdmission.entry.id, oldMessage.id);
  const oldCarrier = queue.getEntrySnapshot(threadId, userId, oldAdmission.entry.id);
  assert.ok(oldCarrier);
  assert.equal(
    messageStore.initializeQueueCustody(oldMessage.id, createInitialQueuedMessageCustody(oldCarrier)).kind,
    'initialized',
  );
  assert.ok(queue.remove(threadId, userId, oldCarrier.id));
  const custodyCoordinator = new QueuedMessageCustodyCoordinator({
    messageStore,
    now: () => oldCarrier.createdAt + 100,
  });
  assert.equal(await custodyCoordinator.withdrawEntry(oldCarrier), true);
  assert.equal(messageStore.getById(oldMessage.id)?.queueCustody?.status, 'terminal');

  const task = {
    id: 'managed-task-terminal',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 99_000 },
    params: {
      message: 'fallback',
      targetCatId: catId,
      triggerUserId: userId,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        wakeAt: 99_000,
        createdBy: `hold-ball:${catId}`,
        managedCommand: {
          state: 'enqueued',
          command: 'pnpm gate',
          startedAt: 1_000,
          conditionMetAt: 8_000,
          wakeContent: 'old command complete',
          messageId: oldMessage.id,
          messageWrittenAt: 8_100,
          dispatchAttemptCount: 1,
          lastDispatchAt: 8_200,
          lastDispatchOutcome: 'enqueued',
        },
      },
    },
    display: { label: 'hold', category: 'system', description: 'hold' },
    deliveryThreadId: threadId,
    enabled: true,
    createdBy: `hold-ball:${catId}`,
    createdAt: new Date(1_000).toISOString(),
  };
  const tasks = new Map([[task.id, task]]);
  const taskStore = {
    getAll: () => [...tasks.values()],
    getById: (id) => tasks.get(id) ?? null,
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
  };

  const providerStarts = [];
  const invocationTracker = {
    start: () => new AbortController(),
    startAll: () => new AbortController(),
    complete: noop,
    completeAll: noop,
    has: () => false,
  };
  let invocationSequence = 0;
  const invocationRecordStore = {
    async create() {
      invocationSequence += 1;
      return { outcome: 'created', invocationId: `inv-terminal-recovery-${invocationSequence}` };
    },
    async get() {
      return null;
    },
    async update() {
      return {};
    },
    async getByIdempotencyKey() {
      return null;
    },
  };
  const router = {
    async *routeExecution(...args) {
      providerStarts.push(args);
      yield { type: 'done', catId, timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
  const socketManager = {
    broadcastAgentMessage: noop,
    broadcastToRoom: noop,
    emitToUser: noop,
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker,
    invocationRecordStore,
    router,
    socketManager,
    messageStore,
    queueCustodyCoordinator: custodyCoordinator,
    log,
  });
  const trigger = new ConnectorInvokeTrigger({
    router,
    socketManager,
    invocationRecordStore,
    invocationTracker,
    invocationQueue: queue,
    queueProcessor: processor,
    messageStore,
    log,
  });
  const recoveryDeps = {
    dynamicTaskStore: taskStore,
    messageStore,
    socketManager,
    taskRunner: { unregister: noop },
    invocationRecordStore,
    getInvokeTrigger: () => trigger,
    getEventCarrier: async ({
      threadId: expectedThreadId,
      userId: expectedUserId,
      catId: expectedCatId,
      messageId,
    }) => {
      const message = await messageStore.getById(messageId);
      const entryId = message?.queueCustody?.entryId;
      return resolveManagedCommandWakeEventCarrier(message, {
        threadId: expectedThreadId,
        catId: expectedCatId,
        activeQueueEntryId: entryId
          ? (queue.getEntrySnapshot(expectedThreadId, expectedUserId, entryId)?.id ?? null)
          : null,
      });
    },
    now: () => 10_000,
    dispatchedCarrierGraceMs: 1,
  };

  const sweep = new ManagedCommandWakeRecoverySweep(recoveryDeps);
  assert.deepEqual(await sweep.runOnce(), { scanned: 1, recovered: 1, pending: 0 });
  assert.equal(tasks.get(task.id).enabled, false);
  assert.equal(tasks.get(task.id).params.holdLifecycle.managedCommand.carrierTerminalReason, 'withdrawn');
  assert.equal(
    queue.findEntryWithMessageId(threadId, oldMessage.id),
    null,
    'terminal source must not mint a successor',
  );
  assert.equal(providerStarts.length, 0, 'terminal recovery must not call the provider');

  assert.equal(
    await trigger.trigger(threadId, catId, userId, 'Continue', 'message-continue-after-terminal', undefined, {
      sourceCategory: 'scheduled',
      forceQueue: true,
    }),
    'enqueued',
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(providerStarts.length, 1);
  assert.equal(providerStarts[0][1], 'Continue');

  const restartedSweep = new ManagedCommandWakeRecoverySweep(recoveryDeps);
  assert.deepEqual(await restartedSweep.runOnce(), { scanned: 0, recovered: 0, pending: 0 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(providerStarts.length, 1, 'restart cannot revive the terminal managed producer');
});

test('managed recovery rebinds stale custody once, starts one provider, and stays callable without restart', async () => {
  const threadId = 'thread-stale-managed-custody';
  const userId = 'user-original';
  const catId = 'codex-sol';
  const queue = new InvocationQueue();
  const messageStore = new MessageStore();
  const oldEntry = queue.enqueue({
    threadId,
    userId,
    ownerAuthProvenance: 'strict',
    content: '[managed wake] recovered command',
    source: 'connector',
    sourceCategory: 'scheduled',
    targetCats: [catId],
    intent: 'execute',
    autoExecute: true,
  }).entry;
  const message = messageStore.append({
    threadId,
    userId: 'scheduler',
    catId: null,
    content: oldEntry.content,
    mentions: [catId],
    timestamp: oldEntry.createdAt,
    deliveryStatus: 'queued',
    source: {
      connector: 'hold-ball',
      label: 'managed wake',
      icon: '⏱️',
      meta: { wakeWhen: true, taskId: 'managed-task-stale-custody' },
    },
  });
  queue.backfillMessageId(threadId, userId, oldEntry.id, message.id);
  const boundOld = queue.getEntrySnapshot(threadId, userId, oldEntry.id);
  assert.equal(
    messageStore.initializeQueueCustody(message.id, createInitialQueuedMessageCustody(boundOld)).kind,
    'initialized',
  );
  assert.ok(queue.remove(threadId, userId, oldEntry.id), 'simulate the retired in-memory row');

  const task = {
    id: 'managed-task-stale-custody',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 99_000 },
    params: {
      message: 'fallback',
      targetCatId: catId,
      triggerUserId: userId,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        wakeAt: 99_000,
        createdBy: `hold-ball:${catId}`,
        managedCommand: {
          state: 'enqueued',
          command: 'pnpm gate',
          startedAt: 1_000,
          conditionMetAt: 8_000,
          wakeContent: 'recovered command',
          messageId: message.id,
          messageWrittenAt: 8_100,
          dispatchAttemptCount: 1,
          lastDispatchAt: 8_200,
          lastDispatchOutcome: 'enqueued',
        },
      },
    },
    display: { label: 'hold', category: 'system', description: 'hold' },
    deliveryThreadId: threadId,
    enabled: true,
    createdBy: `hold-ball:${catId}`,
    createdAt: new Date(1_000).toISOString(),
  };
  const tasks = new Map([[task.id, task]]);
  const taskStore = {
    getAll: () => [...tasks.values()],
    getById: (id) => tasks.get(id) ?? null,
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
  };
  const providerStarts = [];
  const invocationTracker = {
    start: () => new AbortController(),
    startAll: () => new AbortController(),
    complete: noop,
    completeAll: noop,
    has: () => false,
  };
  let invocationSequence = 0;
  const records = new Map();
  const invocationRecordStore = {
    async create(input) {
      const key = input.idempotencyKey;
      const existing = records.get(key);
      if (existing) return { outcome: 'duplicate', invocationId: existing.id };
      invocationSequence += 1;
      const record = { ...input, id: `inv-stale-${invocationSequence}`, status: 'queued', userMessageId: null };
      records.set(key, record);
      return { outcome: 'created', invocationId: record.id };
    },
    async get(id) {
      return [...records.values()].find((record) => record.id === id) ?? null;
    },
    async update(id, patch) {
      const record = [...records.values()].find((candidate) => candidate.id === id);
      if (!record) return null;
      if (patch.expectedStatus && record.status !== patch.expectedStatus) return null;
      Object.assign(record, patch);
      delete record.expectedStatus;
      return record;
    },
    async getByIdempotencyKey(_threadId, _userId, key) {
      return records.get(key) ?? null;
    },
  };
  const router = {
    async *routeExecution(...args) {
      providerStarts.push(args);
      const childInvocationId = `child-stale-${providerStarts.length}`;
      await args[6].onPromptMessagesExposed({
        threadId,
        userId,
        catId,
        invocationId: childInvocationId,
        messageIds: [args[3]],
        seenAt: Date.now(),
      });
      yield {
        type: 'done',
        catId,
        invocationId: childInvocationId,
        turnCustodyTerminalWitness: {
          kind: 'managed_hold_continued',
          sourceMessageId: args[3],
          taskId: task.id,
          transition: 'reheld',
        },
        timestamp: Date.now(),
      };
    },
    async ackCollectedCursors() {},
  };
  const socketManager = { broadcastAgentMessage: noop, broadcastToRoom: noop, emitToUser: noop };
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore });
  const processor = new QueueProcessor({
    queue,
    invocationTracker,
    invocationRecordStore,
    router,
    socketManager,
    messageStore,
    queueCustodyCoordinator: coordinator,
    log,
  });
  const trigger = new ConnectorInvokeTrigger({
    router,
    socketManager,
    invocationRecordStore,
    invocationTracker,
    invocationQueue: queue,
    queueProcessor: processor,
    queueCustodyCoordinator: coordinator,
    messageStore,
    log,
  });
  const sweep = new ManagedCommandWakeRecoverySweep({
    dynamicTaskStore: taskStore,
    messageStore,
    socketManager,
    taskRunner: { unregister: noop },
    invocationRecordStore,
    getInvokeTrigger: () => trigger,
    getEventCarrier: async ({
      threadId: expectedThreadId,
      userId: expectedUserId,
      catId: expectedCatId,
      messageId,
    }) => {
      const message = await messageStore.getById(messageId);
      const entryId = message?.queueCustody?.entryId;
      return resolveManagedCommandWakeEventCarrier(message, {
        threadId: expectedThreadId,
        catId: expectedCatId,
        activeQueueEntryId: entryId
          ? (queue.getEntrySnapshot(expectedThreadId, expectedUserId, entryId)?.id ?? null)
          : null,
      });
    },
    now: () => 10_000,
    dispatchedCarrierGraceMs: 1,
  });

  const concurrentRecovery = await Promise.all([sweep.runOnce(), sweep.runOnce()]);
  assert.ok(concurrentRecovery.every((result) => result.scanned === 1));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(providerStarts.length, 1, 'the repaired carrier must reach one real provider start');
  const live = queue.findEntryWithMessageId(threadId, message.id);
  const rebound = messageStore.getById(message.id);
  assert.equal(rebound.queueCustody.status, 'terminal');
  assert.deepEqual(rebound.queueCustody.handledByCatIds, [catId]);
  assert.equal(live, null, 'the successful replacement must be consumed exactly once');

  await sweep.runOnce();
  await sweep.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(providerStarts.length, 1, 'periodic recovery must not replay after terminal settlement');

  await trigger.trigger(threadId, catId, userId, 'Continue', 'message-after-repair', undefined, {
    sourceCategory: 'scheduled',
    forceQueue: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(providerStarts.length, 2, 'the same runtime remains callable after repair');
});
