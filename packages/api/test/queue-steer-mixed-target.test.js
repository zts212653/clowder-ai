import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for Queue execution');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('QueueProcessor mixed-target exact Steer', () => {
  it('keeps the reserved pending target as slot owner and excludes its failed sibling from execution', async () => {
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const recordCreate = deferred();
    const routeExecution = mock.fn(async function* (_userId, _content, _threadId, _messageId, targetCats) {
      yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
    });
    const processor = new QueueProcessor({
      queue,
      invocationTracker: tracker,
      invocationRecordStore: {
        create: mock.fn(async () => recordCreate.promise),
        update: mock.fn(async () => ({})),
      },
      router: { routeExecution, ackCollectedCursors: mock.fn(async () => {}) },
      socketManager: {
        broadcastAgentMessage: mock.fn(),
        broadcastToRoom: mock.fn(),
        emitToUser: mock.fn(),
      },
      messageStore: {
        append: mock.fn(async () => ({ id: 'response-1' })),
        getById: mock.fn(async () => null),
      },
      log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    });

    const queued = queue.enqueue({
      threadId: 't1',
      userId: 'user-a',
      content: 'steer only the pending sibling',
      source: 'user',
      ownerAuthProvenance: 'strict',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      messageId: 'message-1',
    });
    assert.equal(queued.outcome, 'enqueued');
    assert.ok(queued.entry);
    queue.markQueuedFailedForCatAcrossUsers('t1', 'opus', 'inv-opus', new Set([queued.entry.id]));

    const reservation = queue.reserveExactUserEntry('t1', 'user-a', queued.entry.id, 'codex');
    assert.equal(reservation.outcome, 'reserved');
    assert.equal(queue.beginExactSteerPreemption('t1', 'user-a', reservation.reservationId), true);
    assert.equal(queue.activateExactSteerReservation('t1', 'user-a', reservation.reservationId), true);

    const started = await processor.processExactSteerReservation(
      't1',
      'user-a',
      queued.entry.id,
      reservation.reservationId,
    );
    assert.equal(started.started, true);
    assert.equal(processor.isCatBusy('t1', 'codex'), true, 'the exact reservation target must own the slot');
    assert.equal(processor.isCatBusy('t1', 'opus'), false, 'the failed sibling must never own the slot');

    recordCreate.resolve({ outcome: 'created', invocationId: 'inv-codex' });
    await waitFor(() => routeExecution.mock.calls.length === 1);
    assert.deepEqual(routeExecution.mock.calls[0].arguments[4], ['codex']);
  });
});
