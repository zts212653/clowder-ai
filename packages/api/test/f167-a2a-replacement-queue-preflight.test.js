import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { createCatId } from '@cat-cafe/shared';
import { createA2ADispositionHarness as dispositionHarness } from './helpers/a2a-dispatch-disposition-harness.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { buildHandedEvent } = await import('../dist/domains/ball-custody/ball-custody-events.js');
const { createInitialQueuedMessageCustody, QueuedMessageCustodyCoordinator } = await import(
  '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

function enqueueA2A(queue, sourceMessageId, createdAt) {
  return queue.enqueue({
    threadId: 'thread-1',
    userId: 'user-1',
    content: `handoff ${sourceMessageId}`,
    source: 'agent',
    sourceCategory: 'a2a',
    ownerAuthProvenance: 'unknown',
    targetCats: ['codex-sol'],
    callerCatId: 'opus',
    a2aParentInvocationId: 'parent-opus',
    a2aTriggerMessageId: sourceMessageId,
    intent: 'execute',
    autoExecute: false,
    createdAt,
  }).entry;
}

function enqueueUser(queue, sourceMessageId, createdAt) {
  const entry = queue.enqueue({
    threadId: 'thread-1',
    userId: 'user-1',
    content: `user work ${sourceMessageId}`,
    source: 'user',
    targetCats: ['codex-sol'],
    intent: 'implement',
    priority: 'normal',
    ownerAuthProvenance: 'strict',
    createdAt,
  }).entry;
  queue.backfillMessageId('thread-1', 'user-1', entry.id, sourceMessageId);
  return entry;
}

function replacedInspection() {
  return {
    outcome: 'replaced',
    sourceMessageId: 'message-stale',
    fromCatId: 'opus',
    handoffSourceEventId: 'route:message-stale:codex-sol',
    replacement: {
      kind: 'handed',
      sourceEventId: 'route:message-successor:codex-sol',
      sourceMessageId: 'message-successor',
      fromCatId: 'opus',
      toCatId: 'codex-sol',
      coordination: { id: 'coord-successor', phase: 'active', hop: 1 },
    },
  };
}

function createProcessor({
  queue,
  staleMessage,
  additionalMessages = [],
  inspectHandoff,
  a2aDispatchDispositionService = { inspectHandoff },
  withdrawEntry,
}) {
  const routeExecution = mock.fn(async function* () {
    yield { type: 'done', catId: 'codex-sol', timestamp: Date.now() };
  });
  const invocationCreate = mock.fn(async () => ({ outcome: 'created', invocationId: 'must-not-exist' }));
  const log = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };
  return {
    log,
    routeExecution,
    invocationCreate,
    processor: new QueueProcessor({
      queue,
      invocationTracker: {
        start: mock.fn(() => new AbortController()),
        startAll: mock.fn(() => new AbortController()),
        complete: mock.fn(),
        completeAll: mock.fn(),
        has: mock.fn(() => false),
      },
      invocationRecordStore: { create: invocationCreate, update: mock.fn(async () => {}) },
      router: { routeExecution, ackCollectedCursors: mock.fn(async () => {}) },
      socketManager: {
        broadcastAgentMessage: mock.fn(),
        broadcastToRoom: mock.fn(),
        emitToUser: mock.fn(),
      },
      messageStore: {
        getById: mock.fn(
          async (id) => [staleMessage, ...additionalMessages].find((message) => message.id === id) ?? null,
        ),
      },
      queueCustodyCoordinator: { withdrawEntry },
      a2aDispatchDispositionService,
      log,
    }),
  };
}

describe('F167 A2A replacement Queue preflight', () => {
  test('retires a carrier whose exact target already reached durable terminal truth instead of re-running provider', async () => {
    const queue = new InvocationQueue();
    const stale = enqueueA2A(queue, 'message-stale', 1_000);
    queue.backfillMessageId('thread-1', 'user-1', stale.id, 'message-stale');

    const staleMessage = {
      id: 'message-stale',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: '@codex-sol terminal handoff text',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(stale),
    };
    const inspectHandoff = mock.fn(async () => ({
      outcome: 'current',
      sourceMessageId: 'message-stale',
      fromCatId: 'opus',
      handoffSourceEventId: 'route:message-stale:codex-sol',
    }));
    const inspectTargetReplayFence = mock.fn(async () => ({
      disposition: 'terminalized',
      invocationId: 'already-finished-invocation',
      sourceMessageIds: ['message-stale'],
    }));
    const withdrawEntry = mock.fn(async () => true);
    const { processor, routeExecution, invocationCreate } = createProcessor({
      queue,
      staleMessage,
      inspectHandoff,
      withdrawEntry,
    });
    processor.deps.queueCustodyCoordinator.inspectTargetReplayFence = inspectTargetReplayFence;

    const result = await processor.executeEntry(queue.markProcessing('thread-1', 'user-1'));

    assert.equal(result.status, 'succeeded');
    assert.equal(invocationCreate.mock.calls.length, 0);
    assert.equal(routeExecution.mock.calls.length, 0);
    assert.equal(withdrawEntry.mock.calls.length, 1);
    const replayInput = inspectTargetReplayFence.mock.calls[0].arguments[0];
    assert.equal(replayInput.entry.id, stale.id);
    assert.equal(replayInput.entry.messageId, 'message-stale');
    assert.equal(replayInput.entry.status, 'processing');
    assert.equal(replayInput.targetCatId, 'codex-sol');
  });

  test('treats startup-retirement second withdrawal as idempotent terminal truth without provider re-entry', async () => {
    const queue = new InvocationQueue();
    const stale = enqueueA2A(queue, 'message-stale', 1_000);
    const store = new MessageStore();
    const staleMessage = store.append({
      id: 'message-stale',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: '@codex-sol terminal handoff text',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(stale),
    });
    queue.backfillMessageId('thread-1', 'user-1', stale.id, staleMessage.id);
    const oldCoroutineEntry = queue.markProcessing('thread-1', 'user-1');
    assert.ok(oldCoroutineEntry);

    const retirementStartedAt = oldCoroutineEntry.processingStartedAt ?? oldCoroutineEntry.createdAt;
    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: store,
      now: () => retirementStartedAt + 1_000,
    });
    const retirementIntent = {
      id: `prestart-retirement:thread-1:${stale.id}:${retirementStartedAt}`,
      primaryEntryId: stale.id,
      entryIds: [stale.id],
      targetCatId: 'codex-sol',
      startedAt: retirementStartedAt,
    };
    const withdrawalOutcomes = [];
    const withdrawEntry = mock.fn(async (entry) => {
      const outcome = await coordinator.withdrawEntry(entry);
      withdrawalOutcomes.push(outcome);
      return outcome;
    });
    const inspectTargetReplayFence = coordinator.inspectTargetReplayFence.bind(coordinator);
    const { processor, routeExecution, invocationCreate, log } = createProcessor({
      queue,
      staleMessage,
      inspectHandoff: mock.fn(async () => ({
        outcome: 'current',
        sourceMessageId: staleMessage.id,
        fromCatId: 'opus',
        handoffSourceEventId: `route:${staleMessage.id}:codex-sol`,
      })),
      withdrawEntry,
    });
    processor.deps.messageStore = store;
    processor.deps.queueCustodyCoordinator.persistEntry = coordinator.persistEntry.bind(coordinator);
    processor.deps.queueCustodyCoordinator.inspectCarrierRetirementFence =
      coordinator.inspectCarrierRetirementFence.bind(coordinator);
    processor.deps.queueCustodyCoordinator.inspectTargetReplayFence = inspectTargetReplayFence;

    assert.equal(
      await processor.resumeDurablePrestartRetirement([{ ...oldCoroutineEntry, prestartRetirement: retirementIntent }]),
      true,
      'startup reconciler finishes the durable retirement group before ordinary Queue resume',
    );
    assert.deepEqual(withdrawalOutcomes, [false], 'message cancellation already terminalized durable custody');
    assert.equal(queue.list('thread-1', 'user-1').length, 0, 'startup retirement removes the recovered Queue group');
    assert.equal(store.getById(staleMessage.id)?.deliveryStatus, 'canceled');
    assert.equal(store.getById(staleMessage.id)?.queueCustody, undefined);

    const result = await processor.executeEntry(oldCoroutineEntry);

    assert.deepEqual(withdrawalOutcomes, [false, false], 'the old coroutine observes already-retired custody');
    assert.equal(result.status, 'succeeded');
    assert.equal(invocationCreate.mock.calls.length, 0);
    assert.equal(routeExecution.mock.calls.length, 0);
    const reconciliation = log.info.mock.calls.find(
      (call) => call.arguments[1] === '[QueueProcessor] reconciled terminalized Queue carrier at no-reentry preflight',
    );
    assert.ok(reconciliation);
    assert.equal(reconciliation.arguments[0].custodyChanged, false);
    assert.deepEqual(reconciliation.arguments[0].custodyChanges, [{ entryId: stale.id, changed: false }]);
  });

  test('applies canceled-source no-reentry truth to non-A2A Queue carriers', async () => {
    const queue = new InvocationQueue();
    const entry = enqueueUser(queue, 'message-user-retired', 1_000);
    const staleMessage = {
      id: 'message-user-retired',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: 'retired user work',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      deliveryStatus: 'canceled',
    };
    const withdrawEntry = mock.fn(async () => false);
    const { processor, routeExecution, invocationCreate } = createProcessor({
      queue,
      staleMessage,
      withdrawEntry,
    });
    processor.deps.queueCustodyCoordinator.inspectCarrierRetirementFence = mock.fn(async () => ({
      disposition: 'terminalized',
      sourceMessageIds: [staleMessage.id],
    }));

    const result = await processor.executeEntry(queue.markProcessing('thread-1', 'user-1'));

    assert.equal(result.status, 'succeeded');
    assert.equal(invocationCreate.mock.calls.length, 0);
    assert.equal(routeExecution.mock.calls.length, 0);
    assert.equal(withdrawEntry.mock.calls.length, 1);
    assert.deepEqual(withdrawEntry.mock.calls[0].arguments[0].targetCats, entry.targetCats);
  });

  test('fails closed before provider creation when durable replay truth cannot be read', async () => {
    const queue = new InvocationQueue();
    const stale = enqueueA2A(queue, 'message-stale', 1_000);
    queue.backfillMessageId('thread-1', 'user-1', stale.id, 'message-stale');
    const staleMessage = {
      id: 'message-stale',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: '@codex-sol terminal handoff text',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(stale),
    };
    const { processor, routeExecution, invocationCreate } = createProcessor({
      queue,
      staleMessage,
      inspectHandoff: mock.fn(async () => ({
        outcome: 'current',
        sourceMessageId: 'message-stale',
        fromCatId: 'opus',
        handoffSourceEventId: 'route:message-stale:codex-sol',
      })),
      withdrawEntry: mock.fn(async () => true),
    });
    processor.deps.queueCustodyCoordinator.inspectTargetReplayFence = mock.fn(async () => {
      throw new Error('custody unavailable');
    });

    const result = await processor.executeEntry(queue.markProcessing('thread-1', 'user-1'));

    assert.equal(result.status, 'failed');
    assert.equal(invocationCreate.mock.calls.length, 0);
    assert.equal(routeExecution.mock.calls.length, 0);
  });

  test('reports retirement-write failure separately from replay-fence read failure', async () => {
    const queue = new InvocationQueue();
    const stale = enqueueA2A(queue, 'message-stale', 1_000);
    queue.backfillMessageId('thread-1', 'user-1', stale.id, 'message-stale');
    const staleMessage = {
      id: 'message-stale',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: '@codex-sol terminal handoff text',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(stale),
    };
    const { processor, routeExecution, invocationCreate, log } = createProcessor({
      queue,
      staleMessage,
      inspectHandoff: mock.fn(async () => ({
        outcome: 'current',
        sourceMessageId: 'message-stale',
        fromCatId: 'opus',
        handoffSourceEventId: 'route:message-stale:codex-sol',
      })),
      withdrawEntry: mock.fn(async () => {
        throw new Error('retirement write unavailable');
      }),
    });
    processor.deps.queueCustodyCoordinator.inspectTargetReplayFence = mock.fn(async () => ({
      disposition: 'terminalized',
      sourceMessageIds: ['message-stale'],
    }));

    const result = await processor.executeEntry(queue.markProcessing('thread-1', 'user-1'));

    assert.equal(result.status, 'failed');
    assert.equal(invocationCreate.mock.calls.length, 0);
    assert.equal(routeExecution.mock.calls.length, 0);
    const messages = log.error.mock.calls.map((call) => call.arguments[1]);
    assert.ok(messages.includes('[QueueProcessor] A2A terminal retirement write failed; refusing provider re-entry'));
    assert.equal(
      messages.includes('[QueueProcessor] A2A no-reentry preflight unavailable; refusing provider re-entry'),
      false,
    );
  });

  test('retires a replaced carrier before invocation creation and preserves its successor', async () => {
    const queue = new InvocationQueue();
    const stale = enqueueA2A(queue, 'message-stale', 1_000);
    queue.backfillMessageId('thread-1', 'user-1', stale.id, 'message-stale');
    const successor = enqueueA2A(queue, 'message-successor', 2_000);
    queue.backfillMessageId('thread-1', 'user-1', successor.id, 'message-successor');

    const staleMessage = {
      id: 'message-stale',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: '@codex-sol stale handoff',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(stale),
    };
    const inspectHandoff = mock.fn(async () => replacedInspection());
    const withdrawEntry = mock.fn(async () => true);
    const { processor, routeExecution, invocationCreate } = createProcessor({
      queue,
      staleMessage,
      inspectHandoff,
      withdrawEntry,
    });

    const result = await processor.executeEntry(queue.markProcessing('thread-1', 'user-1'));

    assert.equal(result.status, 'succeeded');
    assert.equal(invocationCreate.mock.calls.length, 0);
    assert.equal(routeExecution.mock.calls.length, 0);
    assert.equal(withdrawEntry.mock.calls.length, 1);
    assert.deepEqual(inspectHandoff.mock.calls[0].arguments[0], {
      threadId: 'thread-1',
      catId: 'codex-sol',
      sourceMessageId: 'message-stale',
    });
    assert.deepEqual(
      queue.list('thread-1', 'user-1').map((entry) => entry.a2aTriggerMessageId),
      ['message-successor'],
    );
  });

  test('retains the stale carrier when durable custody cannot be terminalized', async () => {
    const queue = new InvocationQueue();
    const stale = enqueueA2A(queue, 'message-stale', 1_000);
    queue.backfillMessageId('thread-1', 'user-1', stale.id, 'message-stale');
    const staleMessage = {
      id: 'message-stale',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: '@codex-sol stale handoff',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(stale),
    };
    const inspectHandoff = mock.fn(async () => replacedInspection());
    const withdrawEntry = mock.fn(async () => false);
    const { processor, routeExecution, invocationCreate } = createProcessor({
      queue,
      staleMessage,
      inspectHandoff,
      withdrawEntry,
    });

    const result = await processor.executeEntry(queue.markProcessing('thread-1', 'user-1'));

    assert.equal(result.status, 'failed');
    assert.equal(invocationCreate.mock.calls.length, 0);
    assert.equal(routeExecution.mock.calls.length, 0);
    assert.equal(withdrawEntry.mock.calls.length, 1);
    assert.equal(queue.list('thread-1', 'user-1')[0].status, 'queued');
  });

  test('runs coalesced successor work when only the original A2A handoff was replaced', async () => {
    const queue = new InvocationQueue();
    const stale = enqueueA2A(queue, 'message-stale', 1_000);
    queue.backfillMessageId('thread-1', 'user-1', stale.id, 'message-stale');
    assert.equal(
      queue.coalesceContentIntoQueuedAgent(
        'thread-1',
        'user-1',
        stale.id,
        'handoff message-successor',
        'message-successor',
        'opus',
        'parent-opus',
        'unknown',
      ),
      true,
    );
    const staleMessage = {
      id: 'message-stale',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: '@codex-sol stale handoff',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(stale),
    };
    const successorMessage = {
      ...staleMessage,
      id: 'message-successor',
      content: '@codex-sol live successor handoff',
      timestamp: 2_000,
    };
    const inspectHandoff = mock.fn(async ({ sourceMessageId }) =>
      sourceMessageId === 'message-stale'
        ? replacedInspection()
        : {
            outcome: 'live',
            sourceMessageId,
            fromCatId: 'opus',
            handoffSourceEventId: `route:${sourceMessageId}:codex-sol`,
          },
    );
    const withdrawEntry = mock.fn(async () => true);
    const { processor, routeExecution, invocationCreate } = createProcessor({
      queue,
      staleMessage,
      additionalMessages: [successorMessage],
      inspectHandoff,
      withdrawEntry,
    });

    await processor.executeEntry(queue.markProcessing('thread-1', 'user-1'));

    assert.equal(withdrawEntry.mock.calls.length, 0);
    assert.equal(invocationCreate.mock.calls.length, 1);
    assert.equal(routeExecution.mock.calls.length, 1);
    assert.match(routeExecution.mock.calls[0].arguments[1], /stale handoff/);
    assert.match(routeExecution.mock.calls[0].arguments[1], /live successor handoff/);
    assert.deepEqual(
      inspectHandoff.mock.calls.map((call) => call.arguments[0].sourceMessageId),
      ['message-stale', 'message-successor'],
    );
  });

  test('keeps a post-settlement surviving source live when its retired trigger was replaced', async () => {
    const queue = new InvocationQueue();
    const restored = enqueueA2A(queue, 'message-retired-trigger', 1_000);
    queue.backfillMessageId('thread-1', 'user-1', restored.id, 'message-surviving-source');

    const survivingMessage = {
      id: 'message-surviving-source',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: '@codex-sol still-live handoff',
      mentions: ['codex-sol'],
      timestamp: 2_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(restored),
    };
    const retiredTriggerMessage = {
      ...survivingMessage,
      id: 'message-retired-trigger',
      content: '@codex-sol retired handoff',
      timestamp: 1_000,
    };
    const inspectHandoff = mock.fn(async ({ sourceMessageId }) =>
      sourceMessageId === 'message-retired-trigger'
        ? replacedInspection()
        : {
            outcome: 'live',
            sourceMessageId,
            fromCatId: 'opus',
            handoffSourceEventId: `route:${sourceMessageId}:codex-sol`,
          },
    );
    const withdrawEntry = mock.fn(async () => true);
    const { processor, routeExecution, invocationCreate } = createProcessor({
      queue,
      staleMessage: survivingMessage,
      additionalMessages: [retiredTriggerMessage],
      inspectHandoff,
      withdrawEntry,
    });

    await processor.executeEntry(queue.markProcessing('thread-1', 'user-1'));

    assert.equal(withdrawEntry.mock.calls.length, 0);
    assert.equal(invocationCreate.mock.calls.length, 1);
    assert.equal(routeExecution.mock.calls.length, 1);
    assert.deepEqual(
      inspectHandoff.mock.calls.map((call) => call.arguments[0].sourceMessageId),
      ['message-retired-trigger', 'message-surviving-source'],
    );
  });

  test('retires a replaced carrier when optional successor enrichment throws', async () => {
    const h = await dispositionHarness();
    const successor = h.messageStore.append({
      userId: 'user-1',
      catId: createCatId('opus'),
      content: '@codex-sol successor with unavailable metadata',
      mentions: [createCatId('codex-sol')],
      timestamp: 1_500,
      threadId: 'thread-1',
    });
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        toCatId: 'codex-sol',
        messageId: successor.id,
        at: 1_500,
      }),
    );
    const getById = h.messageStore.getById.bind(h.messageStore);
    h.messageStore.getById = async (messageId) => {
      if (messageId === successor.id) throw new Error('successor metadata unavailable');
      return getById(messageId);
    };

    const queue = new InvocationQueue();
    const stale = enqueueA2A(queue, h.source.id, 1_000);
    queue.backfillMessageId('thread-1', 'user-1', stale.id, h.source.id);
    const staleMessage = {
      id: h.source.id,
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'fable5',
      content: '@codex-sol stale handoff',
      mentions: ['codex-sol'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(stale),
    };
    const withdrawEntry = mock.fn(async () => true);
    const { processor, routeExecution, invocationCreate } = createProcessor({
      queue,
      staleMessage,
      a2aDispatchDispositionService: h.service,
      withdrawEntry,
    });

    const result = await processor.executeEntry(queue.markProcessing('thread-1', 'user-1'));

    assert.equal(result.status, 'succeeded');
    assert.equal(withdrawEntry.mock.calls.length, 1);
    assert.equal(invocationCreate.mock.calls.length, 0);
    assert.equal(routeExecution.mock.calls.length, 0);
  });
});
