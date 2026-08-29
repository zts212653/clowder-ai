import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialCrossThreadQueuedMessageCustody,
  createInitialFanoutQueuedMessageCustody,
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const allowRetry = (store) => async (transitions) => {
  for (const transition of transitions) {
    const result = store.transitionQueueCustody(transition.messageId, {
      expectedRevision: transition.current.revision,
      next: transition.next,
    });
    assert.equal(result.kind, 'updated');
  }
  return { outcome: 'committed' };
};

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
  test('PR7 refuses to persist an action fence under a different Queue idempotency identity', () => {
    const queue = new InvocationQueue();
    const entry = queue.enqueue({
      idempotencyKey: 'queue-custody:wrong-action-source:codex',
      ownerAuthProvenance: 'strict',
      threadId: 'thread-action-identity',
      userId: 'user-1',
      content: 'fenced action',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      a2aTriggerMessageId: 'message-action-identity',
      actionSuccessorFence: {
        leaseId: 'lease-action-identity',
        generation: 3,
        dispatchId: 'cross-post:action-identity',
      },
    }).entry;

    assert.throws(
      () => createInitialFanoutQueuedMessageCustody('message-action-identity', [entry]),
      /action-successor Queue carrier has mismatched idempotency/,
    );
  });

  test('PR7 converges a fan-out sibling after more than three custody CAS conflicts', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entries = ['opus', 'codex'].map((catId) => {
      const result = queue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-fanout',
        userId: 'user-1',
        content: 'same-thread fan-out',
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'codex-sol',
        a2aParentInvocationId: 'parent-fanout',
        a2aTriggerMessageId: 'message-fanout',
      });
      assert.equal(result.outcome, 'enqueued');
      return result.entry;
    });
    const message = store.append({
      id: 'message-fanout',
      threadId: 'thread-fanout',
      userId: 'user-1',
      catId: 'codex-sol',
      content: 'same-thread fan-out',
      mentions: ['opus', 'codex'],
      timestamp: 100,
      deliveryStatus: 'queued',
      queueCustody: createInitialFanoutQueuedMessageCustody('message-fanout', entries, {
        requestedTargetCats: ['opus', 'codex'],
        createdAt: 100,
      }),
    });
    for (const entry of entries) {
      queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);
    }
    assert.equal(queue.markProcessingById('thread-fanout', entries[0].id, 'opus'), true);
    const processing = queue.getEntrySnapshot('thread-fanout', 'user-1', entries[0].id);
    let transitionCalls = 0;
    const contendedStore = {
      getById: (messageId) => store.getById(messageId),
      transitionQueueCustody(messageId, input) {
        transitionCalls += 1;
        if (transitionCalls <= 3) {
          return { kind: 'revision_mismatch', actualRevision: input.expectedRevision };
        }
        return store.transitionQueueCustody(messageId, input);
      },
    };
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: contendedStore });

    assert.deepEqual(await coordinator.persistEntry(processing), [message.id]);
    assert.equal(transitionCalls, 4, 'the fourth linearization attempt must remain reachable');
    assert.deepEqual(store.getById(message.id).queueCustody.carrierStateByTargetCatId, {
      opus: { status: 'processing', processingStartedAt: processing.processingStartedAt },
      codex: { status: 'queued' },
    });
  });

  test('replay fence treats terminal truth in any coalesced source as a no-reentry boundary', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue, ['opus']);
    const appendSource = (content) =>
      store.append({
        threadId: entry.threadId,
        userId: entry.userId,
        catId: 'codex-sol',
        content,
        mentions: ['opus'],
        timestamp: entry.createdAt,
        deliveryStatus: 'queued',
        queueCustody: createInitialQueuedMessageCustody(entry),
      });
    const first = appendSource('first source');
    const second = appendSource('second source');
    const secondCustody = store.getById(second.id).queueCustody;
    const partiallyCommittedMessages = new Map([
      [first.id, store.getById(first.id)],
      [
        second.id,
        {
          ...store.getById(second.id),
          deliveryStatus: 'delivered',
          queueCustody: {
            ...secondCustody,
            revision: secondCustody.revision + 1,
            status: 'terminal',
            pendingTargetCats: [],
            handledByCatIds: ['opus'],
            seenByCatIds: ['opus'],
            seenInvocationIdByCatId: { opus: 'turn-already-finished' },
            bodyExposures: [
              {
                targetCatId: 'opus',
                invocationId: 'turn-already-finished',
                seenAt: entry.createdAt + 50,
              },
            ],
            targetOutcomeByCatId: {
              opus: {
                invocationId: 'turn-already-finished',
                disposition: 'responded',
                handledAt: entry.createdAt + 100,
                evidenceRef: { kind: 'invocation_lineage', invocationId: 'turn-already-finished' },
              },
            },
          },
        },
      ],
    ]);
    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: { getById: async (messageId) => partiallyCommittedMessages.get(messageId) ?? null },
    });

    const result = await coordinator.inspectTargetReplayFence({
      entry: { ...entry, messageId: first.id, mergedMessageIds: [second.id] },
      targetCatId: 'opus',
    });

    assert.deepEqual(result, {
      disposition: 'terminalized',
      invocationId: 'turn-already-finished',
      sourceMessageIds: [first.id, second.id],
    });
  });

  test('replay fence defers missing or legacy custody to the canonical attempt classifier', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue, ['opus']);
    const source = store.append({
      threadId: entry.threadId,
      userId: entry.userId,
      catId: 'codex-sol',
      content: 'unverified source',
      mentions: ['opus'],
      timestamp: entry.createdAt,
      deliveryStatus: 'queued',
    });
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store });

    assert.deepEqual(
      await coordinator.inspectTargetReplayFence({
        entry: { ...entry, messageId: source.id, mergedMessageIds: [] },
        targetCatId: 'opus',
      }),
      { disposition: 'dispatchable', sourceMessageIds: [source.id] },
    );
  });

  test('replay fence still fails closed when source truth cannot be read', async () => {
    const queue = new InvocationQueue();
    const entry = enqueueUser(queue, ['opus']);
    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: {
        getById: async () => {
          throw new Error('message store unavailable');
        },
      },
    });

    await assert.rejects(
      coordinator.inspectTargetReplayFence({
        entry: { ...entry, messageId: 'message-unavailable', mergedMessageIds: [] },
        targetCatId: 'opus',
      }),
      /message store unavailable/,
    );
  });

  test('carrier retirement fence refuses a partially canceled source group without withdrawing live siblings', async () => {
    const queue = new InvocationQueue();
    const entry = enqueueUser(queue, ['opus']);
    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: {
        getById: async (messageId) =>
          messageId === 'message-retired'
            ? { id: messageId, deliveryStatus: 'canceled' }
            : { id: messageId, deliveryStatus: 'queued' },
      },
    });

    await assert.rejects(
      coordinator.inspectCarrierRetirementFence({
        entries: [{ ...entry, messageId: 'message-retired', mergedMessageIds: ['message-live'] }],
      }),
      /partially terminalized/,
    );
  });

  test('replay fence terminalizes an entry superseded by another exact target carrier', async () => {
    const queue = new InvocationQueue();
    const entry = enqueueUser(queue, ['opus']);
    const custody = createInitialQueuedMessageCustody(entry);
    const source = {
      id: 'message-superseded-carrier',
      threadId: entry.threadId,
      userId: entry.userId,
      catId: 'codex-sol',
      content: 'superseded carrier',
      mentions: ['opus'],
      timestamp: entry.createdAt,
      deliveryStatus: 'queued',
      queueCustody: {
        ...custody,
        carrierByTargetCatId: {
          opus: { entryId: 'replacement-entry' },
        },
      },
    };
    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: { getById: async (messageId) => (messageId === source.id ? source : null) },
    });

    assert.deepEqual(
      await coordinator.inspectTargetReplayFence({
        entry: { ...entry, messageId: source.id, mergedMessageIds: [] },
        targetCatId: 'opus',
      }),
      { disposition: 'terminalized', sourceMessageIds: [source.id] },
    );
  });

  test('replay fence rejects a mismatched entry when the exact target carrier is missing', async () => {
    const queue = new InvocationQueue();
    const entry = enqueueUser(queue, ['opus']);
    const source = {
      id: 'message-mismatched-carrier',
      threadId: entry.threadId,
      userId: entry.userId,
      catId: 'codex-sol',
      content: 'mismatched carrier',
      mentions: ['opus'],
      timestamp: entry.createdAt,
      deliveryStatus: 'queued',
      queueCustody: {
        ...createInitialQueuedMessageCustody(entry),
        entryId: 'replacement-entry',
      },
    };
    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: { getById: async (messageId) => (messageId === source.id ? source : null) },
    });

    await assert.rejects(
      coordinator.inspectTargetReplayFence({
        entry: { ...entry, messageId: source.id, mergedMessageIds: [] },
        targetCatId: 'opus',
      }),
      /entry mismatch/,
    );
  });

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

  test('retires only the durable Queue target bound to the exact completed action fence', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const message = store.append({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'fable5',
      content: 'review exact HEAD',
      mentions: ['codex-sol'],
      timestamp: 100,
      deliveryStatus: 'queued',
      extra: { crossPost: { sourceThreadId: 'thread-source' } },
    });
    const exactFence = {
      leaseId: 'lease-head-a',
      generation: 4,
      dispatchId: 'dispatch-head-a',
      terminalPredicateDigest: 'digest-head-a',
      invocationLineageRef: 'dispatch:dispatch-head-a',
    };
    const entries = [['codex-sol', exactFence]].map(([catId, actionSuccessorFence]) => {
      const result = queue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content: message.content,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'review',
        autoExecute: true,
        callerCatId: 'fable5',
        a2aParentInvocationId: 'parent-1',
        a2aTriggerMessageId: message.id,
        idempotencyKey: `action:${actionSuccessorFence.leaseId}:${actionSuccessorFence.generation}:${catId}`,
        actionSuccessorFence,
      });
      assert.equal(result.outcome, 'enqueued');
      queue.backfillMessageId('thread-1', 'user-1', result.entry.id, message.id);
      return queue.getEntrySnapshot('thread-1', 'user-1', result.entry.id);
    });
    assert.equal(
      store.initializeQueueCustody(message.id, createInitialCrossThreadQueuedMessageCustody(message.id, entries)).kind,
      'initialized',
    );
    const retiredAt = entries[0].createdAt + 100;
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => retiredAt });

    const mismatch = await coordinator.retireActionSuccessorFence(message.id, {
      ...exactFence,
      leaseId: 'lease-head-b',
    });
    assert.equal(mismatch, null);
    assert.deepEqual(store.getById(message.id).queueCustody.pendingTargetCats, ['codex-sol']);
    const first = await coordinator.retireActionSuccessorFence(message.id, exactFence);
    const replay = await coordinator.retireActionSuccessorFence(message.id, exactFence);
    const custody = store.getById(message.id).queueCustody;

    assert.equal(first.changed, true);
    assert.equal(replay.changed, false);
    assert.deepEqual(custody.pendingTargetCats, []);
    assert.deepEqual(custody.withdrawnByCatIds, ['codex-sol']);
    assert.equal(custody.carrierByTargetCatId['codex-sol'].actionSuccessorFence.leaseId, 'lease-head-a');
    assert.deepEqual(custody.actionSuccessorTerminalFenceByTargetCatId['codex-sol'], exactFence);
  });

  test('builds initial custody from the exact live Queue identity', () => {
    const queue = new InvocationQueue();
    const entry = enqueueUser(queue, ['opus', 'codex'], 'strict');

    assert.deepEqual(createInitialQueuedMessageCustody(entry), {
      version: 1,
      entryId: entry.id,
      revision: 1,
      ownerUserId: 'user-1',
      intent: 'implement',
      ownerAuthProvenance: 'strict',
      status: 'queued',
      allTargetCats: ['opus', 'codex'],
      pendingTargetCats: ['opus', 'codex'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      targetAttempts: [
        {
          id: `${entry.id}:opus:1`,
          targetCatId: 'opus',
          sequence: 1,
          state: 'queued',
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
        },
        {
          id: `${entry.id}:codex:1`,
          targetCatId: 'codex',
          sequence: 1,
          state: 'queued',
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
        },
      ],
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
    });
  });

  test('appends one retry attempt without cloning the authored message or accepting a double click', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue, ['opus']);
    const message = appendCustodiedMessage(store, queue, entry);
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => entry.createdAt + 500 });

    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'child-failed', entry.createdAt + 10);
    queue.markQueuedFailedForCatAcrossUsers(
      entry.threadId,
      'opus',
      'child-failed',
      new Set([entry.id]),
      'invocation_failed',
      entry.createdAt + 20,
    );
    await coordinator.persistEntry(queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id));
    const failedAttempt = store.getById(message.id).queueCustody.targetAttempts[0];
    assert.equal(failedAttempt.state, 'failed');

    const failedEntry = queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
    const retried = await coordinator.retryFailedTarget(failedEntry, 'opus', failedAttempt.id, allowRetry(store));
    assert.equal(retried.outcome, 'retried');
    assert.equal(retried.attempt.id, `${entry.id}:opus:2`);
    const retry = queue.retryFailedTarget(entry.threadId, entry.userId, entry.id, 'opus');
    assert.ok(retry);
    assert.equal(
      queue.retryFailedTarget(entry.threadId, entry.userId, entry.id, 'opus'),
      null,
      'second click cannot reopen it',
    );
    assert.deepEqual(await coordinator.retryFailedTarget(retry.after, 'opus', failedAttempt.id, allowRetry(store)), {
      outcome: 'not_retryable',
    });

    const custody = store.getById(message.id).queueCustody;
    assert.equal(store.getById(message.id).content, 'durable work');
    assert.deepEqual(
      custody.targetAttempts.map((attempt) => ({ id: attempt.id, state: attempt.state })),
      [
        { id: `${entry.id}:opus:1`, state: 'failed' },
        { id: `${entry.id}:opus:2`, state: 'queued' },
      ],
    );
  });

  test('retries an invocation-cancelled attempt but preserves author withdrawal as terminal', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue, ['opus']);
    const message = appendCustodiedMessage(store, queue, entry);
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => entry.createdAt + 500 });

    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'child-stopped', entry.createdAt + 10);
    queue.markQueuedFailedForCatAcrossUsers(
      entry.threadId,
      'opus',
      'child-stopped',
      new Set([entry.id]),
      'invocation_cancelled',
      entry.createdAt + 20,
    );
    await coordinator.persistEntry(queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id));
    const stoppedAttempt = store.getById(message.id).queueCustody.targetAttempts[0];
    assert.deepEqual(
      { state: stoppedAttempt.state, terminalReason: stoppedAttempt.terminalReason },
      { state: 'cancelled', terminalReason: 'invocation_cancelled' },
    );

    const stoppedEntry = queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
    const retried = await coordinator.retryFailedTarget(stoppedEntry, 'opus', stoppedAttempt.id, allowRetry(store));
    assert.equal(retried.outcome, 'retried');
    assert.equal(retried.attempt.sequence, 2);
    assert.ok(
      queue.retryFailedTarget(entry.threadId, entry.userId, entry.id, 'opus'),
      'a stopped invocation still leaves its carrier retryable',
    );

    const withdrawnEntry = enqueueUser(queue, ['opus', 'codex']);
    const withdrawnMessage = appendCustodiedMessage(store, queue, withdrawnEntry);
    const withdrawnCarrier = queue.getEntrySnapshot(withdrawnEntry.threadId, withdrawnEntry.userId, withdrawnEntry.id);
    await coordinator.persistEntry(withdrawnCarrier);
    await coordinator.withdrawEntry({ ...withdrawnCarrier, targetCats: ['codex'] });
    const withdrawnAttempt = store
      .getById(withdrawnMessage.id)
      .queueCustody.targetAttempts.find((attempt) => attempt.targetCatId === 'codex');
    assert.ok(withdrawnAttempt);
    assert.equal(withdrawnAttempt.terminalReason, 'source_withdrawn');
    assert.deepEqual(
      await coordinator.retryFailedTarget(withdrawnCarrier, 'codex', withdrawnAttempt.id, allowRetry(store)),
      { outcome: 'not_retryable' },
      'an author withdrawal must never be reopened by retry',
    );
  });

  test('records a later provider exposure as a new attempt and settles that exact turn', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue, ['opus']);
    const message = appendCustodiedMessage(store, queue, entry);
    let now = entry.createdAt + 10;
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => now });

    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'inv-first', now);
    await coordinator.persistEntry(queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id));

    now += 10;
    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'inv-later', now);
    const laterExposure = queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
    await coordinator.persistEntry(laterExposure);

    const afterExposure = store.getById(message.id).queueCustody;
    assert.deepEqual(
      afterExposure.targetAttempts.map((attempt) => ({
        sequence: attempt.sequence,
        state: attempt.state,
        invocationId: attempt.invocationId,
      })),
      [
        { sequence: 1, state: 'appended', invocationId: 'inv-first' },
        { sequence: 2, state: 'appended', invocationId: 'inv-later' },
      ],
    );
    assert.equal(afterExposure.seenInvocationIdByCatId.opus, 'inv-later');

    now += 10;
    await coordinator.commitSuccessfulTargets(laterExposure, ['opus'], 'inv-later', now);
    const settled = store.getById(message.id).queueCustody;
    assert.equal(settled.status, 'terminal');
    assert.deepEqual(
      settled.targetAttempts.map((attempt) => ({ sequence: attempt.sequence, state: attempt.state })),
      [
        { sequence: 1, state: 'appended' },
        { sequence: 2, state: 'handled' },
      ],
    );
  });

  test('withdraws target custody independently while preserving the authored message', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue, ['opus', 'codex']);
    const message = appendCustodiedMessage(store, queue, entry);
    const persistedEntry = queue.list(entry.threadId, entry.userId).find((candidate) => candidate.id === entry.id);
    assert.ok(persistedEntry?.messageId);
    let now = entry.createdAt + 1_000;
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => now });

    assert.equal(await coordinator.withdrawEntry({ ...persistedEntry, targetCats: ['opus'] }), true);
    let stored = store.getById(message.id);
    assert.equal(stored?.deliveryStatus, 'queued', 'withdrawal must not delete or publish the authored body');
    assert.equal(stored?.queueCustody?.status, 'queued');
    assert.deepEqual(stored?.queueCustody?.pendingTargetCats, ['codex']);
    assert.deepEqual(stored?.queueCustody?.withdrawnByCatIds, ['opus']);
    assert.deepEqual(stored?.queueCustody?.withdrawnAtByCatId, { opus: now });

    now += 50;
    assert.equal(await coordinator.withdrawEntry({ ...persistedEntry, targetCats: ['codex'] }), true);
    stored = store.getById(message.id);
    assert.equal(stored?.deliveryStatus, 'queued', 'terminal withdrawal remains in the owner timeline');
    assert.equal(stored?.queueCustody?.status, 'terminal');
    assert.deepEqual(stored?.queueCustody?.pendingTargetCats, []);
    assert.deepEqual(stored?.queueCustody?.withdrawnByCatIds, ['opus', 'codex']);
    assert.deepEqual(stored?.queueCustody?.withdrawnAtByCatId, { opus: now - 50, codex: now });
    assert.equal(await coordinator.withdrawEntry({ ...persistedEntry, targetCats: ['codex'] }), false);
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
      targetAttempts: [
        {
          id: `${entry.id}:opus:1`,
          targetCatId: 'opus',
          sequence: 1,
          state: 'appended',
          createdAt: entry.createdAt,
          updatedAt: seenAt,
          invocationId: 'inv-1',
          seenAt,
        },
        {
          id: `${entry.id}:codex:1`,
          targetCatId: 'codex',
          sequence: 1,
          state: 'queued',
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
        },
      ],
      processingStartedAt: processing.processingStartedAt,
      updatedAt: persistedAt,
    });
  });

  test('persists the restart-stable pre-start retirement group before destructive terminalization', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    const entry = enqueueUser(queue, ['opus']);
    const message = appendCustodiedMessage(store, queue, entry);
    assert.equal(queue.markProcessingById(entry.threadId, entry.id), true);
    const processing = queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
    const intent = {
      id: `prestart-retirement:${entry.id}`,
      primaryEntryId: entry.id,
      entryIds: [entry.id, 'sibling-entry'],
      targetCatId: 'opus',
      startedAt: processing.processingStartedAt,
    };
    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: store,
      now: () => entry.createdAt + 1_000,
    });

    await coordinator.persistEntry({ ...processing, prestartRetirement: intent });

    assert.deepEqual(store.getById(message.id)?.queueCustody?.prestartRetirement, intent);
    assert.equal(store.getById(message.id)?.queueCustody?.status, 'processing');
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
