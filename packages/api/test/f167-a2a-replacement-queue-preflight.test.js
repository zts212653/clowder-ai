import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { createCatId } from '@cat-cafe/shared';
import { createA2ADispositionHarness as dispositionHarness } from './helpers/a2a-dispatch-disposition-harness.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { buildHandedEvent } = await import('../dist/domains/ball-custody/ball-custody-events.js');
const { createInitialQueuedMessageCustody } = await import(
  '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
);

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
  return {
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
      log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    }),
  };
}

describe('F167 A2A replacement Queue preflight', () => {
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
