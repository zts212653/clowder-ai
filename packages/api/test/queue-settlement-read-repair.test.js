import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { InvocationOwnerReaper } = await import(
  '../dist/domains/cats/services/agents/invocation/InvocationOwnerReaper.js'
);
const { reconcileZombies } = await import('../dist/domains/cats/services/agents/invocation/reconcileZombies.js');
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { queueRoutes } = await import('../dist/routes/queue.js');

async function until(predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail('Queue did not reach the expected settlement boundary');
}

async function settlingQueue(t, { pauseBeforeChild = false, queuePreparationTimeoutMs } = {}) {
  const threadId = 'settlement-thread';
  const userId = 'settlement-user';
  const catId = pauseBeforeChild ? 'codex' : 'opus';
  const queue = new InvocationQueue();
  const invocationTracker = new InvocationTracker();
  const invocationRecordStore = new InvocationRecordStore();
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  const messageStore = new MessageStore();
  const draftStore = new DraftStore();
  const log = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };
  const socketManager = {
    broadcastAgentMessage: mock.fn(),
    broadcastToRoom: mock.fn(),
    emitToUser: mock.fn(),
  };
  let parentId;
  let producerPaused = false;
  const { promise: barrier, resolve: resumeProducer } = Promise.withResolvers();
  const { promise: lateAdmissionRejected, resolve: rejectLateAdmission } = Promise.withResolvers();
  const pauseProducer = () => {
    producerPaused = true;
    return barrier;
  };
  const router = {
    resolveExplicitTargets: async (cats) => [...cats],
    resolveConversationTargetsAtAdmission: async (cats) => [...cats],
    async *routeExecution(_userId, _content, _threadId, _intent, _cats, _images, options) {
      parentId = options.parentInvocationId;
      if (pauseBeforeChild) await pauseProducer();
      const child = {
        invocationId: 'settlement-child',
        parentInvocationId: parentId,
        threadId,
        userId,
        catId,
        startedAt: Date.now(),
      };
      await turnExecutionStore.createRunning({ ...child, executionKind: 'ordinary' });
      const admission = await options.onLifecycleInvocationStarted(child).catch((error) => {
        rejectLateAdmission(error);
        throw error;
      });
      const content = 'The review is durably delivered.';
      yield { type: 'text', catId, content, timestamp: Date.now() };
      await turnExecutionStore.transitionTerminal(child.invocationId, { status: 'succeeded', endedAt: Date.now() });
      const committed = await messageStore.commitLifecycleResponseTerminal(admission.responseMessageId, {
        invocationId: child.invocationId,
        status: 'completed',
        completedAt: Date.now(),
        content,
        mentions: [],
        origin: 'stream',
      });
      assert.equal(committed.kind, 'applied');
      yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
      invocationTracker.complete(threadId, catId);
    },
    async ackCollectedCursors() {
      if (!pauseBeforeChild) await pauseProducer();
    },
  };
  const processor = new QueueProcessor(
    {
      queue,
      invocationTracker,
      invocationRecordStore,
      turnExecutionStore,
      messageStore,
      draftStore,
      router,
      socketManager,
      log,
    },
    { queuePreparationTimeoutMs },
  );
  const thread = { id: threadId, title: 'Settlement', projectPath: '/project/settlement', createdBy: userId };
  const sessionLocks = { forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })) };
  const app = Fastify();
  await app.register(queueRoutes, {
    threadStore: { get: async () => thread, list: async () => [thread], listByProject: async () => [thread] },
    invocationQueue: queue,
    invocationTracker,
    invocationRecordStore,
    turnExecutionStore,
    messageStore,
    draftStore,
    queueProcessor: processor,
    socketManager,
    agentSessionMutex: sessionLocks,
    cliExecutionOwnerService: { listLive: async () => ({ owners: [], complete: true }) },
  });
  await app.ready();
  t.after(async () => {
    resumeProducer();
    await until(() => !processor.hasProcessingSlotReservation(threadId, catId));
    await app.close();
  });
  const input = canonicalTestQueueInput({
    threadId,
    userId,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    sourceId: 'settlement-input',
    content: 'Please review.',
    targetCats: [catId],
    intent: 'execute',
  });
  await queue.send(
    messageStore,
    canonicalTestMessageInput({
      threadId,
      userId,
      catId: null,
      content: input.content,
      mentions: [catId],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    }),
    input,
  );
  assert.equal((await processor.processNext(threadId, userId)).started, true);
  await until(() => producerPaused || log.error.mock.callCount() > 0);
  assert.equal(
    producerPaused,
    true,
    log.error.mock.calls
      .map((call) => call.arguments.map((value) => value?.err?.stack ?? String(value)).join(' '))
      .join('\n'),
  );
  assert.equal(invocationTracker.has(threadId, catId), pauseBeforeChild);
  if (!pauseBeforeChild) assert.equal((await turnExecutionStore.get('settlement-child')).status, 'succeeded');
  assert.equal(processor.hasProcessingSlotReservation(threadId, catId), true, 'producer still owns settlement');
  // Advance only wall-clock observation, without waiting a minute or changing durable records.
  const observedAt = Date.now() + 60_000;
  t.mock.method(Date, 'now', () => observedAt);
  return {
    app,
    processor,
    queue,
    invocationTracker,
    messageStore,
    invocationRecordStore,
    turnExecutionStore,
    log,
    socketManager,
    sessionLocks,
    threadId,
    userId,
    catId,
    parentId,
    resumeProducer,
    lateAdmissionRejected,
  };
}

async function assertSuccessfulSettlement(harness) {
  harness.resumeProducer();
  await until(() => !harness.processor.hasProcessingSlotReservation(harness.threadId, harness.catId));
  assert.equal((await harness.invocationRecordStore.get(harness.parentId)).status, 'succeeded');
  assert.equal(harness.log.error.mock.callCount(), 0, 'ordinary completion must not reject a terminal update');
}

function queueOwnerReaper(h) {
  return new InvocationOwnerReaper({
    invocationTracker: h.invocationTracker,
    invocationRecordStore: h.invocationRecordStore,
    turnExecutionStore: h.turnExecutionStore,
    getProviderLifecycle: () => undefined,
    listStaleProcessingLeases: (now) => h.processor.listStaleProcessingLeases(now),
    listRunningRecords: () => h.invocationRecordStore.listRunningByThread(h.threadId, h.userId),
    now: () => Date.now() + 31_000,
    ownerLeaseTtlMs: 30_000,
    hasActiveQueueProducer: (threadId, userId, catId, executionId) =>
      h.processor.hasActiveQueueProducer(threadId, userId, catId, executionId),
    reconcileZombie: (zombie, canConvergeQueue) =>
      reconcileZombies([zombie], {
        invocationRecordStore: h.invocationRecordStore,
        canConvergeQueue,
        invocationQueue: h.queue,
        log: h.log,
      }),
    releaseExactOwner: (threadId, targetCats, executionId) =>
      h.processor.releaseExactTerminalExecutionOwner(threadId, targetCats, executionId),
    log: h.log,
  });
}

it('owner sweep keeps a slow Codex queue preparation so the reply can complete', async (t) => {
  const h = await settlingQueue(t, { pauseBeforeChild: true });
  assert.equal(h.processor.listStaleProcessingLeases()[0]?.executionId, h.parentId);
  assert.deepEqual(await h.turnExecutionStore.listByParent(h.parentId), []);

  const sweep = await queueOwnerReaper(h).runOnce();
  assert.equal((await h.invocationRecordStore.get(h.parentId)).status, 'running');
  assert.equal(sweep.keptActive, 1);
  await assertSuccessfulSettlement(h);
  assert.equal((await h.turnExecutionStore.get('settlement-child')).status, 'succeeded');
});

it('exposes the claimed row as processing without offering append', async (t) => {
  const h = await settlingQueue(t, { pauseBeforeChild: true });
  const response = await h.app.inject({
    method: 'GET',
    url: '/api/threads/' + h.threadId + '/queue',
    headers: { 'x-cat-cafe-user': h.userId },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().queue[0].status, 'processing');
  assert.equal(response.json().queue[0].lifecycleActions?.append, undefined);
  await assertSuccessfulSettlement(h);
});

it('requeues a preparation that does not resume and fences its late child from a replacement', async (t) => {
  const h = await settlingQueue(t, { pauseBeforeChild: true, queuePreparationTimeoutMs: 1_000 });
  const entry = h.queue.list(h.threadId, h.userId)[0];

  await until(() => !h.processor.hasProcessingSlotReservation(h.threadId, h.catId));
  assert.equal((await h.invocationRecordStore.get(h.parentId)).error, 'queue_preparation_timeout');
  assert.equal(h.invocationTracker.has(h.threadId, h.catId), false);
  assert.equal(h.queue.getEntrySnapshot(h.threadId, h.userId, entry.id)?.status, 'queued');
  assert.equal((await queueOwnerReaper(h).runOnce()).reaped, 0);

  const replacement = h.invocationTracker.tryStartThread(h.threadId, h.catId, h.userId, [], 'replacement-parent');
  assert.ok(replacement);
  h.resumeProducer();
  await until(() => h.turnExecutionStore.get('settlement-child'));
  assert.match((await h.lateAdmissionRejected).message, /queue_preparation_timeout|Lifecycle ActiveRun owner mismatch/);
  assert.equal(h.invocationTracker.getExecutionId(h.threadId, h.catId), 'replacement-parent');
  assert.equal(h.queue.getEntrySnapshot(h.threadId, h.userId, entry.id)?.status, 'queued');
  const source = await h.messageStore.getById(entry.payload.messageId);
  assert.equal(source.deliveryStatus, 'queued');
  assert.deepEqual(source.lifecycle.dispatchRefs, []);
  assert.equal(
    h.messageStore.getRecent(10, h.userId).some((row) => row.lifecycle?.kind === 'response'),
    false,
  );
});

it('does not publish or retire the source when a reclaimed producer reaches admission late', async (t) => {
  const h = await settlingQueue(t, { pauseBeforeChild: true });
  const entry = h.queue.list(h.threadId, h.userId)[0];
  await h.invocationRecordStore.update(h.parentId, { status: 'failed', error: 'zombie_record_detected' });
  h.processor.releaseExactTerminalExecutionOwner(h.threadId, [h.catId], h.parentId);

  h.resumeProducer();
  await until(() => h.log.error.mock.callCount() > 0);
  const source = await h.messageStore.getById(entry.payload.messageId);
  assert.equal(source.deliveryStatus, 'queued');
  assert.deepEqual(source.lifecycle.dispatchRefs, []);
  assert.ok(h.queue.list(h.threadId, h.userId).some((row) => row.id === entry.id));
  assert.equal(
    h.messageStore.getRecent(10, h.userId).some((row) => row.lifecycle?.kind === 'response'),
    false,
  );
});

for (const replacementTiming of ['before sweep', 'during record update']) {
  it(`keeps a replacement claim installed ${replacementTiming} through sweep and late admission`, async (t) => {
    const h = await settlingQueue(t, { pauseBeforeChild: true });
    const entry = h.queue.list(h.threadId, h.userId)[0];
    h.processor.releaseExactTerminalExecutionOwner(h.threadId, [h.catId], h.parentId);
    assert.equal(await h.queue.rollbackProcessingDurable(h.threadId, entry.id, entry.claimId), true);
    let replacement;
    const installReplacement = async () => {
      assert.ok(h.invocationTracker.tryStartThread(h.threadId, h.catId, h.userId, [], 'replacement-parent'));
      replacement = await h.queue.claimExactAppend(
        h.threadId,
        h.userId,
        entry.id,
        h.queue.snapshotRevision(h.threadId, h.userId),
        [h.catId],
      );
      assert.ok(replacement);
    };
    if (replacementTiming === 'before sweep') {
      await installReplacement();
    } else {
      const update = h.invocationRecordStore.update.bind(h.invocationRecordStore);
      t.mock.method(h.invocationRecordStore, 'update', async (id, patch) => {
        const updated = await update(id, patch);
        if (updated && id === h.parentId && patch.error === 'zombie_record_detected') await installReplacement();
        return updated;
      });
    }

    const sweep = await queueOwnerReaper(h).runOnce();
    assert.equal(sweep.reaped, 1);
    assert.equal(sweep.errors, 0);
    assert.equal((await h.invocationRecordStore.get(h.parentId)).error, 'zombie_record_detected');
    assert.equal(h.invocationTracker.getExecutionId(h.threadId, h.catId), 'replacement-parent');
    assert.equal(h.queue.getEntrySnapshot(h.threadId, h.userId, entry.id)?.status, 'claimed');
    assert.equal(h.queue.getEntrySnapshot(h.threadId, h.userId, entry.id)?.claimId, replacement.claimId);

    h.resumeProducer();
    assert.match((await h.lateAdmissionRejected).message, /Lifecycle ActiveRun owner mismatch/);
    await until(() =>
      h.log.info.mock.calls.some(({ arguments: args }) => args[1]?.includes('skipped stale completion side effects')),
    );
    assert.equal(h.invocationTracker.getExecutionId(h.threadId, h.catId), 'replacement-parent');
    assert.equal(h.queue.getEntrySnapshot(h.threadId, h.userId, entry.id)?.claimId, replacement.claimId);
    const source = await h.messageStore.getById(entry.payload.messageId);
    assert.equal(source.deliveryStatus, 'queued');
    assert.deepEqual(source.lifecycle.dispatchRefs, []);
    assert.equal(
      h.messageStore.getRecent(10, h.userId).some((row) => row.lifecycle?.kind === 'response'),
      false,
    );
  });
}

it('reaps the old claim when the same member has claimed a different input', async (t) => {
  const h = await settlingQueue(t, { pauseBeforeChild: true });
  const old = h.queue.list(h.threadId, h.userId)[0];
  const otherInput = canonicalTestQueueInput({
    threadId: h.threadId,
    userId: h.userId,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    sourceId: 'other-replacement-input',
    content: 'Other input',
    targetCats: [h.catId],
    intent: 'execute',
  });
  const other = await h.queue.send(
    h.messageStore,
    canonicalTestMessageInput({
      threadId: h.threadId,
      userId: h.userId,
      catId: null,
      content: otherInput.content,
      mentions: [h.catId],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    }),
    otherInput,
  );
  h.processor.releaseExactTerminalExecutionOwner(h.threadId, [h.catId], h.parentId);
  assert.ok(h.invocationTracker.tryStartThread(h.threadId, h.catId, h.userId, [], 'other-parent'));
  const otherEntryId = other.entries[0].id;
  assert.ok(
    await h.queue.claimExactAppend(h.threadId, h.userId, otherEntryId, h.queue.snapshotRevision(h.threadId, h.userId), [
      h.catId,
    ]),
  );
  const reaper = queueOwnerReaper(h);
  assert.equal((await reaper.runOnce()).reaped, 1);
  assert.equal((await h.invocationRecordStore.get(h.parentId)).status, 'failed');
  assert.equal(h.queue.getEntrySnapshot(h.threadId, h.userId, old.id), null);
  assert.equal(h.invocationTracker.getExecutionId(h.threadId, h.catId), 'other-parent');
  assert.equal(h.queue.getEntrySnapshot(h.threadId, h.userId, otherEntryId)?.status, 'claimed');
  h.resumeProducer();
  assert.match((await h.lateAdmissionRejected).message, /owner mismatch/);
});

it('rejects the old token when replacement claims the row at the deletion call', async (t) => {
  const h = await settlingQueue(t, { pauseBeforeChild: true });
  const old = h.queue.list(h.threadId, h.userId)[0];
  h.processor.releaseExactTerminalExecutionOwner(h.threadId, [h.catId], h.parentId);
  const remove = h.queue.removeProcessedAcrossUsersDurable.bind(h.queue);
  let replacement;
  const mocked = t.mock.method(h.queue, 'removeProcessedAcrossUsersDurable', async (...args) => {
    assert.equal(args[5]?.claimId, old.claimId);
    assert.equal(await h.queue.rollbackProcessingDurable(h.threadId, old.id, old.claimId), true);
    assert.ok(h.invocationTracker.tryStartThread(h.threadId, h.catId, h.userId, [], 'replacement-parent'));
    replacement = await h.queue.claimExactAppend(
      h.threadId,
      h.userId,
      old.id,
      h.queue.snapshotRevision(h.threadId, h.userId),
      [h.catId],
    );
    assert.ok(replacement);
    const result = await remove(...args);
    assert.equal(result, null);
    return result;
  });
  const sweep = await queueOwnerReaper(h).runOnce();
  assert.equal(sweep.reaped, 1);
  assert.equal(sweep.errors, 0);
  assert.equal(mocked.mock.callCount(), 1);
  assert.equal(h.queue.getEntrySnapshot(h.threadId, h.userId, old.id)?.claimId, replacement.claimId);
  assert.equal(h.invocationTracker.getExecutionId(h.threadId, h.catId), 'replacement-parent');
  h.resumeProducer();
  assert.match((await h.lateAdmissionRejected).message, /owner mismatch/);
});

it('owner sweep recovers an orphan without interrupting a successful Queue settlement in the same cat slot', async (t) => {
  const h = await settlingQueue(t);
  const { invocationId: orphanId } = await h.invocationRecordStore.create({
    threadId: h.threadId,
    userId: h.userId,
    targetCats: [h.catId],
    intent: 'execute',
    idempotencyKey: 'other-parent-without-producer',
    actionLeaseCarrier: { kind: 'none' },
  });
  await h.invocationRecordStore.update(orphanId, { status: 'running' });
  const reaper = queueOwnerReaper(h);
  const onComplete = t.mock.method(h.processor, 'onInvocationComplete');

  await reaper.runOnce();

  assert.equal((await h.invocationRecordStore.get(h.parentId)).status, 'running');
  assert.equal((await h.invocationRecordStore.get(orphanId)).error, 'zombie_record_detected');

  const releaseSuccessWrite = Promise.withResolvers();
  const update = h.invocationRecordStore.update.bind(h.invocationRecordStore);
  t.mock.method(h.invocationRecordStore, 'update', async (id, patch) => {
    const record = await update(id, patch);
    if (id === h.parentId && patch.status === 'succeeded' && record?.status === 'succeeded') {
      await releaseSuccessWrite.promise;
    }
    return record;
  });
  h.resumeProducer();
  try {
    await until(() => h.invocationRecordStore.get(h.parentId)?.status === 'succeeded');
    assert.equal((await reaper.runOnce()).keptActive, 1);
    assert.equal(h.processor.hasProcessingSlotReservation(h.threadId, h.catId, h.parentId), true);
    assert.equal(onComplete.mock.callCount(), 0);
  } finally {
    releaseSuccessWrite.resolve();
  }

  await assertSuccessfulSettlement(h);
  assert.equal((await reaper.runOnce()).scanned, 0);
  assert.equal(onComplete.mock.callCount(), 1);
  assert.deepEqual(onComplete.mock.calls[0].arguments.slice(0, 4), [h.threadId, h.catId, 'succeeded', h.parentId]);
  assert.equal(
    h.socketManager.broadcastAgentMessage.mock.calls.some((call) => call.arguments[0]?.type === 'error'),
    false,
  );
  const replies = h.messageStore
    .getRecent(10, h.userId)
    .filter((message) => message.from.kind === 'agent' && message.content === 'The review is durably delivered.');
  assert.equal(replies.length, 1);
});

describe('active execution read-repair during Queue settlement', () => {
  for (const scope of ['thread', 'project']) {
    it(`${scope} polling preserves a completed child while its real Queue producer still settles`, async (t) => {
      const h = await settlingQueue(t);
      const response = await h.app.inject({
        method: 'GET',
        url:
          scope === 'thread'
            ? `/api/threads/${h.threadId}/executions/active`
            : '/api/executions/active?projectPath=%2Fproject%2Fsettlement',
        headers: { 'x-cat-cafe-user': h.userId },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(
        (await h.invocationRecordStore.get(h.parentId)).status,
        'running',
        'a living producer must retain the right to commit its successful parent terminal',
      );
      assert.equal(h.sessionLocks.forceReleaseByScope.mock.callCount(), 0);
      assert.equal(
        h.socketManager.broadcastAgentMessage.mock.calls.some((call) => call.arguments[0]?.type === 'canceled'),
        false,
      );
      await assertSuccessfulSettlement(h);
    });
  }

  it('repairs a different orphan for the same cat without releasing the settling producer', async (t) => {
    const h = await settlingQueue(t);
    const { invocationId: orphanId } = await h.invocationRecordStore.create({
      threadId: h.threadId,
      userId: h.userId,
      targetCats: [h.catId],
      intent: 'execute',
      idempotencyKey: 'older-orphan',
      actionLeaseCarrier: { kind: 'none' },
    });
    await h.invocationRecordStore.update(orphanId, { status: 'running' });
    const later = Date.now() + 60_000;
    t.mock.method(Date, 'now', () => later);
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/threads/${h.threadId}/executions/active`,
      headers: { 'x-cat-cafe-user': h.userId },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await h.invocationRecordStore.get(orphanId)).error, 'execution_owner_lost');
    assert.equal(
      h.processor.hasProcessingSlotReservation(h.threadId, h.catId),
      true,
      'repairing an orphan must not steal a different producer reservation',
    );
    assert.equal((await h.invocationRecordStore.get(h.parentId)).status, 'running');
    assert.equal(
      h.sessionLocks.forceReleaseByScope.mock.callCount(),
      0,
      'the replacement producer retains its session locks',
    );
    await assertSuccessfulSettlement(h);
  });
});
