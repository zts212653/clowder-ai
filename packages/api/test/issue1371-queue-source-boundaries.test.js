import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  projectUnconsumedQueueCarrier,
  readQueueCarrierMessages,
} from '../dist/domains/cats/services/agents/invocation/QueueCarrierSourceProjection.js';
import { QueuedMessageCustodyCoordinator } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { emitQueueUpdated, enrichQueueEntries } from '../dist/utils/queue-enrichment.js';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';

function appendSource(store, queue, { state = 'handled', crossThread = false, targets = ['opus'] } = {}) {
  const message = store.append({
    userId: 'user-1',
    catId: null,
    content: `work-${state}`,
    mentions: targets,
    timestamp: Date.now(),
    threadId: 'thread-1',
    deliveryStatus: 'queued',
  });
  const { entry } = queue.enqueue({
    userId: 'user-1',
    threadId: 'thread-1',
    ownerAuthProvenance: 'unknown',
    content: message.content,
    messageId: message.id,
    source: 'user',
    targetCats: targets,
    intent: 'execute',
  });
  const isClosed = state === 'handled' || state === 'withdrawn';
  store.initializeQueueCustody(
    message.id,
    makeQueuedMessageCustody({
      entryId: crossThread ? `cross-thread:${message.id}` : entry.id,
      ...(crossThread
        ? {
            receiptScope: 'cross_thread_delivery',
            carrierByTargetCatId: Object.fromEntries(
              targets.map((catId) => [
                catId,
                {
                  entryId: entry.id,
                  source: 'agent',
                  sourceCategory: 'a2a',
                  a2aTriggerMessageId: message.id,
                  autoExecute: true,
                  createdAt: entry.createdAt,
                },
              ]),
            ),
          }
        : {}),
      intent: 'execute',
      status: isClosed || state === 'failed' ? 'terminal' : 'queued',
      allTargetCats: targets,
      pendingTargetCats: isClosed || state === 'failed' ? [] : targets,
      handledByCatIds: state === 'handled' ? targets : [],
      withdrawnByCatIds: state === 'withdrawn' ? targets : [],
      ...(state === 'withdrawn'
        ? { withdrawnAtByCatId: Object.fromEntries(targets.map((catId) => [catId, Date.now()])) }
        : {}),
      failedByCatIds: state === 'failed' ? targets : [],
    }),
  );
  return { message: store.getById(message.id), entry };
}

for (const crossThread of [false, true]) {
  test(`#1371: publication removes consumed sources and retains failed targets (crossThread=${crossThread})`, async () => {
    const store = new MessageStore();
    const queue = new InvocationQueue();
    const handled = appendSource(store, queue, { crossThread });
    appendSource(store, queue, { crossThread, state: 'withdrawn' });
    const failed = appendSource(store, queue, { crossThread, state: 'failed' });
    const projected = await enrichQueueEntries(queue.list('thread-1', 'user-1'), store);
    assert.deepEqual(
      projected.map((entry) => entry.id),
      [failed.entry.id],
    );
    const emitter = { emitToUser: mock.fn() };
    await emitQueueUpdated(emitter, 'user-1', 'thread-1', queue.list('thread-1', 'user-1'), store, 'test');
    assert.deepEqual(
      emitter.emitToUser.mock.calls[0].arguments[2].queue.map((entry) => entry.id),
      [failed.entry.id],
    );
    assert.equal(store.getById(handled.message.id).queueCustody.status, 'terminal');
  });
}

test('#1371: merged carrier drops only handled body and keeps the independent source', async () => {
  const store = new MessageStore();
  const queue = new InvocationQueue();
  const first = appendSource(store, queue);
  const second = store.append({
    userId: 'user-1',
    catId: null,
    content: 'still needed',
    mentions: ['opus'],
    timestamp: Date.now(),
    threadId: 'thread-1',
    deliveryStatus: 'queued',
    queueCustody: makeQueuedMessageCustody({
      entryId: first.entry.id,
      intent: 'execute',
      allTargetCats: ['opus'],
      pendingTargetCats: ['opus'],
    }),
  });
  const merged = { ...first.entry, mergedMessageIds: [second.id], content: 'old body\nstill needed' };
  const projected = projectUnconsumedQueueCarrier(merged, await readQueueCarrierMessages(merged, store));
  assert.equal(projected.messageId, second.id);
  assert.deepEqual(projected.mergedMessageIds, []);
  assert.equal(projected.content, 'still needed');
  assert.deepEqual(projected.targetCats, ['opus']);
});

test('#1371: partial target completion cannot hide an unhandled sibling', async () => {
  const store = new MessageStore();
  const queue = new InvocationQueue();
  const { entry, message } = appendSource(store, queue, { targets: ['opus', 'codex-sol'], state: 'pending' });
  store.transitionQueueCustody(message.id, {
    expectedRevision: 1,
    next: {
      ...message.queueCustody,
      revision: 2,
      pendingTargetCats: ['codex-sol'],
      handledByCatIds: ['opus'],
      updatedAt: Date.now(),
    },
  });
  const projected = await enrichQueueEntries([entry], store);
  assert.deepEqual(projected[0].targetCats, ['codex-sol']);
  assert.equal(projected[0].content, message.content);
});

for (const scenario of ['single', 'batch', 'read outage', 'terminal during persistence']) {
  test(`#1371: ${scenario} Steer cannot abort unrelated work without durable eligibility`, async () => {
    const store = new MessageStore();
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const first = appendSource(store, queue, {
      state: scenario === 'single' || scenario === 'batch' ? 'handled' : 'pending',
    });
    const second = appendSource(store, queue, { state: 'pending' });
    const active = tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'unrelated-child');
    const execute = mock.fn(async () => ({ status: 'succeeded' }));
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store });
    if (scenario === 'read outage') {
      store.getById = async () => {
        throw new Error('read unavailable');
      };
    }
    if (scenario === 'terminal during persistence') {
      const persist = coordinator.persistEntry.bind(coordinator);
      coordinator.persistEntry = async (entry) => {
        const result = await persist(entry);
        if (entry.id === first.entry.id) {
          const current = store.getById(first.message.id).queueCustody;
          store.transitionQueueCustody(first.message.id, {
            expectedRevision: current.revision,
            next: {
              ...current,
              revision: current.revision + 1,
              status: 'terminal',
              pendingTargetCats: [],
              handledByCatIds: ['opus'],
              updatedAt: Date.now(),
            },
          });
        }
        return result;
      };
    }
    const app = Fastify();
    try {
      await app.register(queueRoutes, {
        threadStore: { get: async () => ({ createdBy: 'user-1' }) },
        invocationQueue: queue,
        invocationTracker: tracker,
        queueProcessor: { executeEntry: execute, getPauseState: () => null },
        messageStore: store,
        queueCustodyCoordinator: coordinator,
        socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
      });
      const response = await app.inject({
        method: 'POST',
        url:
          scenario === 'batch'
            ? '/api/threads/thread-1/queue/steer-batch'
            : `/api/threads/thread-1/queue/${first.entry.id}/steer`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: scenario === 'batch' ? { entryIds: [first.entry.id, second.entry.id] } : {},
      });
      assert.equal(response.statusCode >= 400, true, response.body);
      assert.equal(active.signal.aborted, false);
      assert.equal(execute.mock.calls.length, 0);
      assert.equal(queue.hasUnsettledExactSteerReservation('thread-1', 'user-1'), false);
    } finally {
      await app.close();
    }
  });
}
