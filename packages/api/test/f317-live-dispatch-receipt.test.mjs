import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { reconcileStartupCustodyMessage } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupMessageReconciler.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { LiveCarrierOperationGate } from '../src/domains/concierge/live/LiveCarrierOperationGate.ts';
import { createA2ADispositionAuth } from './helpers/a2a-dispatch-disposition-harness.js';
import { createLiveDispatchReceiptFixture as fixture } from './helpers/f317-live-dispatch-receipt-fixture.mjs';

for (const disposition of ['handled', 'completed']) {
  test(`adopted ${disposition} consumes only the exact source/target in a coalesced carrier`, async () => {
    const h = await fixture({ coalesced: true });
    await h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, disposition);
    assert.equal(h.attempts(), 1, 'durable disposition must project its source receipt');
    const custody = h.messageStore.getById(h.source.id).queueCustody;
    assert.deepEqual(custody.handledByCatIds, ['codex-sol']);
    assert.deepEqual(custody.pendingTargetCats, ['opus']);
    assert.deepEqual(h.messageStore.getById(h.sibling.id).queueCustody.handledByCatIds, []);
    assert.equal(custody.targetOutcomeByCatId['codex-sol'].disposition, 'dispatch_disposition');
    assert.equal(custody.targetOutcomeByCatId['codex-sol'].evidenceRef.disposition, disposition);
    assert.ok(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id));
  });
}

test('event committed before failed receipt is repaired by a successor invocation without another terminal', async () => {
  const h = await fixture({ failReceipt: true });
  await assert.rejects(
    h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'handled'),
    /receipt unavailable/,
  );
  assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
  assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.handledByCatIds, []);
  h.queue.markQueuedSeen('thread-1', 'user-1', h.entry.id, 'codex-sol', 'inv-successor', 1_800);
  await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id));
  const result = await h.service.completeAdopted(
    createA2ADispositionAuth(h, { invocationId: 'inv-successor' }),
    h.source.id,
    'completed',
  );
  assert.equal(result.outcome, 'replayed');
  assert.equal(result.disposition, 'handled', 'the original event remains canonical');
  assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
  assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.handledByCatIds, ['codex-sol']);
  assert.equal(
    h.messageStore.getById(h.source.id).queueCustody.targetOutcomeByCatId['codex-sol'].invocationId,
    'inv-1',
  );
});

test('a detached source can repair its exact disposition receipt from the original event', async () => {
  const h = await fixture({ detached: true });
  await h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed');
  assert.equal(h.attempts(), 1);
  assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.handledByCatIds, ['codex-sol']);
});

test('startup repairs a committed terminal using the original exposure before considering another child', async () => {
  const h = await fixture({ failReceipt: true });
  await assert.rejects(
    h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'handled'),
    /receipt unavailable/,
  );
  const { DispatchReceiptService } = await import('../dist/domains/ball-custody/DispatchReceiptService.js');
  const source = h.messageStore.getById(h.source.id);
  h.messageStore.transitionQueueCustody(source.id, {
    expectedRevision: source.queueCustody.revision,
    next: {
      ...source.queueCustody,
      revision: source.queueCustody.revision + 1,
      updatedAt: Date.now(),
      seenInvocationIdByCatId: {},
      readEvidenceWitnesses: [
        {
          targetCatId: 'codex-sol',
          invocationId: 'inv-1',
          seenAt: 1_500,
          evidenceKind: 'full_contiguous_thread_context',
        },
      ],
    },
  });
  const restartedQueue = new InvocationQueue();
  const receipts = new DispatchReceiptService({
    messageStore: h.messageStore,
    queue: restartedQueue,
    coordinator: h.coordinator,
    eventLog: h.eventLog,
  });
  await reconcileStartupCustodyMessage(
    {
      messageStore: h.messageStore,
      invocationQueue: restartedQueue,
      invocationRecordStore: { get: () => null },
      repairDispatchReceipts: (id) => receipts.repairSource(id),
      log: { info() {}, warn() {} },
    },
    h.source.id,
    Date.now,
  );
  assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.handledByCatIds, ['codex-sol']);
  assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
  assert.equal(restartedQueue.list('thread-1', 'user-1').length, 0);
});

test('stop versus disposition lets the accepted event/receipt drain, rejects later completions, and writes one terminal', async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new LiveCarrierOperationGate();
  const h = await fixture({
    gate,
    beforeDispositionRecord: async () => {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const first = h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed');
  await started;
  gate.close();
  let drained = false;
  const stopping = gate.drain().then(() => {
    drained = true;
  });
  await assert.rejects(h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed'), /closing/);
  assert.equal(drained, false);
  release();
  await first;
  await stopping;
  assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.handledByCatIds, ['codex-sol']);
  assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
});

test('ordinary Queue start repairs a pending dispatch receipt before admitting any replacement child', async () => {
  const h = await fixture({ failReceipt: true });
  await assert.rejects(
    h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed'),
    /receipt unavailable/,
  );
  const { DispatchReceiptService } = await import('../dist/domains/ball-custody/DispatchReceiptService.js');
  const source = h.messageStore.getById(h.source.id);
  h.messageStore.transitionQueueCustody(source.id, {
    expectedRevision: source.queueCustody.revision,
    next: {
      ...source.queueCustody,
      revision: source.queueCustody.revision + 1,
      updatedAt: Date.now(),
      readEvidenceWitnesses: [
        {
          targetCatId: 'codex-sol',
          invocationId: 'inv-1',
          seenAt: 1500,
          evidenceKind: 'full_contiguous_thread_context',
        },
      ],
    },
  });
  const receipts = new DispatchReceiptService({
    messageStore: h.messageStore,
    queue: h.queue,
    coordinator: h.coordinator,
    eventLog: h.eventLog,
  });
  let starts = 0;
  const tracker = new InvocationTracker();
  tracker.start('thread-1', 'codex-sol', 'user-1', ['codex-sol'], 'live-parent');
  const processor = new QueueProcessor({
    queue: h.queue,
    invocationTracker: tracker,
    messageStore: h.messageStore,
    queueCustodyCoordinator: h.coordinator,
    repairDispatchSource: (id) => receipts.repairSource(id),
    socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
    log: { info() {}, warn() {}, error() {} },
    router: {
      async *routeExecution() {
        starts++;
        yield { type: 'done', catId: 'codex-sol', timestamp: Date.now() };
      },
      async ackCollectedCursors() {},
    },
  });
  assert.equal(
    (await processor.processNext('thread-1', 'user-1')).started,
    false,
    'live owner prevents ordinary queue admission',
  );
  tracker.completeByExecutionId('thread-1', 'codex-sol', 'live-parent');
  assert.equal(
    (await processor.processNext('thread-1', 'user-1')).started,
    false,
    'the completed target must be pruned before child admission',
  );
  assert.equal(starts, 0);
  assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.handledByCatIds, ['codex-sol']);
});
