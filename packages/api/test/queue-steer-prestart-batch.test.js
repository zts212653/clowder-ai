import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { queueRoutes } = await import('../dist/routes/queue.js');

function asyncGate() {
  let enter;
  let release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  return { entered, blocked, enter, release };
}

function enqueue(queue, content, messageId) {
  const result = queue.enqueue({
    threadId: 't1',
    userId: 'user-a',
    content,
    source: 'user',
    ownerAuthProvenance: 'strict',
    targetCats: ['opus'],
    intent: 'execute',
    messageId,
  });
  assert.equal(result.outcome, 'enqueued');
  return result.entry;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for queue transition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Steer trackerless exact-batch preemption', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('terminalizes the entire old batch before the new exact request becomes executable', async () => {
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const createGate = asyncGate();
    const durableEntries = new Map();
    const messages = new Map();
    const routedContents = [];
    const log = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };
    let createCount = 0;

    const messageStore = {
      getByIdempotencyKey: mock.fn(async () => null),
      getByThreadAfter: mock.fn(async () => []),
      getByQueueExposure: mock.fn(async () => []),
      getById: mock.fn(async (messageId) => messages.get(messageId) ?? null),
      markCanceled: mock.fn(async (messageId) => {
        const current = messages.get(messageId);
        if (!current) return null;
        const transitioned = current.deliveryStatus === 'queued';
        const next = { ...current, deliveryStatus: 'canceled', deliveryTransitioned: transitioned };
        messages.set(messageId, next);
        return next;
      }),
      markDelivered: mock.fn(async (messageId) => {
        const current = messages.get(messageId);
        if (!current) return null;
        const next = { ...current, deliveryStatus: 'delivered', deliveryTransitioned: true };
        messages.set(messageId, next);
        return next;
      }),
    };
    const queueCustodyCoordinator = {
      persistEntry: mock.fn(async (entry) => {
        durableEntries.set(entry.id, structuredClone(entry));
      }),
      withdrawEntry: mock.fn(async (entry) => durableEntries.delete(entry.id)),
      markPrimaryTrigger: mock.fn(async () => true),
      markReminderMissed: mock.fn(async () => true),
    };
    const invocationRecordStore = {
      create: mock.fn(async () => {
        createCount += 1;
        if (createCount === 1) {
          createGate.enter();
          await createGate.blocked;
        }
        return { outcome: 'created', invocationId: createCount === 1 ? 'inv-old-batch' : 'inv-new-exact' };
      }),
      update: mock.fn(async () => ({})),
    };
    const socketManager = {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    };
    const processor = new QueueProcessor({
      queue,
      invocationTracker: tracker,
      invocationRecordStore,
      queueCustodyCoordinator,
      messageStore,
      socketManager,
      router: {
        routeExecution: mock.fn(async function* (_userId, content, _threadId, _messageId, targetCats) {
          routedContents.push(content);
          yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
      log,
    });

    app = Fastify();
    await app.register(queueRoutes, {
      threadStore: { get: mock.fn(async () => ({ id: 't1', title: 'test', createdBy: 'user-a' })) },
      invocationQueue: queue,
      queueProcessor: processor,
      invocationTracker: tracker,
      invocationRecordStore,
      queueCustodyCoordinator,
      messageStore,
      socketManager,
      agentSessionMutex: {
        forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })),
      },
    });
    await app.ready();

    for (const [messageId, content] of [
      ['msg-a', 'old-a'],
      ['msg-b', 'old-b'],
    ]) {
      messages.set(messageId, {
        id: messageId,
        threadId: 't1',
        userId: 'user-a',
        catId: null,
        content,
        mentions: ['opus'],
        timestamp: Date.now(),
        deliveryStatus: 'queued',
      });
    }
    const a = enqueue(queue, 'old-a', 'msg-a');
    const b = enqueue(queue, 'old-b', 'msg-b');
    const c = enqueue(queue, 'new-c');
    for (const entry of [a, b, c]) await queueCustodyCoordinator.persistEntry(entry);

    const oldReservation = queue.reserveExactUserBatch('t1', 'user-a', [a.id, b.id]);
    assert.equal(oldReservation.outcome, 'reserved');
    assert.equal(queue.beginExactSteerPreemption('t1', 'user-a', oldReservation.reservationId), true);
    assert.equal(queue.activateExactSteerReservation('t1', 'user-a', oldReservation.reservationId), true);
    assert.equal(
      (
        await processor.processExactSteerReservation(
          't1',
          'user-a',
          oldReservation.primaryEntryId,
          oldReservation.reservationId,
        )
      ).started,
      true,
    );
    await createGate.entered;

    const steer = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${c.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(steer.statusCode, 200);
    assert.equal(steer.json().started, true);
    assert.equal(queue.getEntrySnapshot('t1', 'user-a', a.id), null);
    assert.equal(queue.getEntrySnapshot('t1', 'user-a', b.id), null);
    assert.equal(durableEntries.has(a.id), false);
    assert.equal(durableEntries.has(b.id), false);

    createGate.release();
    await waitFor(() => routedContents.includes('new-c'));
    assert.deepEqual(routedContents, ['new-c'], 'only the second exact Steer may reach the provider');

    const recoveredQueue = new InvocationQueue();
    for (const entry of durableEntries.values()) recoveredQueue.restoreDurableEntry(entry);
    assert.equal(recoveredQueue.getEntrySnapshot('t1', 'user-a', a.id), null);
    assert.equal(recoveredQueue.getEntrySnapshot('t1', 'user-a', b.id), null, 'batch sibling must not revive');
  });

  it('external replacement retires every member of an exact pre-start batch', async () => {
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const durableEntries = new Map();
    const queueCustodyCoordinator = {
      persistEntry: mock.fn(async (entry) => {
        durableEntries.set(entry.id, structuredClone(entry));
      }),
      withdrawEntry: mock.fn(async (entry) => durableEntries.delete(entry.id)),
    };
    const processor = new QueueProcessor({
      queue,
      invocationTracker: tracker,
      queueCustodyCoordinator,
      messageStore: { markCanceled: mock.fn(async () => null) },
      socketManager: {
        broadcastAgentMessage: mock.fn(),
        broadcastToRoom: mock.fn(),
        emitToUser: mock.fn(),
      },
      log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    });
    const a = enqueue(queue, 'old-a');
    const b = enqueue(queue, 'old-b');
    durableEntries.set(a.id, structuredClone(a));
    durableEntries.set(b.id, structuredClone(b));

    const reservation = queue.reserveExactUserBatch('t1', 'user-a', [a.id, b.id]);
    assert.equal(reservation.outcome, 'reserved');
    assert.equal(queue.beginExactSteerPreemption('t1', 'user-a', reservation.reservationId), true);
    assert.equal(queue.activateExactSteerReservation('t1', 'user-a', reservation.reservationId), true);
    assert.ok(queue.claimExactSteerReservation('t1', 'user-a', reservation.primaryEntryId, reservation.reservationId));
    processor.reserveProcessingSlot(JSON.stringify(['t1', 'opus']), a.id, 'user-a');

    const replacement = await processor.acquireExternalExecution('t1', ['opus'], 'user-a', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });
    assert.ok(replacement);
    assert.equal(queue.getEntrySnapshot('t1', 'user-a', a.id), null);
    assert.equal(queue.getEntrySnapshot('t1', 'user-a', b.id), null);
    await waitFor(() => !durableEntries.has(a.id) && !durableEntries.has(b.id));
    assert.equal(tracker.has('t1', 'opus'), true, 'the replacement becomes the only slot owner');
  });

  it('parks external replacement before retiring its old batch while manual seal owns the slot', async () => {
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const durableEntries = new Map();
    const withdrawalGate = asyncGate();
    let withdrawalStarted = false;
    const queueCustodyCoordinator = {
      persistEntry: mock.fn(async (entry) => {
        durableEntries.set(entry.id, structuredClone(entry));
      }),
      withdrawEntry: mock.fn(async (entry) => {
        withdrawalStarted = true;
        withdrawalGate.enter();
        await withdrawalGate.blocked;
        return durableEntries.delete(entry.id);
      }),
    };
    const processor = new QueueProcessor({
      queue,
      invocationTracker: tracker,
      queueCustodyCoordinator,
      messageStore: { markCanceled: mock.fn(async () => null) },
      socketManager: {
        broadcastAgentMessage: mock.fn(),
        broadcastToRoom: mock.fn(),
        emitToUser: mock.fn(),
      },
      log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    });
    const a = enqueue(queue, 'old-a');
    const b = enqueue(queue, 'old-b');
    durableEntries.set(a.id, structuredClone(a));
    durableEntries.set(b.id, structuredClone(b));

    const reservation = queue.reserveExactUserBatch('t1', 'user-a', [a.id, b.id]);
    assert.equal(reservation.outcome, 'reserved');
    assert.equal(queue.beginExactSteerPreemption('t1', 'user-a', reservation.reservationId), true);
    assert.equal(queue.activateExactSteerReservation('t1', 'user-a', reservation.reservationId), true);
    assert.ok(queue.claimExactSteerReservation('t1', 'user-a', reservation.primaryEntryId, reservation.reservationId));
    processor.reserveProcessingSlot(JSON.stringify(['t1', 'opus']), a.id, 'user-a');

    const sealGuard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(sealGuard.acquired, true);
    let settled = false;
    const replacementPromise = processor
      .acquireExternalExecution('t1', ['opus'], 'user-a', {
        mode: 'replacement',
        executionId: 'inv-replacement-after-seal',
      })
      .then((replacement) => {
        settled = true;
        return replacement;
      });
    await new Promise((resolve) => setImmediate(resolve));

    const settledBeforeRelease = settled;
    const withdrawalStartedBeforeRelease = withdrawalStarted;
    const oldABeforeRelease = queue.getEntrySnapshot('t1', 'user-a', a.id);
    const oldBBeforeRelease = queue.getEntrySnapshot('t1', 'user-a', b.id);
    const durableBeforeRelease = [durableEntries.has(a.id), durableEntries.has(b.id)];
    sealGuard.release();
    await withdrawalGate.entered;
    const racingSealGuard = tracker.guardSessionSeal('t1', 'opus');
    racingSealGuard.release();
    withdrawalGate.release();
    const replacement = await replacementPromise;

    assert.equal(settledBeforeRelease, false, 'replacement must wait before durable retirement begins');
    assert.equal(withdrawalStartedBeforeRelease, false, 'durable retirement must not start behind a manual seal');
    assert.equal(oldABeforeRelease?.status, 'processing');
    assert.equal(oldBBeforeRelease?.status, 'processing');
    assert.deepEqual(durableBeforeRelease, [true, true]);
    assert.equal(racingSealGuard.acquired, false, 'execution admission must exclude a second seal during retirement');
    assert.ok(replacement);
    assert.equal(queue.getEntrySnapshot('t1', 'user-a', a.id), null);
    assert.equal(queue.getEntrySnapshot('t1', 'user-a', b.id), null);
    await waitFor(() => !durableEntries.has(a.id) && !durableEntries.has(b.id));
    assert.equal(tracker.getExecutionId('t1', 'opus'), 'inv-replacement-after-seal');
  });

  it('persists the occupied slot identity instead of the carrier target order', async () => {
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const persisted = [];
    const queueCustodyCoordinator = {
      persistEntry: mock.fn(async (entry) => persisted.push(structuredClone(entry))),
      withdrawEntry: mock.fn(async () => true),
    };
    const processor = new QueueProcessor({
      queue,
      invocationTracker: tracker,
      queueCustodyCoordinator,
      messageStore: { markCanceled: mock.fn(async () => null) },
      socketManager: {
        broadcastAgentMessage: mock.fn(),
        broadcastToRoom: mock.fn(),
        emitToUser: mock.fn(),
      },
      log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    });
    const enqueued = queue.enqueue({
      threadId: 't1',
      userId: 'user-a',
      content: 'multi-target',
      source: 'user',
      ownerAuthProvenance: 'strict',
      targetCats: ['codex', 'opus'],
      intent: 'execute',
    });
    assert.equal(enqueued.outcome, 'enqueued');
    assert.equal(queue.markProcessingById('t1', enqueued.entry.id), true);
    processor.reserveProcessingSlot(JSON.stringify(['t1', 'opus']), enqueued.entry.id, 'user-a');

    const replacement = await processor.acquireExternalExecution('t1', ['opus'], 'user-a', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });

    assert.ok(replacement);
    assert.equal(persisted[0].prestartRetirement.targetCatId, 'opus');
  });

  it('external replacement fails closed before side effects when an exact batch is inconsistent', async () => {
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const ownershipValidated = mock.fn();
    const processor = new QueueProcessor({
      queue,
      invocationTracker: tracker,
      messageStore: { markCanceled: mock.fn(async () => null) },
      socketManager: {
        broadcastAgentMessage: mock.fn(),
        broadcastToRoom: mock.fn(),
        emitToUser: mock.fn(),
      },
      log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    });
    const a = enqueue(queue, 'old-a');
    const b = enqueue(queue, 'old-b');
    const reservation = queue.reserveExactUserBatch('t1', 'user-a', [a.id, b.id]);
    assert.equal(reservation.outcome, 'reserved');
    assert.equal(queue.beginExactSteerPreemption('t1', 'user-a', reservation.reservationId), true);
    assert.equal(queue.activateExactSteerReservation('t1', 'user-a', reservation.reservationId), true);
    assert.ok(queue.claimExactSteerReservation('t1', 'user-a', reservation.primaryEntryId, reservation.reservationId));
    processor.reserveProcessingSlot(JSON.stringify(['t1', 'opus']), a.id, 'user-a');
    assert.ok(queue.removeProcessedAcrossUsers('t1', b.id), 'fixture creates the partial-batch corruption');

    const replacement = await processor.acquireExternalExecution('t1', ['opus'], 'user-a', {
      mode: 'replacement',
      executionId: 'inv-replacement',
      onOwnershipValidated: ownershipValidated,
    });

    assert.equal(replacement, null);
    assert.equal(ownershipValidated.mock.callCount(), 0, 'no cancellation side effect may cross the failed preflight');
    assert.equal(queue.getEntrySnapshot('t1', 'user-a', a.id)?.status, 'processing');
    assert.equal(tracker.has('t1', 'opus'), false);
  });
});
