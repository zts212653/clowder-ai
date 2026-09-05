import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';

async function waitFor(predicate) {
  const until = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error('Queue did not converge');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function harness() {
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const store = new MessageStore();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store });
  let releaseCreate;
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  let created = 0;
  const records = {
    create: mock.fn(async () => {
      const invocationId = `inv-${++created}`;
      if (created === 1) await createGate;
      return { outcome: 'created', invocationId };
    }),
    update: mock.fn(async () => {}),
    listRunningByThread: async () => [],
  };
  const socketManager = { emitToUser: mock.fn(), broadcastToRoom() {}, broadcastAgentMessage() {} };
  const routeExecution = mock.fn(async function* (userId, _content, threadId, messageId, targets, _intent, options) {
    for (const catId of targets) {
      const childId = `child-${created}-${catId}`;
      await options.onPromptMessagesExposed({
        threadId,
        userId,
        catId,
        invocationId: childId,
        messageIds: [messageId],
        seenAt: Date.now(),
      });
      store.append({
        userId,
        threadId,
        catId,
        content: 'handled exact source',
        mentions: [],
        timestamp: Date.now(),
        replyTo: messageId,
        extra: {
          causal: { kind: 'invocation_reply', triggerMessageId: messageId },
          stream: { invocationId: `inv-${created}`, turnInvocationId: childId },
        },
      });
      yield { type: 'done', catId, invocationId: childId, timestamp: Date.now() };
    }
  });
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: store,
    queueCustodyCoordinator: coordinator,
    invocationRecordStore: records,
    socketManager,
    router: { routeExecution, ackCollectedCursors: async () => {} },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  });
  const source = store.append({
    userId: 'user-1',
    threadId: 'thread-1',
    catId: null,
    mentions: ['opus', 'codex'],
    content: 'independent targets',
    timestamp: Date.now(),
    deliveryStatus: 'queued',
  });
  const { entry } = queue.enqueue({
    threadId: source.threadId,
    userId: source.userId,
    messageId: source.id,
    content: source.content,
    source: 'user',
    ownerAuthProvenance: 'strict',
    targetCats: ['opus', 'codex'],
    intent: 'execute',
  });
  store.initializeQueueCustody(source.id, createInitialQueuedMessageCustody(entry));
  await coordinator.persistEntry(entry);
  const app = Fastify();
  await app.register(queueRoutes, {
    threadStore: { get: async () => ({ createdBy: 'user-1' }) },
    invocationQueue: queue,
    invocationTracker: tracker,
    queueProcessor: processor,
    messageStore: store,
    queueCustodyCoordinator: coordinator,
    invocationRecordStore: records,
    socketManager,
  });
  return {
    queue,
    tracker,
    store,
    coordinator,
    processor,
    records,
    source,
    entry,
    routeExecution,
    releaseCreate,
    app,
    socketManager,
  };
}

for (const entryPoint of ['direct', 'manual', 'automatic']) {
  test(`#1371: ${entryPoint} exact Steer consumes only its target and preserves the busy sibling`, async (t) => {
    const h = await harness();
    t.after(() => h.app.close());
    const busy = h.tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'independent-work');
    const reservation = h.queue.reserveExactUserEntry('thread-1', 'user-1', h.entry.id, 'codex');
    assert.equal(reservation.outcome, 'reserved');
    h.queue.beginExactSteerPreemption('thread-1', 'user-1', reservation.reservationId);
    h.queue.activateExactSteerReservation('thread-1', 'user-1', reservation.reservationId);
    if (entryPoint === 'direct')
      await h.processor.processExactSteerReservation('thread-1', 'user-1', h.entry.id, reservation.reservationId);
    else if (entryPoint === 'manual') await h.processor.processNext('thread-1', 'user-1');
    else await h.processor.onInvocationComplete('thread-1', 'codex', 'succeeded', 'previous-work', []);
    h.releaseCreate();
    await waitFor(() => h.store.getById(h.source.id).queueCustody.handledByCatIds.includes('codex'));
    assert.equal(busy.signal.aborted, false);
    assert.deepEqual(
      h.routeExecution.mock.calls.map((call) => call.arguments[4]),
      [['codex']],
    );
    assert.deepEqual(h.store.getById(h.source.id).queueCustody.pendingTargetCats, ['opus']);
    const remaining = h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id);
    assert.equal(remaining.status, 'queued');
    assert.deepEqual(remaining.targetCats, ['opus']);
    h.tracker.completeAll('thread-1', ['opus'], busy);
    await h.processor.processNext('thread-1', 'user-1');
    await waitFor(() => h.queue.list('thread-1', 'user-1').length === 0);
    assert.deepEqual(
      h.routeExecution.mock.calls.map((call) => call.arguments[4]),
      [['codex'], ['opus']],
    );
    assert.equal(h.store.getById(h.source.id).queueCustody.status, 'terminal');
  });
}

test('#1371: a sibling becoming busy during ordinary preflight requeues without losing or failing custody', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);
  const busy = h.tracker.start('thread-1', 'codex', 'user-1', ['codex'], 'independent-work');
  h.releaseCreate();
  await waitFor(() => !h.processor.hasActiveExecutionForCat('thread-1', 'opus'));
  const remaining = h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id);
  assert.equal(remaining.status, 'queued');
  assert.deepEqual(remaining.queuedFailedByCatIds ?? [], []);
  assert.deepEqual(h.store.getById(h.source.id).queueCustody.pendingTargetCats, ['opus', 'codex']);
  assert.equal(h.routeExecution.mock.calls.length, 0);
  assert.equal(busy.signal.aborted, false);
  h.tracker.completeAll('thread-1', ['codex'], busy);
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.queue.list('thread-1', 'user-1').length === 0);
  assert.deepEqual(
    h.routeExecution.mock.calls.map((call) => call.arguments[4]),
    [['opus', 'codex']],
  );
});

test('#1371: force-reset retires an orphan processing row with no slot, tracker or running record', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  h.queue.markProcessingById('thread-1', h.entry.id);
  await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id));
  for (let attempt = 0; attempt < 2; attempt++) {
    const reset = await h.app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/force-reset',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(reset.statusCode, 200, reset.body);
    const published = await h.app.inject({
      method: 'GET',
      url: '/api/threads/thread-1/queue',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.deepEqual(published.json().queue, []);
    assert.equal(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id), null);
    assert.equal(h.store.getById(h.source.id).deliveryStatus, 'canceled');
    assert.equal(h.routeExecution.mock.calls.length, 0);
  }
});

test('#1371: orphan reset fails visibly on durable write failure and succeeds on exact retry', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  h.queue.markProcessingById('thread-1', h.entry.id);
  await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id));
  const persist = h.coordinator.persistEntry.bind(h.coordinator);
  h.coordinator.persistEntry = async () => {
    throw new Error('durable retirement unavailable');
  };
  const request = {
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  };
  const failed = await h.app.inject(request);
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id).status, 'processing');
  assert.equal(h.store.getById(h.source.id).deliveryStatus, 'queued');
  h.coordinator.persistEntry = persist;
  const retried = await h.app.inject(request);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id), null);
  assert.equal(h.routeExecution.mock.calls.length, 0);
});

test('#1371: orphan recovery never acquires another user live target', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  h.queue.markProcessingById('thread-1', h.entry.id);
  await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id));
  const foreign = h.tracker.start('thread-1', 'codex', 'other-user', ['codex'], 'foreign-work');
  const reset = await h.app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  });
  assert.equal(reset.statusCode, 409, reset.body);
  assert.equal(foreign.signal.aborted, false);
  assert.equal(h.tracker.getUserId('thread-1', 'codex'), 'other-user');
  assert.equal(h.store.getById(h.source.id).deliveryStatus, 'queued');
  assert.equal(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id).status, 'processing');
});
