import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { createActiveExecutionService } from '../dist/domains/cats/services/agents/invocation/active-execution-service.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { PerCatTerminalDispositionCollector } from '../dist/domains/cats/services/agents/invocation/PerCatTerminalDispositionCollector.js';
import {
  createInitialFanoutQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueuedMessageCustodyStartupReconciler } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js';
import { StartupReconciler } from '../dist/domains/cats/services/agents/invocation/StartupReconciler.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { parseQueuedMessageCustody } from '../dist/domains/cats/services/stores/ports/queued-message-custody.js';
import { projectQueueReceipt } from '../dist/domains/cats/services/stores/ports/queued-message-receipt.js';

function custody(overrides = {}) {
  return {
    version: 1,
    entryId: 'entry-restart-1',
    revision: 1,
    intent: 'execute',
    status: 'queued',
    allTargetCats: ['opus'],
    pendingTargetCats: ['opus'],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function createMessageStore() {
  const store = new MessageStore();
  store.scanByDeliveryStatus = (status) =>
    store
      .getRecent(2_000)
      .filter((message) => message.deliveryStatus === status)
      .map((message) => message.id);
  return store;
}

function appendQueued(store, queueCustody = custody(), overrides = {}) {
  return store.append({
    userId: 'user-1',
    catId: null,
    content: 'survive the restart',
    mentions: ['opus'],
    timestamp: 1_000,
    threadId: 'thread-1',
    deliveryStatus: 'queued',
    ...(queueCustody ? { queueCustody } : {}),
    ...overrides,
  });
}

function record(overrides = {}) {
  return {
    id: 'inv-restart-1',
    threadId: 'thread-1',
    userId: 'user-1',
    userMessageId: null,
    targetCats: ['opus'],
    intent: 'execute',
    status: 'failed',
    idempotencyKey: 'queue-entry-restart-1-1000',
    createdAt: 1_050,
    updatedAt: 1_100,
    ...overrides,
  };
}

function createRecordStore(records = []) {
  const byId = new Map(records.map((item) => [item.id, item]));
  return {
    async get(id) {
      return byId.get(id) ?? null;
    },
  };
}

function turnExecution(overrides = {}) {
  return {
    invocationId: 'inv-restart-child-1',
    parentInvocationId: 'inv-restart-parent-1',
    threadId: 'thread-1',
    userId: 'user-1',
    catId: 'opus',
    executionKind: 'ordinary',
    status: 'succeeded',
    startedAt: 1_050,
    endedAt: 1_100,
    ...overrides,
  };
}

function createTurnExecutionStore(records = []) {
  const byId = new Map(records.map((item) => [item.invocationId, item]));
  return {
    async get(id) {
      return byId.get(id) ?? null;
    },
  };
}

function createReconciler({
  messageStore,
  invocationQueue,
  records = [],
  turnExecutions = [],
  a2aDispatchDispositionService,
}) {
  const liveA2AReplacementPreflight = {
    async inspectHandoff({ sourceMessageId, catId }) {
      return {
        outcome: 'live',
        sourceMessageId,
        fromCatId: 'source',
        handoffSourceEventId: `route:${sourceMessageId}:${catId}`,
      };
    },
  };
  return new QueuedMessageCustodyStartupReconciler({
    messageStore,
    invocationQueue,
    invocationRecordStore: createRecordStore(records),
    turnExecutionStore: createTurnExecutionStore(turnExecutions),
    a2aDispatchDispositionService: a2aDispatchDispositionService ?? liveA2AReplacementPreflight,
    now: () => 2_000,
    log: { info() {}, warn() {} },
  });
}

describe('F254 Queue restart custody', () => {
  test('PR7 restores a legal fan-out sibling without replaying its failed sibling', async () => {
    const messageStore = createMessageStore();
    const beforeRestart = new InvocationQueue();
    const entries = ['opus', 'codex'].map((catId) => {
      const result = beforeRestart.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'fan-out survives restart',
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'codex-sol',
        a2aParentInvocationId: 'parent-fanout',
        a2aTriggerMessageId: 'message-fanout-restart',
      });
      assert.equal(result.outcome, 'enqueued');
      return result.entry;
    });
    const message = appendQueued(
      messageStore,
      createInitialFanoutQueuedMessageCustody('message-fanout-restart', entries, {
        requestedTargetCats: ['opus', 'codex'],
        createdAt: 1_000,
      }),
      {
        catId: 'codex-sol',
        content: 'fan-out survives restart',
        mentions: ['opus', 'codex'],
      },
    );
    for (const entry of entries) {
      beforeRestart.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);
    }
    const failedEntry = entries.find((entry) => entry.targetCats.includes('opus'));
    beforeRestart.markQueuedFailedForCatAcrossUsers(
      'thread-1',
      'opus',
      'invocation-opus-failed',
      new Set([failedEntry.id]),
      'invocation_failed',
      1_100,
    );
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore, now: () => 1_100 });
    await coordinator.persistEntry(beforeRestart.getEntrySnapshot('thread-1', 'user-1', failedEntry.id));

    const afterRestart = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue: afterRestart });
    const first = await reconciler.reconcile();
    const second = await reconciler.reconcile();

    assert.equal(first.entriesRestored, 2);
    assert.equal(second.entriesRestored, 0, 'reconnect/restart replay must remain idempotent');
    const restoredFailed = afterRestart.getEntrySnapshot('thread-1', 'user-1', failedEntry.id);
    assert.deepEqual(restoredFailed.queuedFailedByCatIds, ['opus']);
    assert.equal(afterRestart.findInFlightAgentEntry('thread-1', 'opus', 'codex-sol'), null);
    assert.deepEqual(
      afterRestart.listAutoExecute('thread-1').map((entry) => entry.targetCats[0]),
      ['codex'],
    );
    const next = afterRestart.markProcessingAcrossUsers('thread-1');
    assert.deepEqual(next.targetCats, ['codex'], 'the legal pending sibling must not be swallowed by the failed head');
    assert.deepEqual(
      messageStore.getById(message.id).queueCustody.allTargetCats,
      ['opus', 'codex'],
      'restart preserves the immutable whole-group target set',
    );
  });

  test('restores an unread message as the exact same Queue owner and is idempotent', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(messageStore);
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const first = await reconciler.reconcile();
    const second = await reconciler.reconcile();

    assert.equal(first.entriesRestored, 1);
    assert.equal(second.entriesRestored, 0);
    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.equal(restored.id, 'entry-restart-1');
    assert.equal(restored.messageId, message.id);
    assert.equal(restored.status, 'queued');
    assert.equal(restored.ownerAuthProvenance, 'unknown', 'legacy custody without provenance must fail closed');
    assert.deepEqual(first.resumeScopes, [{ threadId: 'thread-1', userId: 'user-1' }]);
    assert.deepEqual(second.resumeScopes, []);
    assert.equal(messageStore.getById(message.id).deliveryStatus, 'queued');
  });

  test('restores the exact server-derived owner authentication provenance', async () => {
    const messageStore = createMessageStore();
    appendQueued(messageStore, custody({ ownerAuthProvenance: 'strict' }));
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.equal(restored.ownerAuthProvenance, 'strict');
  });

  test('restores a scheduler-authored managed wake under its durable user owner principal', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(messageStore, custody({ ownerUserId: 'user-1', ownerAuthProvenance: 'strict' }), {
      userId: 'scheduler',
      source: {
        connector: 'hold-ball',
        label: 'managed wake',
        icon: '⏱️',
        meta: { wakeWhen: true, taskId: 'hold-ball-owner-restart' },
      },
    });
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.ok(restored);
    assert.equal(restored.userId, 'user-1');
    assert.equal(restored.messageId, message.id);
    assert.equal(restored.source, 'connector');
    assert.equal(restored.sourceCategory, 'scheduled');
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'scheduler', 'entry-restart-1'), null);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-foreign', 'entry-restart-1'), null);
    assert.deepEqual(result.resumeScopes, [{ threadId: 'thread-1', userId: 'user-1' }]);

    const tracker = {
      has: () => false,
      getUserId: () => null,
      cancel: () => ({ cancelled: false, catIds: [] }),
      getActiveSlots: () => [],
      listActiveThreadIds: () => [],
    };
    const activeExecutions = createActiveExecutionService({
      invocationTracker: tracker,
      turnExecutionStore: {
        async listByParent() {
          return [];
        },
        async listRunningByUser(viewerUserId) {
          return viewerUserId === restored.userId
            ? [
                {
                  invocationId: 'invocation-restored-owner',
                  threadId: restored.threadId,
                  userId: restored.userId,
                  catId: restored.targetCats[0],
                  status: 'running',
                  startedAt: 2_100,
                },
              ]
            : [];
        },
      },
      log: { info() {}, warn() {} },
    });
    const ownerSnapshot = await activeExecutions.buildSnapshot('user-1');
    assert.deepEqual(await activeExecutions.resolveWorkingPresence('thread-1', 'user-1', ownerSnapshot), {
      catIds: ['opus'],
      activeSince: 2_100,
      complete: true,
    });
    const foreignSnapshot = await activeExecutions.buildSnapshot('user-foreign');
    assert.deepEqual(await activeExecutions.resolveWorkingPresence('thread-1', 'user-foreign', foreignSnapshot), {
      catIds: [],
      complete: true,
    });
  });

  test('rehydrates a wait continuation carrier from its canonical connector message', async () => {
    const messageStore = createMessageStore();
    const waitContinuationCarrier = {
      v: 1,
      waitId: 'task-pr-7',
      outcomeId: 'wait:pr:owner/repo#7:g3:matched',
      ownerFence: { kind: 'containing_task', generation: 3 },
    };
    appendQueued(messageStore, custody({ ownerAuthProvenance: 'strict' }), {
      source: {
        connector: 'github-wait',
        label: 'GitHub Wait',
        icon: 'github',
        meta: { waitContinuationCarrier },
      },
    });
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.equal(restored.source, 'connector');
    assert.deepEqual(restored.waitContinuationCarrier, waitContinuationCarrier);
    assert.equal(restored.actionSuccessorFence, undefined);
  });

  test('reconstructs the same durable retry attempt identity after restart', async () => {
    const messageStore = createMessageStore();
    appendQueued(
      messageStore,
      custody({
        targetAttempts: [
          {
            id: 'entry-restart-1:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'failed',
            terminalReason: 'invocation_failed',
            createdAt: 1_000,
            updatedAt: 1_100,
          },
          {
            id: 'entry-restart-1:opus:2',
            targetCatId: 'opus',
            sequence: 2,
            state: 'queued',
            createdAt: 1_200,
            updatedAt: 1_200,
          },
        ],
        updatedAt: 1_200,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.deepEqual(restored.queuedAttemptIdByCatId, { opus: 'entry-restart-1:opus:2' });
  });

  test('does not replace the original Queue idempotency identity with the initial attempt after restart', async () => {
    const messageStore = createMessageStore();
    appendQueued(
      messageStore,
      custody({
        targetAttempts: [
          {
            id: 'entry-restart-1:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'queued',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.equal(restored.queuedAttemptIdByCatId, undefined);
  });

  test('restores one durable cross-thread carrier per target without cloning the message body', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-restart',
        ownerAuthProvenance: 'strict',
        receiptScope: 'cross_thread_delivery',
        allTargetCats: ['opus', 'codex'],
        pendingTargetCats: ['opus', 'codex'],
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-opus',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-restart',
            autoExecute: true,
            createdAt: 1_000,
          },
          codex: {
            entryId: 'carrier-codex',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-restart',
            autoExecute: true,
            createdAt: 1_001,
          },
        },
        carrierStateByTargetCatId: {
          opus: { status: 'queued' },
          codex: { status: 'queued' },
        },
      }),
      { catId: 'sonnet', mentions: ['opus', 'codex'] },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 2);
    const opus = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-opus');
    const codex = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-codex');
    assert.deepEqual(opus.targetCats, ['opus']);
    assert.deepEqual(codex.targetCats, ['codex']);
    for (const entry of [opus, codex]) {
      assert.equal(entry.messageId, message.id);
      assert.equal(entry.source, 'agent');
      assert.equal(entry.sourceCategory, 'a2a');
      assert.equal(entry.callerCatId, 'sonnet');
      assert.equal(entry.a2aParentInvocationId, 'parent-source');
      assert.equal(entry.a2aTriggerMessageId, 'message-restart');
      assert.equal(entry.autoExecute, true);
      assert.equal(entry.ownerAuthProvenance, 'strict');
    }
  });

  test('restores coalesced cross-thread messages into their one shared Queue carrier', async () => {
    const messageStore = createMessageStore();
    const carrier = {
      opus: {
        entryId: 'carrier-shared',
        source: 'agent',
        sourceCategory: 'a2a',
        callerCatId: 'sonnet',
        a2aParentInvocationId: 'parent-source',
        a2aTriggerMessageId: 'message-first',
        autoExecute: true,
        createdAt: 1_000,
      },
    };
    const first = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-first',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: carrier,
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
        targetAttempts: [
          {
            id: 'cross-thread:message-first:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'queued',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      }),
      { catId: 'sonnet', content: 'first handoff', timestamp: 1_000 },
    );
    const second = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-second',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: carrier,
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
        targetAttempts: [
          {
            id: 'cross-thread:message-second:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'queued',
            createdAt: 1_001,
            updatedAt: 1_001,
          },
        ],
      }),
      { catId: 'sonnet', content: 'second handoff', timestamp: 1_001 },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 1);
    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-shared');
    assert.equal(restored.messageId, first.id);
    assert.deepEqual(restored.mergedMessageIds, [second.id]);
    assert.equal(restored.content, 'first handoff\nsecond handoff');
    assert.deepEqual(restored.targetCats, ['opus']);
    assert.equal(restored.autoExecute, true);
    assert.equal(restored.queuedAttemptIdByCatId, undefined);
  });

  test('restores a coalesced target carrier when sibling messages have different global target sets', async () => {
    const messageStore = createMessageStore();
    const opusCarrier = {
      entryId: 'carrier-opus-shared',
      source: 'agent',
      sourceCategory: 'a2a',
      callerCatId: 'sonnet',
      a2aParentInvocationId: 'parent-source',
      a2aTriggerMessageId: 'message-first',
      autoExecute: true,
      createdAt: 1_000,
    };
    const codexCarrier = {
      ...opusCarrier,
      entryId: 'carrier-codex',
      createdAt: 1_001,
    };
    const first = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-first',
        receiptScope: 'cross_thread_delivery',
        allTargetCats: ['opus', 'codex'],
        pendingTargetCats: ['opus', 'codex'],
        carrierByTargetCatId: { opus: opusCarrier, codex: codexCarrier },
        carrierStateByTargetCatId: { opus: { status: 'queued' }, codex: { status: 'queued' } },
      }),
      { catId: 'sonnet', content: 'first handoff', timestamp: 1_000, mentions: ['opus', 'codex'] },
    );
    const second = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-second',
        receiptScope: 'cross_thread_delivery',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        carrierByTargetCatId: { opus: opusCarrier },
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
      }),
      { catId: 'sonnet', content: 'second handoff', timestamp: 1_002, mentions: ['opus'] },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 2);
    const opus = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-opus-shared');
    assert.equal(opus.messageId, first.id);
    assert.deepEqual(opus.mergedMessageIds, [second.id]);
    assert.deepEqual(opus.targetCats, ['opus']);
    assert.deepEqual(opus.allTargetCats, ['opus']);
    const codex = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-codex');
    assert.equal(codex.messageId, first.id);
    assert.deepEqual(codex.mergedMessageIds, []);
    assert.deepEqual(codex.targetCats, ['codex']);
  });

  test('isolates one corrupt queued record and continues restoring the remaining messages', async () => {
    const messageStore = createMessageStore();
    const corrupt = appendQueued(messageStore, custody({ entryId: 'entry-corrupt' }), { content: 'corrupt' });
    const healthy = appendQueued(messageStore, custody({ entryId: 'entry-healthy' }), { content: 'healthy' });
    const getById = messageStore.getById.bind(messageStore);
    messageStore.getById = (id) => {
      if (id === corrupt.id) throw new Error('invalid queue custody payload');
      return getById(id);
    };
    const warnings = [];
    const invocationQueue = new InvocationQueue();
    const reconciler = new QueuedMessageCustodyStartupReconciler({
      messageStore,
      invocationQueue,
      invocationRecordStore: createRecordStore(),
      now: () => 2_000,
      log: {
        info() {},
        warn(message) {
          warnings.push(message);
        },
      },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.messagesFailed, 1);
    assert.equal(result.entriesRestored, 1);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-healthy').messageId, healthy.id);
    assert.ok(warnings.some((message) => message.includes(corrupt.id)));
  });

  test('terminalizes a legacy unfenced github-wait group without blocking a later healthy custody group', async () => {
    const messageStore = createMessageStore();
    const legacy = appendQueued(messageStore, custody({ entryId: 'entry-legacy-wait' }), {
      content: 'pre-Gate-4 github wait',
      source: {
        connector: 'github-wait',
        label: 'GitHub Wait',
        icon: 'github',
      },
    });
    const healthy = appendQueued(messageStore, custody({ entryId: 'entry-healthy-after-legacy' }), {
      content: 'healthy queued work',
    });
    const warnings = [];
    const invocationQueue = new InvocationQueue();
    const reconciler = new QueuedMessageCustodyStartupReconciler({
      messageStore,
      invocationQueue,
      invocationRecordStore: createRecordStore(),
      now: () => 2_000,
      log: {
        info() {},
        warn(message) {
          warnings.push(message);
        },
      },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 1);
    assert.equal(result.messagesTerminalized, 1);
    assert.equal(
      invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-healthy-after-legacy').messageId,
      healthy.id,
    );
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-legacy-wait'), null);
    const storedLegacy = messageStore.getById(legacy.id);
    assert.equal(storedLegacy.deliveryStatus, 'delivered');
    assert.equal(storedLegacy.queueCustody.status, 'terminal');
    assert.deepEqual(storedLegacy.queueCustody.pendingTargetCats, []);
    assert.deepEqual(storedLegacy.queueCustody.failedByCatIds, ['opus']);
    assert.ok(warnings.some((message) => message.includes(legacy.id)));
  });

  test('distinguishes malformed custody from an absent legacy custody field', () => {
    assert.equal(parseQueuedMessageCustody(undefined), undefined);
    assert.throws(
      () => parseQueuedMessageCustody('{"version":1,"entryId":'),
      (error) => error?.code === 'INVALID_QUEUE_CUSTODY',
    );
  });

  test('cancel clears active custody instead of leaving an invalid canceled/custody binding', () => {
    const messageStore = createMessageStore();
    const message = appendQueued(messageStore);

    const canceled = messageStore.markCanceled(message.id);

    assert.equal(canceled.deliveryStatus, 'canceled');
    assert.equal(canceled.queueCustody, undefined);
  });

  test('preserves crash-after-take as the same durable Queue item before admission', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        processingStartedAt: 1_100,
        targetAttempts: [
          {
            id: 'entry-restart-1:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'queued',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 1);
    assert.equal(result.messagesTerminalized, 0);
    assert.deepEqual(result.resumeScopes, [{ threadId: 'thread-1', userId: 'user-1' }]);
    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.equal(restored.status, 'queued');
    assert.equal(restored.messageId, message.id);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.equal(stored.queueCustody.status, 'queued');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, ['opus']);
    assert.deepEqual(stored.queueCustody.failedByCatIds, []);
    assert.deepEqual(stored.queueCustody.targetAttempts, [
      {
        id: 'entry-restart-1:opus:1',
        targetCatId: 'opus',
        sequence: 1,
        state: 'queued',
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);
    assert.equal(projectQueueReceipt(stored.queueCustody).targets[0].state, 'queued');
  });

  test('terminalizes crash-after-accept-before-result as interrupted/runtime_restart without replay', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        awakenedInvocationIdByCatId: { opus: 'inv-failed' },
        awakenedAtByCatId: { opus: 1_050 },
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-failed' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-failed', seenAt: 1_075 }],
        targetAttempts: [
          {
            id: 'entry-restart-1:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'appended',
            invocationId: 'inv-failed',
            seenAt: 1_075,
            createdAt: 1_000,
            updatedAt: 1_075,
          },
        ],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      records: [record({ id: 'inv-failed', status: 'failed' })],
      turnExecutions: [
        turnExecution({
          invocationId: 'inv-failed',
          status: 'interrupted',
          terminalReason: 'process_restart',
          endedAt: 2_000,
        }),
      ],
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 1);
    assert.deepEqual(result.resumeScopes, []);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1'), null);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.equal(stored.queueCustody.status, 'terminal');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, []);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
    assert.deepEqual(stored.queueCustody.seenInvocationIdByCatId, {});
    assert.deepEqual(stored.queueCustody.bodyExposures, [
      { targetCatId: 'opus', invocationId: 'inv-failed', seenAt: 1_075 },
    ]);
    assert.deepEqual(stored.queueCustody.targetAttempts, [
      {
        id: 'entry-restart-1:opus:1',
        targetCatId: 'opus',
        sequence: 1,
        state: 'interrupted',
        invocationId: 'inv-failed',
        seenAt: 1_075,
        terminalReason: 'runtime_restart',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ]);
  });

  test('does not replay an accepted child whose detached runtime survived the API restart', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        awakenedInvocationIdByCatId: { opus: 'inv-live' },
        awakenedAtByCatId: { opus: 1_050 },
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-live' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-live', seenAt: 1_075 }],
        targetAttempts: [
          {
            id: 'entry-restart-1:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'appended',
            invocationId: 'inv-live',
            seenAt: 1_075,
            createdAt: 1_000,
            updatedAt: 1_075,
          },
        ],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      turnExecutions: [turnExecution({ invocationId: 'inv-live', status: 'running', endedAt: undefined })],
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 0);
    assert.deepEqual(result.resumeScopes, []);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1'), null);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.queueCustody.status, 'processing');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, ['opus']);
    assert.deepEqual(stored.queueCustody.failedByCatIds, []);
    assert.deepEqual(stored.queueCustody.seenInvocationIdByCatId, { opus: 'inv-live' });
    assert.equal(stored.queueCustody.targetAttempts[0].state, 'appended');
  });

  test('keeps an unread reminder open while its exact detached child remains live', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        awakenedInvocationIdByCatId: { opus: 'inv-live-reminder' },
        awakenedAtByCatId: { opus: 1_050 },
        reminderAttempts: [
          {
            id: 'reminder-live',
            targetCatId: 'opus',
            invocationId: 'inv-live-reminder',
            state: 'delivered',
            requestedAt: 1_080,
            deliveredAt: 1_090,
          },
        ],
        targetAttempts: [
          {
            id: 'entry-restart-1:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'starting',
            invocationId: 'inv-live-reminder',
            createdAt: 1_000,
            updatedAt: 1_050,
          },
        ],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      turnExecutions: [turnExecution({ invocationId: 'inv-live-reminder', status: 'running', endedAt: undefined })],
    });

    await reconciler.reconcile();

    const attempt = messageStore.getById(message.id).queueCustody.reminderAttempts[0];
    assert.equal(attempt.state, 'delivered');
    assert.equal(attempt.missedAt, undefined);
  });

  test('restores a pre-admission sibling while preserving a live accepted target', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        allTargetCats: ['opus', 'codex'],
        pendingTargetCats: ['opus', 'codex'],
        awakenedInvocationIdByCatId: { opus: 'inv-live' },
        awakenedAtByCatId: { opus: 1_050 },
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-live' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-live', seenAt: 1_075 }],
        targetAttempts: [
          {
            id: 'entry-restart-1:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'appended',
            invocationId: 'inv-live',
            seenAt: 1_075,
            createdAt: 1_000,
            updatedAt: 1_075,
          },
          {
            id: 'entry-restart-1:codex:1',
            targetCatId: 'codex',
            sequence: 1,
            state: 'queued',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
      { mentions: ['opus', 'codex'] },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      turnExecutions: [turnExecution({ invocationId: 'inv-live', status: 'running', endedAt: undefined })],
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 1);
    assert.deepEqual(result.resumeScopes, [{ threadId: 'thread-1', userId: 'user-1' }]);
    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.deepEqual(restored.targetCats, ['codex']);
    assert.deepEqual(restored.allTargetCats, ['opus', 'codex']);
    const projected = messageStore.getById(message.id).queueCustody;
    assert.equal(projected.status, 'processing');
    assert.deepEqual(projected.pendingTargetCats, ['opus', 'codex']);
    assert.deepEqual(projected.seenInvocationIdByCatId, { opus: 'inv-live' });
    assert.deepEqual(projected.carrierStateByTargetCatId, {
      opus: { status: 'processing', processingStartedAt: 1_100 },
      codex: { status: 'queued' },
    });

    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore, now: () => 2_100 });
    await coordinator.persistEntry(restored);
    const persisted = messageStore.getById(message.id).queueCustody;
    assert.equal(persisted.status, 'processing');
    assert.deepEqual(persisted.pendingTargetCats, ['opus', 'codex']);
    assert.deepEqual(persisted.seenInvocationIdByCatId, { opus: 'inv-live' });
  });

  test('settles an interrupted sibling while preserving a live accepted target without replaying either', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        allTargetCats: ['opus', 'codex'],
        pendingTargetCats: ['opus', 'codex'],
        awakenedInvocationIdByCatId: { opus: 'inv-live', codex: 'inv-lost' },
        awakenedAtByCatId: { opus: 1_050, codex: 1_060 },
        seenByCatIds: ['opus', 'codex'],
        seenInvocationIdByCatId: { opus: 'inv-live', codex: 'inv-lost' },
        bodyExposures: [
          { targetCatId: 'opus', invocationId: 'inv-live', seenAt: 1_075 },
          { targetCatId: 'codex', invocationId: 'inv-lost', seenAt: 1_080 },
        ],
        targetAttempts: [
          {
            id: 'entry-restart-1:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'appended',
            invocationId: 'inv-live',
            seenAt: 1_075,
            createdAt: 1_000,
            updatedAt: 1_075,
          },
          {
            id: 'entry-restart-1:codex:1',
            targetCatId: 'codex',
            sequence: 1,
            state: 'appended',
            invocationId: 'inv-lost',
            seenAt: 1_080,
            createdAt: 1_000,
            updatedAt: 1_080,
          },
        ],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
      { mentions: ['opus', 'codex'] },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      turnExecutions: [
        turnExecution({ invocationId: 'inv-live', status: 'running', endedAt: undefined }),
        turnExecution({
          invocationId: 'inv-lost',
          catId: 'codex',
          status: 'interrupted',
          terminalReason: 'process_restart',
          endedAt: 2_000,
        }),
      ],
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 0);
    assert.equal(result.failedTargets, 1);
    assert.deepEqual(result.resumeScopes, []);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1'), null);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.queueCustody.status, 'processing');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, ['opus']);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['codex']);
    assert.deepEqual(stored.queueCustody.seenInvocationIdByCatId, { opus: 'inv-live' });
    assert.deepEqual(
      stored.queueCustody.targetAttempts.map(({ targetCatId, state, terminalReason }) => ({
        targetCatId,
        state,
        terminalReason,
      })),
      [
        { targetCatId: 'opus', state: 'appended', terminalReason: undefined },
        { targetCatId: 'codex', state: 'interrupted', terminalReason: 'runtime_restart' },
      ],
    );
  });

  test('terminalizes a replaced A2A carrier at startup instead of resuming its old prompt', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-replaced',
        revision: 2,
        receiptScope: 'cross_thread_delivery',
        status: 'processing',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-replaced-before-restart' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-replaced-before-restart', seenAt: 1_075 }],
        targetAttempts: [
          {
            id: 'carrier-opus:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'appended',
            invocationId: 'inv-replaced-before-restart',
            seenAt: 1_075,
            createdAt: 1_000,
            updatedAt: 1_075,
          },
        ],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-opus',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-replaced',
            autoExecute: true,
            createdAt: 1_000,
          },
        },
        carrierStateByTargetCatId: { opus: { status: 'processing', processingStartedAt: 1_100 } },
      }),
      { id: 'message-replaced', catId: 'sonnet', mentions: ['opus'] },
    );
    const invocationQueue = new InvocationQueue();
    const inspectHandoff = mock.fn(async () => ({
      outcome: 'replaced',
      sourceMessageId: message.id,
      fromCatId: 'sonnet',
      handoffSourceEventId: 'route:message-replaced:opus',
      replacement: {
        kind: 'handed',
        sourceEventId: 'route:message-successor:opus',
        sourceMessageId: 'message-successor',
        fromCatId: 'sonnet',
        toCatId: 'opus',
      },
    }));
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      records: [record({ id: 'inv-replaced-before-restart', status: 'failed' })],
      a2aDispatchDispositionService: { inspectHandoff },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 1);
    assert.deepEqual(result.resumeScopes, []);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-opus'), null);
    assert.deepEqual(
      inspectHandoff.mock.calls.map((call) => call.arguments[0].sourceMessageId),
      ['message-replaced', message.id],
    );
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.equal(stored.queueCustody.status, 'terminal');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, []);
    assert.deepEqual(stored.queueCustody.failedByCatIds, []);
    assert.deepEqual(stored.queueCustody.withdrawnByCatIds, ['opus']);
    assert.deepEqual(stored.queueCustody.targetAttempts, [
      {
        id: 'carrier-opus:opus:1',
        targetCatId: 'opus',
        sequence: 1,
        state: 'cancelled',
        invocationId: 'inv-replaced-before-restart',
        seenAt: 1_075,
        terminalReason: 'source_withdrawn',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ]);

    const repeated = await reconciler.reconcile();
    assert.equal(repeated.entriesRestored, 0);
    assert.equal(inspectHandoff.mock.calls.length, 2);
  });

  test('rechecks the A2A replacement fence after a restart custody CAS race', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-race',
        revision: 2,
        receiptScope: 'cross_thread_delivery',
        status: 'processing',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-race-before-restart' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-race-before-restart', seenAt: 1_075 }],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-race',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-race',
            autoExecute: true,
            createdAt: 1_000,
          },
        },
        carrierStateByTargetCatId: { opus: { status: 'processing', processingStartedAt: 1_100 } },
      }),
      { id: 'message-race', catId: 'sonnet', mentions: ['opus'] },
    );
    const transitionQueueCustody = messageStore.transitionQueueCustody.bind(messageStore);
    let forceRevisionMismatch = true;
    messageStore.transitionQueueCustody = (messageId, input) => {
      if (forceRevisionMismatch) {
        forceRevisionMismatch = false;
        return { kind: 'revision_mismatch', actualRevision: input.expectedRevision + 1 };
      }
      return transitionQueueCustody(messageId, input);
    };
    let inspectionCount = 0;
    const inspectHandoff = mock.fn(async () => {
      inspectionCount += 1;
      return inspectionCount === 1
        ? {
            outcome: 'live',
            sourceMessageId: message.id,
            fromCatId: 'sonnet',
            handoffSourceEventId: 'route:message-race:opus',
          }
        : {
            outcome: 'replaced',
            sourceMessageId: message.id,
            fromCatId: 'sonnet',
            handoffSourceEventId: 'route:message-race:opus',
            replacement: {
              kind: 'handed',
              sourceEventId: 'route:message-successor:opus',
              sourceMessageId: 'message-successor',
              fromCatId: 'sonnet',
              toCatId: 'opus',
            },
          };
    });
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      records: [record({ id: 'inv-race-before-restart', status: 'failed' })],
      a2aDispatchDispositionService: { inspectHandoff },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 1);
    assert.equal(inspectHandoff.mock.calls.length, 4);
    assert.equal(messageStore.getById(message.id).deliveryStatus, 'delivered');
    assert.deepEqual(messageStore.getById(message.id).queueCustody.withdrawnByCatIds, ['opus']);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-race'), null);
  });

  test('keeps a non-replaced pre-admission A2A carrier recoverable exactly once', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-live',
        revision: 2,
        receiptScope: 'cross_thread_delivery',
        status: 'processing',
        targetAttempts: [
          {
            id: 'carrier-live:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'queued',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-live',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-live',
            autoExecute: true,
            createdAt: 1_000,
          },
        },
        carrierStateByTargetCatId: { opus: { status: 'processing', processingStartedAt: 1_100 } },
      }),
      { id: 'message-live', catId: 'sonnet', mentions: ['opus'] },
    );
    const inspectHandoff = mock.fn(async () => ({
      outcome: 'live',
      sourceMessageId: message.id,
      fromCatId: 'sonnet',
      handoffSourceEventId: 'route:message-live:opus',
    }));
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      a2aDispatchDispositionService: { inspectHandoff },
    });

    const first = await reconciler.reconcile();
    const second = await reconciler.reconcile();

    assert.equal(first.entriesRestored, 1);
    assert.equal(second.entriesRestored, 0);
    assert.deepEqual(first.resumeScopes, [{ threadId: 'thread-1', userId: 'user-1' }]);
    assert.equal(messageStore.getById(message.id).deliveryStatus, 'queued');
    assert.deepEqual(messageStore.getById(message.id).queueCustody.failedByCatIds, []);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-live').status, 'queued');
    assert.equal(inspectHandoff.mock.calls.length, 4);
  });

  test('terminalizes a non-replaced accepted A2A carrier when its exact child truth is missing', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-accepted-missing-child',
        revision: 2,
        receiptScope: 'cross_thread_delivery',
        status: 'processing',
        awakenedInvocationIdByCatId: { opus: 'inv-accepted-missing-child' },
        awakenedAtByCatId: { opus: 1_050 },
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-accepted-missing-child' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-accepted-missing-child', seenAt: 1_075 }],
        targetAttempts: [
          {
            id: 'carrier-accepted-missing-child:opus:1',
            targetCatId: 'opus',
            sequence: 1,
            state: 'appended',
            invocationId: 'inv-accepted-missing-child',
            seenAt: 1_075,
            createdAt: 1_000,
            updatedAt: 1_075,
          },
        ],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-accepted-missing-child',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-accepted-missing-child',
            autoExecute: true,
            createdAt: 1_000,
          },
        },
        carrierStateByTargetCatId: { opus: { status: 'processing', processingStartedAt: 1_100 } },
      }),
      { id: 'message-accepted-missing-child', catId: 'sonnet', mentions: ['opus'] },
    );
    const inspectHandoff = mock.fn(async () => ({
      outcome: 'live',
      sourceMessageId: message.id,
      fromCatId: 'sonnet',
      handoffSourceEventId: 'route:message-accepted-missing-child:opus',
    }));
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      a2aDispatchDispositionService: { inspectHandoff },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 1);
    assert.deepEqual(result.resumeScopes, []);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-accepted-missing-child'), null);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.equal(stored.queueCustody.status, 'terminal');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, []);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
    assert.deepEqual(
      stored.queueCustody.targetAttempts.map(({ state, terminalReason, invocationId }) => ({
        state,
        terminalReason,
        invocationId,
      })),
      [
        {
          state: 'interrupted',
          terminalReason: 'runtime_restart',
          invocationId: 'inv-accepted-missing-child',
        },
      ],
    );
  });

  test('keeps an A2A carrier queued when replacement preflight is unavailable', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-preflight-unavailable',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-preflight-unavailable',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-preflight-unavailable',
            autoExecute: true,
            createdAt: 1_000,
          },
        },
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
      }),
      { id: 'message-preflight-unavailable', catId: 'sonnet', mentions: ['opus'] },
    );
    const inspectHandoff = mock.fn(async () => {
      throw new Error('ball custody event log unavailable');
    });
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      a2aDispatchDispositionService: { inspectHandoff },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.deepEqual(result.resumeScopes, []);
    assert.equal(messageStore.getById(message.id).deliveryStatus, 'queued');
    assert.equal(messageStore.getById(message.id).queueCustody.revision, 1);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-preflight-unavailable'), null);
    assert.equal(inspectHandoff.mock.calls.length, 2);
  });

  test('quarantines every coalesced carrier member when one replacement preflight is temporarily unavailable', async () => {
    const messageStore = createMessageStore();
    const carrier = {
      opus: {
        entryId: 'carrier-preflight-group',
        source: 'agent',
        sourceCategory: 'a2a',
        callerCatId: 'sonnet',
        a2aParentInvocationId: 'parent-source',
        a2aTriggerMessageId: 'message-preflight-group-first',
        autoExecute: true,
        createdAt: 1_000,
      },
    };
    const first = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-preflight-group-first',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: carrier,
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
      }),
      { id: 'message-preflight-group-first', catId: 'sonnet', mentions: ['opus'] },
    );
    const second = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-preflight-group-second',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: carrier,
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
        createdAt: 1_001,
        updatedAt: 1_001,
      }),
      { id: 'message-preflight-group-second', catId: 'sonnet', mentions: ['opus'], timestamp: 1_001 },
    );
    let firstSourceReads = 0;
    const inspectHandoff = mock.fn(async ({ sourceMessageId, catId }) => {
      if (sourceMessageId === first.id && firstSourceReads++ === 0) {
        throw new Error('ball custody event log temporarily unavailable');
      }
      return {
        outcome: 'live',
        sourceMessageId,
        fromCatId: 'sonnet',
        handoffSourceEventId: `route:${sourceMessageId}:${catId}`,
      };
    });
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      a2aDispatchDispositionService: { inspectHandoff },
    });

    const deferred = await reconciler.reconcile();

    assert.equal(deferred.entriesRestored, 0);
    assert.deepEqual(deferred.resumeScopes, []);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-preflight-group'), null);
    assert.equal(messageStore.getById(first.id).deliveryStatus, 'queued');
    assert.equal(messageStore.getById(second.id).deliveryStatus, 'queued');

    const retried = await reconciler.reconcile();

    assert.equal(retried.entriesRestored, 1, 'the unchanged group is retryable once preflight truth returns');
    assert.deepEqual(retried.resumeScopes, [{ threadId: 'thread-1', userId: 'user-1' }]);
    assert.deepEqual(
      invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-preflight-group').mergedMessageIds,
      [second.id],
    );
  });

  test('quarantines a shared carrier when an initial sibling read fails before preflight', async () => {
    const messageStore = createMessageStore();
    const carrier = {
      opus: {
        entryId: 'carrier-outer-error-group',
        source: 'agent',
        sourceCategory: 'a2a',
        callerCatId: 'sonnet',
        a2aParentInvocationId: 'parent-source',
        a2aTriggerMessageId: 'message-outer-error-first',
        autoExecute: true,
        createdAt: 1_000,
      },
    };
    const first = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-outer-error-first',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: carrier,
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
      }),
      { id: 'message-outer-error-first', catId: 'sonnet', content: 'first source', mentions: ['opus'] },
    );
    const second = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-outer-error-second',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: carrier,
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
        createdAt: 1_001,
        updatedAt: 1_001,
      }),
      {
        id: 'message-outer-error-second',
        catId: 'sonnet',
        content: 'second source',
        mentions: ['opus'],
        timestamp: 1_001,
      },
    );
    const getById = messageStore.getById.bind(messageStore);
    let firstReadFails = true;
    messageStore.getById = (messageId) => {
      if (messageId === first.id && firstReadFails) {
        firstReadFails = false;
        throw new Error('temporary source-row read failure');
      }
      return getById(messageId);
    };
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const deferred = await reconciler.reconcile();

    assert.equal(deferred.messagesFailed, 1);
    assert.equal(deferred.entriesRestored, 0);
    assert.deepEqual(deferred.resumeScopes, []);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-outer-error-group'), null);

    const retried = await reconciler.reconcile();

    assert.equal(retried.entriesRestored, 1, 'the unchanged carrier retries once its missing sibling can be read');
    assert.deepEqual(retried.resumeScopes, [{ threadId: 'thread-1', userId: 'user-1' }]);
    assert.deepEqual(
      invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-outer-error-group').mergedMessageIds,
      [second.id],
    );
  });

  test('withdraws a replaced A2A target while restoring its live sibling target', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-partial-target-replacement',
        receiptScope: 'cross_thread_delivery',
        allTargetCats: ['opus', 'codex'],
        pendingTargetCats: ['opus', 'codex'],
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-partial-target-opus',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-partial-target-replacement',
            autoExecute: true,
            createdAt: 1_000,
          },
          codex: {
            entryId: 'carrier-partial-target-codex',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-partial-target-replacement',
            autoExecute: true,
            createdAt: 1_000,
          },
        },
        carrierStateByTargetCatId: { opus: { status: 'queued' }, codex: { status: 'queued' } },
      }),
      { id: 'message-partial-target-replacement', catId: 'sonnet', mentions: ['opus', 'codex'] },
    );
    const inspectHandoff = mock.fn(async ({ catId, sourceMessageId }) =>
      catId === 'opus'
        ? {
            outcome: 'replaced',
            sourceMessageId,
            fromCatId: 'sonnet',
            handoffSourceEventId: 'route:message-partial-target-replacement:opus',
            replacement: {
              kind: 'handed',
              sourceEventId: 'route:message-partial-target-successor:opus',
              sourceMessageId: 'message-partial-target-successor',
              fromCatId: 'sonnet',
              toCatId: 'opus',
            },
          }
        : {
            outcome: 'live',
            sourceMessageId,
            fromCatId: 'sonnet',
            handoffSourceEventId: `route:${sourceMessageId}:${catId}`,
          },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      a2aDispatchDispositionService: { inspectHandoff },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 1);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-partial-target-opus'), null);
    assert.deepEqual(
      invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-partial-target-codex').targetCats,
      ['codex'],
    );
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, ['codex']);
    assert.deepEqual(stored.queueCustody.withdrawnByCatIds, ['opus']);
  });

  test('keeps a post-settlement surviving source live during startup preflight', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-surviving-source',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-post-settlement',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-retired-trigger',
            autoExecute: true,
            createdAt: 1_000,
          },
        },
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
      }),
      { id: 'message-surviving-source', catId: 'sonnet', mentions: ['opus'] },
    );
    const inspectHandoff = mock.fn(async ({ sourceMessageId, catId }) =>
      sourceMessageId === 'message-retired-trigger'
        ? {
            outcome: 'replaced',
            sourceMessageId,
            fromCatId: 'sonnet',
            handoffSourceEventId: 'route:message-retired-trigger:opus',
            replacement: {
              kind: 'handed',
              sourceEventId: 'route:message-successor:opus',
              sourceMessageId: 'message-successor',
              fromCatId: 'sonnet',
              toCatId: 'opus',
            },
          }
        : {
            outcome: 'live',
            sourceMessageId,
            fromCatId: 'sonnet',
            handoffSourceEventId: `route:${sourceMessageId}:${catId}`,
          },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      a2aDispatchDispositionService: { inspectHandoff },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 1);
    assert.equal(messageStore.getById(message.id).queueCustody.withdrawnByCatIds, undefined);
    assert.deepEqual(
      invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-post-settlement').messageId,
      message.id,
    );
    assert.deepEqual(
      inspectHandoff.mock.calls.map((call) => call.arguments[0].sourceMessageId),
      ['message-retired-trigger', message.id],
    );
  });

  test('keeps a coalesced carrier recoverable when only one exact A2A source was replaced', async () => {
    const messageStore = createMessageStore();
    const carrier = {
      opus: {
        entryId: 'carrier-coalesced',
        source: 'agent',
        sourceCategory: 'a2a',
        callerCatId: 'sonnet',
        a2aParentInvocationId: 'parent-source',
        a2aTriggerMessageId: 'message-coalesced-first',
        autoExecute: true,
        createdAt: 1_000,
      },
    };
    const first = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-coalesced-first',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: carrier,
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
      }),
      { id: 'message-coalesced-first', catId: 'sonnet', content: 'stale source', mentions: ['opus'] },
    );
    const second = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-coalesced-second',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: carrier,
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
        createdAt: 1_001,
        updatedAt: 1_001,
      }),
      { id: 'message-coalesced-second', catId: 'sonnet', content: 'live source', mentions: ['opus'], timestamp: 1_001 },
    );
    const inspectHandoff = mock.fn(async ({ sourceMessageId }) =>
      sourceMessageId === first.id
        ? {
            outcome: 'replaced',
            sourceMessageId,
            fromCatId: 'sonnet',
            handoffSourceEventId: 'route:message-coalesced-first:opus',
            replacement: {
              kind: 'handed',
              sourceEventId: 'route:message-successor:opus',
              sourceMessageId: 'message-successor',
              fromCatId: 'sonnet',
              toCatId: 'opus',
            },
          }
        : {
            outcome: 'live',
            sourceMessageId,
            fromCatId: 'sonnet',
            handoffSourceEventId: `route:${sourceMessageId}:opus`,
          },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      a2aDispatchDispositionService: { inspectHandoff },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 1);
    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-coalesced');
    assert.equal(restored.messageId, first.id);
    assert.deepEqual(restored.mergedMessageIds, [second.id]);
    assert.equal(restored.content, 'stale source\nlive source');
    assert.equal(messageStore.getById(first.id).deliveryStatus, 'queued');
    assert.equal(messageStore.getById(second.id).deliveryStatus, 'queued');
    assert.equal(inspectHandoff.mock.calls.length, 6);
  });

  test('terminalizes a failed exact child when its durable output names this source message', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-response-before-failure' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-response-before-failure', seenAt: 1_075 }],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const response = messageStore.append({
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'opus',
      content: 'durable response before the child failed',
      mentions: [],
      timestamp: 1_500,
      extra: {
        stream: {
          invocationId: 'parent-response-before-failure',
          turnInvocationId: 'inv-response-before-failure',
        },
        causal: { kind: 'invocation_reply', triggerMessageId: message.id },
      },
    });
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      turnExecutions: [
        turnExecution({
          invocationId: 'inv-response-before-failure',
          parentInvocationId: 'parent-response-before-failure',
          status: 'failed',
          terminalReason: 'provider_failure',
        }),
      ],
    });

    const result = await reconciler.reconcile();

    assert.equal(result.messagesTerminalized, 1);
    assert.equal(result.handledTargets, 1);
    assert.equal(result.failedTargets, 0);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1'), null);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.deepEqual(stored.queueCustody.targetOutcomeByCatId.opus, {
      invocationId: 'inv-response-before-failure',
      disposition: 'responded',
      evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-response-before-failure' },
      handledAt: 2_000,
      consumption: {
        kind: 'source_response',
        outputMessageIds: [response.id],
      },
    });
  });

  test('terminalizes a failed historical exposure when its durable output names this source message', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 3,
        status: 'queued',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: {},
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-response-after-failure', seenAt: 1_075 }],
        failedByCatIds: ['opus'],
        updatedAt: 1_600,
      }),
      {
        userId: 'scheduler',
        source: {
          connector: 'hold-ball',
          label: '持球通知',
          meta: { taskId: 'task-managed-command', threadId: 'thread-1', catId: 'opus', wakeWhen: true },
        },
      },
    );
    const response = messageStore.append({
      userId: 'default-user',
      threadId: 'thread-1',
      catId: 'opus',
      content: 'durable response persisted before failed bookkeeping cleared the active exposure',
      mentions: [],
      timestamp: 1_500,
      extra: {
        stream: {
          invocationId: 'parent-response-after-failure',
          turnInvocationId: 'inv-response-after-failure',
        },
        causal: { kind: 'invocation_reply', triggerMessageId: message.id },
      },
    });
    const invocationQueue = new InvocationQueue();
    const ballEvents = [];
    const turnCustody = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: {
        async get() {
          return { state: 'active', holder: 'opus' };
        },
      },
      ballCustodyEventLog: {
        async read(_subjectKey, fromSequence = 0) {
          return ballEvents.slice(fromSequence);
        },
      },
    });
    const ballProjection = await turnCustody.open({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'opus',
      sourceMessageId: message.id,
      taskId: 'task-managed-command',
    });
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      turnExecutions: [
        turnExecution({
          invocationId: 'inv-response-after-failure',
          parentInvocationId: 'parent-response-after-failure',
          status: 'failed',
          terminalReason: 'managed_hold_disposition_missing',
        }),
      ],
    });

    const result = await reconciler.reconcile();

    assert.equal(result.messagesTerminalized, 1);
    assert.equal(result.handledTargets, 1);
    assert.equal(result.failedTargets, 0);
    assert.deepEqual(await turnCustody.close(ballProjection), {
      state: 'covered_active',
      shouldBlock: true,
      transitionObserved: false,
      evidenceRefs: ['hold:ball:thread:thread-1'],
    });
    assert.deepEqual(ballEvents, []);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'scheduler', 'entry-restart-1'), null);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.deepEqual(stored.queueCustody.targetOutcomeByCatId.opus, {
      invocationId: 'inv-response-after-failure',
      disposition: 'responded',
      evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-response-after-failure' },
      handledAt: 2_000,
      consumption: {
        kind: 'source_response',
        outputMessageIds: [response.id],
      },
    });
  });

  test('hydrates the thread once while checking multiple retained exposure invocations', async () => {
    const messageStore = createMessageStore();
    const readThread = messageStore.getByThreadAfter.bind(messageStore);
    let threadHydrations = 0;
    messageStore.getByThreadAfter = (...args) => {
      threadHydrations += 1;
      return readThread(...args);
    };
    const message = appendQueued(
      messageStore,
      custody({
        revision: 4,
        status: 'queued',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: {},
        bodyExposures: [
          { targetCatId: 'opus', invocationId: 'inv-response-older', seenAt: 1_075 },
          { targetCatId: 'opus', invocationId: 'inv-response-newer', seenAt: 1_100 },
        ],
        failedByCatIds: ['opus'],
        updatedAt: 1_600,
      }),
    );
    messageStore.append({
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'opus',
      content: 'the older exposure has the exact durable response',
      mentions: [],
      timestamp: 1_500,
      extra: {
        stream: {
          invocationId: 'parent-response-older',
          turnInvocationId: 'inv-response-older',
        },
        causal: { kind: 'invocation_reply', triggerMessageId: message.id },
      },
    });
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    assert.equal(result.messagesTerminalized, 1);
    assert.equal(threadHydrations, 1);
  });

  test('keeps a failed historical exposure queued when output is not bound to its source message', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 3,
        status: 'queued',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: {},
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-unbound-after-failure', seenAt: 1_075 }],
        failedByCatIds: ['opus'],
        updatedAt: 1_600,
      }),
    );
    messageStore.append({
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'opus',
      content: 'same invocation, but this reply belongs to a different trigger',
      mentions: [],
      timestamp: 1_500,
      extra: {
        stream: {
          invocationId: 'parent-unbound-after-failure',
          turnInvocationId: 'inv-unbound-after-failure',
        },
        causal: { kind: 'invocation_reply', triggerMessageId: 'different-source-message' },
      },
    });
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    assert.equal(result.messagesTerminalized, 0);
    assert.equal(result.handledTargets, 0);
    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.equal(restored.status, 'queued');
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
    assert.deepEqual(stored.queueCustody.handledByCatIds, []);
  });

  test('terminalizes an awakened child that restarted before body exposure without replay', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        awakenedInvocationIdByCatId: { opus: 'inv-awakened-before-crash' },
        awakenedAtByCatId: { opus: 1_075 },
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 1);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1'), null);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.equal(stored.queueCustody.status, 'terminal');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, []);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
    assert.equal(stored.queueCustody.awakenedInvocationIdByCatId, undefined);
    assert.equal(stored.queueCustody.awakenedAtByCatId, undefined);
    assert.deepEqual(
      stored.queueCustody.targetAttempts.map(({ state, terminalReason, invocationId }) => ({
        state,
        terminalReason,
        invocationId,
      })),
      [
        {
          state: 'interrupted',
          terminalReason: 'runtime_restart',
          invocationId: 'inv-awakened-before-crash',
        },
      ],
    );
  });

  test('fails a pending Steer request closed and clears the transient steering marker', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        steerRequestedByCatIds: ['opus'],
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.deepEqual(restored.queuedFailedByCatIds, ['opus']);
    assert.deepEqual(restored.steerRequestedByCatIds, []);
    assert.deepEqual(restored.steeredInvocationIdByCatId, {});
    const stored = messageStore.getById(message.id);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
    assert.equal(stored.queueCustody.steerRequestedByCatIds, undefined);
    assert.equal(stored.queueCustody.steeredInvocationIdByCatId, undefined);
  });

  test('closes active reminder attempts honestly during restart', async () => {
    const messageStore = createMessageStore();
    const seenMessage = appendQueued(
      messageStore,
      custody({
        entryId: 'entry-reminder-seen',
        revision: 2,
        status: 'processing',
        awakenedInvocationIdByCatId: { opus: 'inv-success' },
        awakenedAtByCatId: { opus: 1_050 },
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-reminder-seen' },
        reminderAttempts: [
          {
            id: 'reminder-seen',
            targetCatId: 'opus',
            invocationId: 'inv-reminder-seen',
            state: 'delivered',
            requestedAt: 1_050,
            deliveredAt: 1_075,
          },
        ],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const missedMessage = appendQueued(
      messageStore,
      custody({
        entryId: 'entry-reminder-missed',
        revision: 2,
        reminderAttempts: [
          {
            id: 'reminder-missed',
            targetCatId: 'opus',
            invocationId: 'inv-reminder-missed',
            state: 'requested',
            requestedAt: 1_050,
          },
        ],
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      records: [
        record({
          id: 'inv-reminder-seen',
          status: 'succeeded',
          successfulCatIds: ['opus'],
        }),
      ],
    });

    await reconciler.reconcile();

    const seenAttempt = messageStore.getById(seenMessage.id).queueCustody.reminderAttempts[0];
    assert.equal(seenAttempt.state, 'seen');
    assert.equal(seenAttempt.seenAt, 2_000);
    const missedAttempt = messageStore.getById(missedMessage.id).queueCustody.reminderAttempts[0];
    assert.equal(missedAttempt.state, 'missed');
    assert.equal(missedAttempt.missedAt, 2_000);
    assert.equal(missedAttempt.missedReason, 'invocation_ended_before_delivery');
  });

  test('terminalizes only when the exact reading invocation succeeded', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-success' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-success', seenAt: 1_999 }],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      // InvocationRegistry / parent callback-auth truth may already be gone.
      // Restart recovery consumes the durable child execution ledger instead.
      turnExecutions: [turnExecution({ invocationId: 'inv-success' })],
    });

    const result = await reconciler.reconcile();

    assert.equal(result.messagesTerminalized, 1);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1'), null);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.equal(stored.queueCustody.status, 'terminal');
    assert.deepEqual(stored.queueCustody.handledByCatIds, ['opus']);
    assert.equal(stored.queueCustody.awakenedInvocationIdByCatId, undefined);
    assert.equal(stored.queueCustody.awakenedAtByCatId, undefined);
    assert.deepEqual(stored.queueCustody.bodyExposures, [
      { targetCatId: 'opus', invocationId: 'inv-success', seenAt: 1_999 },
    ]);
    assert.equal(stored.queueCustody.targetOutcomeByCatId.opus.invocationId, 'inv-success');
    assert.equal(stored.queueCustody.targetOutcomeByCatId.opus.handledAt, 2_000);
  });

  test('does not let a parent aggregate substitute for missing child truth or replay accepted work', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-exact-missing-child' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-exact-missing-child', seenAt: 1_500 }],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      records: [
        record({
          id: 'inv-exact-missing-child',
          status: 'succeeded',
          successfulCatIds: ['opus'],
        }),
      ],
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 1);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1'), null);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.equal(stored.queueCustody.status, 'terminal');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, []);
    assert.deepEqual(stored.queueCustody.handledByCatIds, []);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
    assert.deepEqual(
      stored.queueCustody.targetAttempts.map(({ state, terminalReason, invocationId }) => ({
        state,
        terminalReason,
        invocationId,
      })),
      [
        {
          state: 'interrupted',
          terminalReason: 'runtime_restart',
          invocationId: 'inv-exact-missing-child',
        },
      ],
    );
  });

  test('recovers multi-target success and failure independently', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        allTargetCats: ['opus', 'codex'],
        pendingTargetCats: ['opus', 'codex'],
        seenByCatIds: ['opus', 'codex'],
        seenInvocationIdByCatId: { opus: 'inv-opus-ok', codex: 'inv-codex-failed' },
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
      { mentions: ['opus', 'codex'] },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      records: [
        record({
          id: 'inv-opus-ok',
          status: 'succeeded',
          targetCats: ['opus'],
          successfulCatIds: ['opus'],
        }),
        record({ id: 'inv-codex-failed', status: 'failed', targetCats: ['codex'] }),
      ],
    });

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.deepEqual(restored.targetCats, ['codex']);
    assert.deepEqual(restored.queuedHandledByCatIds, ['opus']);
    assert.deepEqual(restored.queuedFailedByCatIds, ['codex']);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, ['codex']);
    assert.deepEqual(stored.queueCustody.handledByCatIds, ['opus']);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['codex']);
  });

  test('derives the shared-invocation witness before restart and leaves the canceled sibling queued', async () => {
    const terminalDispositions = new PerCatTerminalDispositionCollector({
      targetCatIds: ['opus', 'codex'],
      isCanceled: (catId) => catId === 'codex',
    });
    terminalDispositions.observe({ type: 'done', catId: 'codex' });
    terminalDispositions.observe({ type: 'done', catId: 'opus' });
    const successfulCatIds = terminalDispositions.getSuccessfulCatIds();
    assert.deepEqual(successfulCatIds, ['opus']);

    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        allTargetCats: ['opus', 'codex'],
        pendingTargetCats: ['opus', 'codex'],
        seenByCatIds: ['opus', 'codex'],
        seenInvocationIdByCatId: { opus: 'inv-shared', codex: 'inv-shared' },
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
      { mentions: ['opus', 'codex'] },
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      records: [
        record({
          id: 'inv-shared',
          status: 'succeeded',
          targetCats: ['opus', 'codex'],
          successfulCatIds,
        }),
      ],
    });

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.deepEqual(restored.targetCats, ['codex']);
    assert.deepEqual(restored.queuedHandledByCatIds, ['opus']);
    assert.deepEqual(restored.queuedFailedByCatIds, ['codex']);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, ['codex']);
    assert.deepEqual(stored.queueCustody.handledByCatIds, ['opus']);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['codex']);
  });

  test('fails closed when a persisted success witness names a cat outside the invocation scope', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-corrupt-scope' },
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      records: [
        record({
          id: 'inv-corrupt-scope',
          status: 'succeeded',
          targetCats: ['codex'],
          successfulCatIds: ['opus'],
        }),
      ],
    });

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.deepEqual(restored.targetCats, ['opus']);
    assert.deepEqual(restored.queuedHandledByCatIds, []);
    assert.deepEqual(restored.queuedFailedByCatIds, ['opus']);
    assert.equal(messageStore.getById(message.id).deliveryStatus, 'queued');
  });

  test('backfills a legacy queued message into durable custody instead of marking it delivered', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(messageStore, null);
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    assert.equal(result.messagesBackfilled, 1);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.equal(stored.queueCustody.entryId, `legacy:${message.id}`);
    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', stored.queueCustody.entryId);
    assert.equal(restored.messageId, message.id);
  });

  test('does not reinterpret a legacy agent handoff as ordinary queued-user custody', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(messageStore, null, { catId: 'opus', mentions: ['codex'] });
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({ messageStore, invocationQueue });

    const result = await reconciler.reconcile();

    assert.deepEqual(result.legacyVisibilityFallbackMessageIds, [message.id]);
    assert.equal(messageStore.getById(message.id).queueCustody, undefined);
    assert.equal(invocationQueue.list('thread-1', 'user-1').length, 0);
  });

  test('StartupReconciler recovers legacy agent handoffs without claiming active requests were interrupted', async () => {
    const messageStore = createMessageStore();
    const reviewRequest = appendQueued(messageStore, null, { catId: 'codex-sol', mentions: ['opus'] });
    const reviewVerdict = appendQueued(messageStore, null, {
      catId: 'opus',
      mentions: ['codex-sol'],
      timestamp: 1_001,
    });
    const invocationQueue = new InvocationQueue();
    const invocationRecordStore = {
      async scanByStatus() {
        return [];
      },
      async get() {
        return null;
      },
    };
    const reconciler = new StartupReconciler({
      invocationRecordStore,
      invocationQueue,
      messageStore,
      taskProgressStore: { async deleteSnapshot() {} },
      log: { info() {}, warn() {} },
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.messagesRecovered, 2);
    assert.equal(result.running, 0);
    assert.equal(result.queued, 0);
    assert.equal(result.notifiedThreads, 0);
    assert.equal(messageStore.getById(reviewRequest.id).deliveryStatus, 'delivered');
    assert.equal(messageStore.getById(reviewVerdict.id).deliveryStatus, 'delivered');
    assert.equal(
      messageStore.getRecent(20).some((message) => message.source?.connector === 'startup-reconciler'),
      false,
    );
  });

  test('StartupReconciler restores then naturally resumes each new durable scope once', async () => {
    const messageStore = createMessageStore();
    appendQueued(messageStore);
    const invocationQueue = new InvocationQueue();
    const resumed = [];
    const invocationRecordStore = {
      async scanByStatus() {
        return [];
      },
      async get() {
        return null;
      },
    };
    const reconciler = new StartupReconciler({
      invocationRecordStore,
      invocationQueue,
      messageStore,
      taskProgressStore: { async deleteSnapshot() {} },
      log: { info() {}, warn() {} },
      async resumeQueue(threadId, userId) {
        resumed.push({ threadId, userId });
      },
    });

    const first = await reconciler.reconcileOrphans();
    const second = await reconciler.reconcileOrphans();

    assert.equal(first.queueEntriesRestored, 1);
    assert.equal(first.queueEntriesResumed, 1);
    assert.equal(second.queueEntriesRestored, 0);
    assert.equal(second.queueEntriesResumed, 0);
    assert.deepEqual(resumed, [{ threadId: 'thread-1', userId: 'user-1' }]);
  });

  test('StartupReconciler does not resume a replacement-fenced old A2A prompt', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        entryId: 'cross-thread:message-no-old-prompt',
        receiptScope: 'cross_thread_delivery',
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-no-old-prompt',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: 'message-no-old-prompt',
            autoExecute: true,
            createdAt: 1_000,
          },
        },
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
      }),
      { id: 'message-no-old-prompt', catId: 'sonnet', mentions: ['opus'] },
    );
    const invocationQueue = new InvocationQueue();
    const resumeQueue = mock.fn(async () => {});
    const inspectHandoff = mock.fn(async () => ({
      outcome: 'replaced',
      sourceMessageId: message.id,
      fromCatId: 'sonnet',
      handoffSourceEventId: 'route:message-no-old-prompt:opus',
      replacement: {
        kind: 'handed',
        sourceEventId: 'route:message-successor:opus',
        sourceMessageId: 'message-successor',
        fromCatId: 'sonnet',
        toCatId: 'opus',
      },
    }));
    const reconciler = new StartupReconciler({
      invocationRecordStore: {
        async scanByStatus() {
          return [];
        },
        async get() {
          return null;
        },
      },
      invocationQueue,
      messageStore,
      a2aDispatchDispositionService: { inspectHandoff },
      taskProgressStore: { async deleteSnapshot() {} },
      log: { info() {}, warn() {} },
      resumeQueue,
    });

    const result = await reconciler.reconcileOrphans();

    assert.equal(result.queueEntriesRestored, 0);
    assert.equal(result.queueEntriesResumed, 0);
    assert.equal(resumeQueue.mock.calls.length, 0);
    assert.equal(invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'carrier-no-old-prompt'), null);
    assert.equal(messageStore.getById(message.id).deliveryStatus, 'delivered');
    assert.deepEqual(messageStore.getById(message.id).queueCustody.withdrawnByCatIds, ['opus']);
  });
});
