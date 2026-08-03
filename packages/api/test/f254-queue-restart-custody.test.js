import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { PerCatTerminalDispositionCollector } from '../dist/domains/cats/services/agents/invocation/PerCatTerminalDispositionCollector.js';
import { QueuedMessageCustodyStartupReconciler } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js';
import { StartupReconciler } from '../dist/domains/cats/services/agents/invocation/StartupReconciler.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { parseQueuedMessageCustody } from '../dist/domains/cats/services/stores/ports/queued-message-custody.js';

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

function createReconciler({ messageStore, invocationQueue, records = [], turnExecutions = [] }) {
  return new QueuedMessageCustodyStartupReconciler({
    messageStore,
    invocationQueue,
    invocationRecordStore: createRecordStore(records),
    turnExecutionStore: createTurnExecutionStore(turnExecutions),
    now: () => 2_000,
    log: { info() {}, warn() {} },
  });
}

describe('F254 Queue restart custody', () => {
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

  test('requeues a seen target whose exact invocation failed during restart', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(
      messageStore,
      custody({
        revision: 2,
        status: 'processing',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-failed' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-failed', seenAt: 1_075 }],
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    );
    const invocationQueue = new InvocationQueue();
    const reconciler = createReconciler({
      messageStore,
      invocationQueue,
      records: [record({ id: 'inv-failed', status: 'failed' })],
    });

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.equal(restored.status, 'queued');
    assert.deepEqual(restored.queuedFailedByCatIds, ['opus']);
    assert.deepEqual(restored.queuedSeenInvocationIdByCatId, {});
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.equal(stored.queueCustody.status, 'queued');
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
    assert.deepEqual(stored.queueCustody.seenInvocationIdByCatId, {});
    assert.deepEqual(stored.queueCustody.bodyExposures, [
      { targetCatId: 'opus', invocationId: 'inv-failed', seenAt: 1_075 },
    ]);
    assert.deepEqual(restored.queuedBodyExposures, [
      { targetCatId: 'opus', invocationId: 'inv-failed', seenAt: 1_075 },
    ]);
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

  test('requeues an awakened child that restarted before body exposure as exact unsettled work', async () => {
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

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.equal(restored.status, 'queued');
    assert.deepEqual(restored.queuedFailedByCatIds, ['opus']);
    assert.deepEqual(restored.queuedAwakenedInvocationIdByCatId, { opus: 'inv-awakened-before-crash' });
    assert.deepEqual(restored.queuedAwakenedAtByCatId, { opus: 1_075 });
    assert.equal(restored.queuedSeenByCatIds.length, 0);
    const stored = messageStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
    assert.deepEqual(stored.queueCustody.awakenedInvocationIdByCatId, {
      opus: 'inv-awakened-before-crash',
    });
    assert.deepEqual(stored.queueCustody.awakenedAtByCatId, { opus: 1_075 });
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

  test('does not let a parent aggregate substitute for missing child truth after exact exposure', async () => {
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

    await reconciler.reconcile();

    const restored = invocationQueue.getEntrySnapshot('thread-1', 'user-1', 'entry-restart-1');
    assert.deepEqual(restored.targetCats, ['opus']);
    assert.deepEqual(restored.queuedHandledByCatIds, []);
    assert.deepEqual(restored.queuedFailedByCatIds, ['opus']);
    assert.equal(messageStore.getById(message.id).deliveryStatus, 'queued');
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

  test('StartupReconciler keeps legacy agent-handoff visibility recovery outside user custody', async () => {
    const messageStore = createMessageStore();
    const message = appendQueued(messageStore, null, { catId: 'opus', mentions: ['codex'] });
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

    assert.equal(result.messagesRecovered, 1);
    assert.equal(messageStore.getById(message.id).deliveryStatus, 'delivered');
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
});
