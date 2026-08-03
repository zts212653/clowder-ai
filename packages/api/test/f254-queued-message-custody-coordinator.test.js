import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialCrossThreadQueuedMessageCustody,
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

function enqueueUser(queue, targetCats = ['opus', 'codex'], ownerAuthProvenance = 'unknown') {
  const result = queue.enqueue({
    threadId: 'thread-1',
    userId: 'user-1',
    content: 'durable work',
    source: 'user',
    targetCats,
    intent: 'implement',
    priority: 'normal',
    ownerAuthProvenance,
  });
  assert.equal(result.outcome, 'enqueued');
  assert.ok(result.entry);
  return result.entry;
}

function appendCustodiedMessage(store, queue, entry) {
  const message = store.append({
    threadId: entry.threadId,
    userId: entry.userId,
    catId: null,
    content: entry.content,
    mentions: entry.targetCats,
    timestamp: entry.createdAt,
    deliveryStatus: 'queued',
    queueCustody: createInitialQueuedMessageCustody(entry),
  });
  queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);
  return message;
}

describe('F254 queued message custody coordinator', () => {
  test('updates one cross-thread target carrier without overwriting its sibling', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const message = store.append({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'fable5',
      content: 'coordinate independently',
      mentions: ['opus', 'codex'],
      timestamp: 100,
      deliveryStatus: 'queued',
      extra: { crossPost: { sourceThreadId: 'thread-source' } },
    });
    const entries = ['opus', 'codex'].map((catId) => {
      const result = queue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content: message.content,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'fable5',
        a2aParentInvocationId: 'parent-1',
        a2aTriggerMessageId: message.id,
      });
      assert.equal(result.outcome, 'enqueued');
      queue.backfillMessageId('thread-1', 'user-1', result.entry.id, message.id);
      return queue.getEntrySnapshot('thread-1', 'user-1', result.entry.id);
    });
    const initialized = store.initializeQueueCustody(
      message.id,
      createInitialCrossThreadQueuedMessageCustody(message.id, entries),
    );
    assert.equal(initialized.kind, 'initialized');

    const opusEntry = entries.find((entry) => entry.targetCats[0] === 'opus');
    const seenAt = Math.max(...entries.map((entry) => entry.createdAt)) + 50;
    assert.equal(queue.markProcessingById('thread-1', opusEntry.id), true);
    assert.equal(queue.markQueuedAwakened('thread-1', 'user-1', opusEntry.id, 'opus', 'child-opus', seenAt - 10), true);
    queue.markProcessingSeen('thread-1', 'user-1', opusEntry.id, ['opus'], 'child-opus', seenAt);
    const processingOpus = queue.getEntrySnapshot('thread-1', 'user-1', opusEntry.id);
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => seenAt + 50 });
    await coordinator.persistEntry(processingOpus);

    const custody = store.getById(message.id).queueCustody;
    assert.deepEqual(custody.pendingTargetCats, ['opus', 'codex']);
    assert.deepEqual(custody.awakenedInvocationIdByCatId, { opus: 'child-opus' });
    assert.deepEqual(custody.awakenedAtByCatId, { opus: seenAt - 10 });
    assert.deepEqual(custody.seenByCatIds, ['opus']);
    assert.deepEqual(custody.seenInvocationIdByCatId, { opus: 'child-opus' });
    assert.deepEqual(custody.bodyExposures, [{ targetCatId: 'opus', invocationId: 'child-opus', seenAt }]);
    assert.equal(custody.carrierByTargetCatId.opus.entryId, opusEntry.id);
    assert.equal(
      custody.carrierByTargetCatId.codex.entryId,
      entries.find((entry) => entry.targetCats[0] === 'codex').id,
    );
  });

  test('builds initial custody from the exact live Queue identity', () => {
    const queue = new InvocationQueue();
    const entry = enqueueUser(queue, ['opus', 'codex'], 'strict');

    assert.deepEqual(createInitialQueuedMessageCustody(entry), {
      version: 1,
      entryId: entry.id,
      revision: 1,
      intent: 'implement',
      ownerAuthProvenance: 'strict',
      status: 'queued',
      allTargetCats: ['opus', 'codex'],
      pendingTargetCats: ['opus', 'codex'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
    });
  });

  test('persists a promoted entry whose queue position is negative', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    enqueueUser(queue, ['opus']);
    const entry = enqueueUser(queue, ['opus']);
    const message = appendCustodiedMessage(store, queue, entry);

    assert.equal(queue.promote(entry.threadId, entry.userId, entry.id), true);
    const promoted = queue.list(entry.threadId, entry.userId).find((candidate) => candidate.id === entry.id);
    assert.ok(promoted);
    assert.equal(promoted.position, -1, 'InvocationQueue uses a negative position to sort promoted work first');

    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: store,
      now: () => entry.createdAt + 1_000,
    });
    await coordinator.persistEntry(promoted);

    assert.equal(store.getById(message.id)?.queueCustody?.position, -1);
  });

  test('persists exact processing/read evidence before the caller continues', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue);
    const message = appendCustodiedMessage(store, queue, entry);
    assert.equal(queue.markProcessingById(entry.threadId, entry.id), true);
    const seenAt = entry.createdAt + 500;
    assert.deepEqual(queue.markProcessingSeen(entry.threadId, entry.userId, entry.id, ['opus'], 'inv-1', seenAt), [
      'opus',
    ]);
    const processing = queue.list(entry.threadId, entry.userId).find((candidate) => candidate.id === entry.id);
    assert.ok(processing);

    const persistedAt = entry.createdAt + 1_000;
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => persistedAt });
    await coordinator.persistEntry(processing);

    assert.deepEqual(store.getById(message.id)?.queueCustody, {
      ...createInitialQueuedMessageCustody(entry),
      revision: 2,
      status: 'processing',
      seenByCatIds: ['opus'],
      seenInvocationIdByCatId: { opus: 'inv-1' },
      bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-1', seenAt }],
      processingStartedAt: processing.processingStartedAt,
      updatedAt: persistedAt,
    });
  });

  test('serializes concurrent projections so an older notified snapshot cannot overwrite seen', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue, ['opus']);
    const message = appendCustodiedMessage(store, queue, entry);
    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: store,
      now: () => entry.createdAt + 1_000,
    });

    assert.equal(queue.markQueuedNotified(entry.threadId, entry.userId, entry.id, 'opus'), true);
    const notified = structuredClone(queue.list(entry.threadId, entry.userId)[0]);
    assert.equal(queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'inv-seen'), true);
    const seen = queue.list(entry.threadId, entry.userId)[0];

    await Promise.all([coordinator.persistEntry(notified), coordinator.persistEntry(seen)]);

    const custody = store.getById(message.id)?.queueCustody;
    assert.equal(custody?.revision, 3);
    assert.deepEqual(custody?.notifiedByCatIds, []);
    assert.deepEqual(custody?.seenByCatIds, ['opus']);
    assert.deepEqual(custody?.seenInvocationIdByCatId, { opus: 'inv-seen' });
  });

  test('handles only targets proven by the same successful invocation and delivers after the last one', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue);
    const message = appendCustodiedMessage(store, queue, entry);
    let now = entry.createdAt + 1_000;
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => now });

    queue.markProcessingById(entry.threadId, entry.id);
    queue.markProcessingSeen(entry.threadId, entry.userId, entry.id, ['opus', 'codex'], 'inv-shared');
    const processing = queue.list(entry.threadId, entry.userId)[0];
    await coordinator.persistEntry(processing);

    now += 100;
    const first = await coordinator.commitSuccessfulTargets(processing, ['opus'], 'inv-shared', now);
    assert.deepEqual(first, {
      perMessage: [
        {
          messageId: message.id,
          handledTargetCats: ['opus'],
          pendingTargetCats: ['codex'],
          fullyConsumed: false,
        },
      ],
    });
    assert.equal(store.getById(message.id)?.deliveryStatus, 'queued');

    now += 50;
    const wrong = await coordinator.commitSuccessfulTargets(processing, ['codex'], 'inv-wrong', now);
    assert.deepEqual(wrong, {
      perMessage: [
        { messageId: message.id, handledTargetCats: [], pendingTargetCats: ['codex'], fullyConsumed: false },
      ],
    });

    now += 50;
    const second = await coordinator.commitSuccessfulTargets(processing, ['codex'], 'inv-shared', now);
    assert.deepEqual(second, {
      perMessage: [{ messageId: message.id, handledTargetCats: ['codex'], pendingTargetCats: [], fullyConsumed: true }],
    });
    const stored = store.getById(message.id);
    assert.equal(stored?.deliveryStatus, 'delivered');
    assert.equal(stored?.deliveredAt, now);
    assert.equal(stored?.queueCustody?.status, 'terminal');
    assert.deepEqual(stored?.queueCustody?.handledByCatIds, ['opus', 'codex']);
  });

  test('settles coalesced cross-thread messages per message when their global target projections diverge', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'first handoff',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'sonnet',
      a2aParentInvocationId: 'parent-source',
      a2aTriggerMessageId: 'message-first',
    }).entry;
    const binding = {
      entryId: entry.id,
      source: 'agent',
      sourceCategory: 'a2a',
      callerCatId: 'sonnet',
      a2aParentInvocationId: 'parent-source',
      a2aTriggerMessageId: 'message-first',
      autoExecute: true,
      createdAt: entry.createdAt,
    };
    const codexBinding = { ...binding, entryId: 'carrier-codex', createdAt: entry.createdAt + 1 };
    const common = {
      version: 1,
      revision: 2,
      receiptScope: 'cross_thread_delivery',
      intent: 'execute',
      status: 'processing',
      notifiedByCatIds: [],
      awakenedInvocationIdByCatId: { opus: 'child-opus' },
      awakenedAtByCatId: { opus: entry.createdAt + 10 },
      seenByCatIds: ['opus'],
      seenInvocationIdByCatId: { opus: 'child-opus' },
      bodyExposures: [{ targetCatId: 'opus', invocationId: 'child-opus', seenAt: entry.createdAt + 20 }],
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt + 20,
    };
    const first = store.append({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'sonnet',
      content: 'first handoff',
      mentions: ['opus', 'codex'],
      timestamp: entry.createdAt,
      deliveryStatus: 'queued',
      queueCustody: {
        ...common,
        entryId: 'cross-thread:message-first',
        allTargetCats: ['opus', 'codex'],
        pendingTargetCats: ['opus', 'codex'],
        carrierByTargetCatId: { opus: binding, codex: codexBinding },
        carrierStateByTargetCatId: { opus: { status: 'processing' }, codex: { status: 'queued' } },
      },
    });
    const second = store.append({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'sonnet',
      content: 'second handoff',
      mentions: ['opus'],
      timestamp: entry.createdAt + 1,
      deliveryStatus: 'queued',
      queueCustody: {
        ...common,
        entryId: 'cross-thread:message-second',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        carrierByTargetCatId: { opus: binding },
        carrierStateByTargetCatId: { opus: { status: 'processing' } },
      },
    });
    queue.backfillMessageId('thread-1', 'user-1', entry.id, first.id);
    assert.equal(
      queue.coalesceContentIntoQueuedAgent(
        'thread-1',
        'user-1',
        entry.id,
        second.content,
        second.id,
        'sonnet',
        'parent-source',
      ),
      true,
    );
    const coalesced = queue.getEntrySnapshot('thread-1', 'user-1', entry.id);
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store });

    const settlement = await coordinator.commitSuccessfulTargets(
      coalesced,
      ['opus'],
      'child-opus',
      entry.createdAt + 100,
    );

    assert.deepEqual(settlement.perMessage, [
      {
        messageId: first.id,
        handledTargetCats: ['opus'],
        pendingTargetCats: ['codex'],
        fullyConsumed: false,
      },
      {
        messageId: second.id,
        handledTargetCats: ['opus'],
        pendingTargetCats: [],
        fullyConsumed: true,
      },
    ]);
    assert.equal(store.getById(first.id).deliveryStatus, 'queued');
    assert.deepEqual(store.getById(first.id).queueCustody.pendingTargetCats, ['codex']);
    assert.equal(store.getById(second.id).deliveryStatus, 'delivered');
    assert.equal(store.getById(second.id).queueCustody.status, 'terminal');
  });

  test('normalizes same-millisecond success so handledAt strictly follows exact seenAt', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue, ['opus']);
    const message = appendCustodiedMessage(store, queue, entry);
    const boundaryAt = entry.createdAt + 1_000;
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => boundaryAt });

    queue.markProcessingById(entry.threadId, entry.id);
    queue.markProcessingSeen(entry.threadId, entry.userId, entry.id, ['opus'], 'inv-same-ms', boundaryAt);
    const processing = queue.list(entry.threadId, entry.userId)[0];
    await coordinator.persistEntry(processing);

    await coordinator.commitSuccessfulTargets(processing, ['opus'], 'inv-same-ms', boundaryAt);

    const outcome = store.getById(message.id)?.queueCustody?.targetOutcomeByCatId?.opus;
    assert.equal(outcome?.handledAt, boundaryAt + 1);
  });
});
