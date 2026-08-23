import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { createInitialQueuedMessageCustody } = await import(
  '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
);
const { queueRoutes } = await import('../dist/routes/queue.js');
const { restartHarness } = await import('./queue-steer-prestart-restart-fixture.js');

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

async function createHarness() {
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const createGate = asyncGate();
  const durableEntries = new Map();
  const messages = new Map();
  const failedWithdrawals = new Set();
  const failedCancellations = new Set();
  const routedContents = [];
  const log = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };
  let createCount = 0;

  const messageStore = {
    getByIdempotencyKey: mock.fn(async () => null),
    getByThreadAfter: mock.fn(async () => []),
    getByQueueExposure: mock.fn(async () => []),
    getById: mock.fn(async (messageId) => messages.get(messageId) ?? null),
    scanByDeliveryStatus: mock.fn(async (status) =>
      [...messages.values()].filter((message) => message.deliveryStatus === status).map((message) => message.id),
    ),
    initializeQueueCustody: mock.fn(async (messageId, custody) => {
      const current = messages.get(messageId);
      if (!current) return { kind: 'not_found' };
      if (current.deliveryStatus !== 'queued') return { kind: 'not_queued' };
      if (current.queueCustody) return { kind: 'existing', message: current };
      const next = { ...current, queueCustody: structuredClone(custody) };
      messages.set(messageId, next);
      return { kind: 'initialized', message: next };
    }),
    transitionQueueCustody: mock.fn(async (messageId, input) => {
      const current = messages.get(messageId);
      if (!current?.queueCustody) return { kind: 'not_found' };
      if (current.queueCustody.revision !== input.expectedRevision) {
        return { kind: 'revision_mismatch', actualRevision: current.queueCustody.revision };
      }
      const next = {
        ...current,
        queueCustody: structuredClone(input.next),
        ...(input.deliveredAt === undefined ? {} : { deliveryStatus: 'delivered', deliveredAt: input.deliveredAt }),
      };
      messages.set(messageId, next);
      return { kind: 'updated', message: next, deliveryTransitioned: input.deliveredAt !== undefined };
    }),
    markCanceled: mock.fn(async (messageId) => {
      if (failedCancellations.has(messageId)) throw new Error(`cancel failed: ${messageId}`);
      const current = messages.get(messageId);
      if (!current) return null;
      const deliveryTransitioned = current.deliveryStatus === 'queued';
      if (current.queueCustody) durableEntries.delete(current.queueCustody.entryId);
      const { queueCustody: _queueCustody, ...stableCurrent } = current;
      const next = { ...stableCurrent, deliveryStatus: 'canceled', deliveryTransitioned };
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
      if (!entry.messageId) return [];
      const current = messages.get(entry.messageId);
      if (!current) return [];
      const base = current.queueCustody ?? createInitialQueuedMessageCustody(entry);
      const nextCustody = {
        ...base,
        revision: current.queueCustody ? base.revision + 1 : base.revision,
        status: entry.status,
        ...(entry.processingStartedAt === undefined ? {} : { processingStartedAt: entry.processingStartedAt }),
        ...(entry.prestartRetirement ? { prestartRetirement: structuredClone(entry.prestartRetirement) } : {}),
        updatedAt: Date.now(),
      };
      messages.set(entry.messageId, { ...current, queueCustody: nextCustody });
      return [entry.messageId];
    }),
    withdrawEntry: mock.fn(async (entry) => {
      if (failedWithdrawals.has(entry.id)) throw new Error(`withdraw failed: ${entry.id}`);
      return durableEntries.delete(entry.id);
    }),
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
      return { outcome: 'created', invocationId: createCount === 1 ? 'inv-old-batch' : `inv-${createCount}` };
    }),
    update: mock.fn(async () => ({})),
    listRunningByThread: mock.fn(async () => []),
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

  for (const [messageId, content] of [
    ['msg-a', 'old-a'],
    ['msg-b', 'old-b'],
    ['msg-c', 'new-c'],
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
  const c = enqueue(queue, 'new-c', 'msg-c');
  for (const entry of [a, b, c]) await queueCustodyCoordinator.persistEntry(entry);
  const reservation = queue.reserveExactUserBatch('t1', 'user-a', [a.id, b.id]);
  assert.equal(reservation.outcome, 'reserved');
  assert.equal(queue.beginExactSteerPreemption('t1', 'user-a', reservation.reservationId), true);
  assert.equal(queue.activateExactSteerReservation('t1', 'user-a', reservation.reservationId), true);
  assert.equal(
    (
      await processor.processExactSteerReservation(
        't1',
        'user-a',
        reservation.primaryEntryId,
        reservation.reservationId,
      )
    ).started,
    true,
  );
  await createGate.entered;

  return {
    queue,
    tracker,
    createGate,
    durableEntries,
    messages,
    failedWithdrawals,
    failedCancellations,
    routedContents,
    messageStore,
    queueCustodyCoordinator,
    invocationRecordStore,
    socketManager,
    processor,
    a,
    b,
    c,
  };
}

describe('pre-start exact-batch durable retirement failure', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('force-reset retires a recordless processing owner and fences its late cleanup from a replacement', async () => {
    const h = await createHarness();
    app = Fastify();
    await app.register(queueRoutes, {
      threadStore: { get: mock.fn(async () => ({ id: 't1', title: 'test', createdBy: 'user-a' })) },
      invocationQueue: h.queue,
      queueProcessor: h.processor,
      invocationTracker: h.tracker,
      invocationRecordStore: h.invocationRecordStore,
      queueCustodyCoordinator: h.queueCustodyCoordinator,
      messageStore: h.messageStore,
      socketManager: h.socketManager,
      agentSessionMutex: {
        forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })),
      },
    });
    await app.ready();

    assert.equal(h.tracker.has('t1', 'opus'), false, 'the reproducer must remain before tracker admission');
    assert.equal(h.invocationRecordStore.listRunningByThread.mock.calls.length, 0);
    assert.equal(h.queue.getEntrySnapshot('t1', 'user-a', h.a.id)?.status, 'processing');

    const reset = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/force-reset',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });

    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(h.queue.getEntrySnapshot('t1', 'user-a', h.a.id), null, 'exact processing anchor must retire');
    assert.equal(h.queue.getEntrySnapshot('t1', 'user-a', h.b.id), null, 'the whole processing group must retire');
    assert.equal(h.durableEntries.has(h.a.id), false);
    assert.equal(h.durableEntries.has(h.b.id), false);
    assert.equal(h.messages.get('msg-a').deliveryStatus, 'canceled');
    assert.equal(h.messages.get('msg-b').deliveryStatus, 'canceled');
    assert.ok(
      h.socketManager.emitToUser.mock.calls.some(
        ({ arguments: [userId, event, payload] }) =>
          userId === 'user-a' &&
          event === 'queue_updated' &&
          payload.action === 'force_reset' &&
          payload.queue.length === 1,
      ),
      'force-reset must publish the remaining queue after retiring the processing group',
    );

    const replacement = await h.processor.acquireExternalExecution('t1', ['opus'], 'user-a', {
      mode: 'non_preemptive',
      executionId: 'inv-replacement-after-reset',
    });
    assert.ok(replacement, 'a replacement may acquire the now-terminal slot');
    assert.equal(h.tracker.has('t1', 'opus'), true);

    h.createGate.release();
    await waitFor(() => h.invocationRecordStore.update.mock.calls.length > 0);

    assert.deepEqual(h.routedContents, [], 'the late recordless coroutine must not start the canceled provider');
    assert.equal(h.tracker.has('t1', 'opus'), true, 'late cleanup must not release the replacement owner');
    assert.equal(replacement.signal.aborted, false, 'late cleanup must not cancel the replacement invocation');
    assert.deepEqual(
      await h.processor.retireThreadPrestartProcessingGroups('t1', 'user-a'),
      { outcome: 'none', retiredCatIds: [] },
      'a live external owner without a Queue row is outside Queue-group retirement',
    );
    h.tracker.completeAll('t1', ['opus'], replacement);
  });

  it('keeps an unresolved Steer batch recoverable and starts C only after a successful retry', async () => {
    const h = await createHarness();
    h.failedCancellations.add('msg-b');
    app = Fastify();
    await app.register(queueRoutes, {
      threadStore: { get: mock.fn(async () => ({ id: 't1', title: 'test', createdBy: 'user-a' })) },
      invocationQueue: h.queue,
      queueProcessor: h.processor,
      invocationTracker: h.tracker,
      invocationRecordStore: h.invocationRecordStore,
      queueCustodyCoordinator: h.queueCustodyCoordinator,
      messageStore: h.messageStore,
      socketManager: h.socketManager,
      agentSessionMutex: {
        forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })),
      },
    });
    await app.ready();

    const first = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${h.c.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(first.statusCode, 503);
    assert.equal(first.json().code, 'PRESTART_TERMINALIZATION_FAILED');
    assert.equal(h.messages.get('msg-a').deliveryStatus, 'canceled', 'A must terminalize before B fails');
    assert.equal(h.durableEntries.has(h.a.id), false, 'A custody must already be withdrawn');
    assert.equal(h.queue.getEntrySnapshot('t1', 'user-a', h.b.id)?.status, 'processing');
    assert.equal(h.durableEntries.has(h.b.id), true, 'failed durable member must remain represented');
    assert.deepEqual(h.messages.get('msg-b').queueCustody.prestartRetirement.entryIds, [h.a.id, h.b.id]);
    assert.deepEqual(h.routedContents, [], 'neither old nor new provider may start after refusal');

    const restarted = await restartHarness(h);
    assert.equal(restarted.queue.getEntrySnapshot('t1', 'user-a', h.b.id)?.status, 'processing');
    assert.equal(restarted.queue.getEntrySnapshot('t1', 'user-a', h.c.id)?.status, 'queued');
    assert.deepEqual(restarted.routedContents, [], 'restart must not dispatch the surviving subset or C');

    h.failedCancellations.delete('msg-b');
    const restartedApp = Fastify();
    await restartedApp.register(queueRoutes, {
      threadStore: { get: mock.fn(async () => ({ id: 't1', title: 'test', createdBy: 'user-a' })) },
      invocationQueue: restarted.queue,
      queueProcessor: restarted.processor,
      invocationTracker: restarted.tracker,
      invocationRecordStore: restarted.invocationRecordStore,
      queueCustodyCoordinator: h.queueCustodyCoordinator,
      messageStore: h.messageStore,
      socketManager: h.socketManager,
      agentSessionMutex: {
        forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })),
      },
    });
    await restartedApp.ready();
    const retry = await restartedApp.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${h.c.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(retry.statusCode, 200);
    await waitFor(() => restarted.routedContents.includes('new-c'));
    h.createGate.release();
    await waitFor(() => h.invocationRecordStore.update.mock.calls.length > 0);
    assert.deepEqual(restarted.routedContents, ['new-c']);
    assert.equal(restarted.queue.getEntrySnapshot('t1', 'user-a', h.a.id), null);
    assert.equal(restarted.queue.getEntrySnapshot('t1', 'user-a', h.b.id), null);
    assert.equal(h.durableEntries.has(h.a.id), false);
    assert.equal(h.durableEntries.has(h.b.id), false);

    const secondRestart = await restartHarness(h);
    assert.equal(secondRestart.queue.getEntrySnapshot('t1', 'user-a', h.a.id), null);
    assert.equal(secondRestart.queue.getEntrySnapshot('t1', 'user-a', h.b.id), null);
    await restartedApp.close();
  });

  it('refuses external replacement until the same durable retirement can finish', async () => {
    const h = await createHarness();
    h.failedCancellations.add('msg-b');

    const first = await h.processor.acquireExternalExecution('t1', ['opus'], 'user-a', {
      mode: 'replacement',
      executionId: 'inv-replacement-1',
    });
    assert.equal(first, null);
    assert.equal(h.tracker.has('t1', 'opus'), false, 'replacement provider owner must not start');
    assert.equal(h.messages.get('msg-a').deliveryStatus, 'canceled', 'A must terminalize before B fails');
    assert.equal(h.durableEntries.has(h.a.id), false, 'A custody must already be withdrawn');
    assert.equal(h.queue.getEntrySnapshot('t1', 'user-a', h.b.id)?.status, 'processing');
    assert.equal(h.durableEntries.has(h.b.id), true);

    const restarted = await restartHarness(h);
    assert.equal(restarted.queue.getEntrySnapshot('t1', 'user-a', h.b.id)?.status, 'processing');
    assert.equal(restarted.tracker.has('t1', 'opus'), false);
    assert.deepEqual(restarted.routedContents, []);

    h.failedCancellations.delete('msg-b');
    const retry = await restarted.processor.acquireExternalExecution('t1', ['opus'], 'user-a', {
      mode: 'replacement',
      executionId: 'inv-replacement-2',
    });
    assert.ok(retry);
    assert.equal(restarted.tracker.has('t1', 'opus'), true);
    assert.equal(restarted.queue.getEntrySnapshot('t1', 'user-a', h.a.id), null);
    assert.equal(restarted.queue.getEntrySnapshot('t1', 'user-a', h.b.id), null);
    assert.equal(h.durableEntries.has(h.a.id), false);
    assert.equal(h.durableEntries.has(h.b.id), false);
    assert.deepEqual(h.routedContents, [], 'the superseded old provider never runs');
    h.createGate.release();
  });
});
