import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A2ADispatchDispositionService } from '../src/domains/ball-custody/A2ADispatchDispositionService.ts';
import { DispatchReceiptService } from '../src/domains/ball-custody/DispatchReceiptService.ts';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { projectUnconsumedQueueCarrier } from '../src/domains/cats/services/agents/invocation/QueueCarrierSourceProjection.ts';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { createA2ADispositionAuth } from './helpers/a2a-dispatch-disposition-harness.js';
import { createLiveDispatchReceiptFixture } from './helpers/f317-live-dispatch-receipt-fixture.mjs';

const socketManager = { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} };
const quietLog = { info() {}, warn() {}, error() {} };

for (const live of [false, true]) {
  test(`failed dispatch repair preserves sibling settlement and next admission (live=${live})`, async () => {
    const messages = new MessageStore();
    const queue = new InvocationQueue();
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
    const executions = new InMemoryTurnExecutionStore();
    const cats = ['codex-sol', 'opus'];
    const source = messages.append({
      userId: 'owner',
      threadId: 'home',
      catId: null,
      content: 'both cats answer',
      mentions: cats,
      timestamp: 1,
      deliveryStatus: 'queued',
    });
    const protectedSource = live
      ? messages.append({
          userId: 'owner',
          threadId: 'home',
          catId: 'fable5',
          content: 'dispatch awaiting an explicit disposition',
          mentions: cats,
          timestamp: 2,
          deliveryStatus: 'queued',
        })
      : null;
    const admitted = queue.enqueue({
      threadId: 'home',
      userId: 'owner',
      messageId: source.id,
      content: source.content,
      targetCats: cats,
      source: 'user',
      intent: 'execute',
      ownerAuthProvenance: 'strict',
    });
    const entry = { ...admitted.entry, mergedMessageIds: protectedSource ? [protectedSource.id] : [] };
    queue.restoreEntrySnapshotIfUnchanged(admitted.entry, entry);
    messages.initializeQueueCustody(source.id, createInitialQueuedMessageCustody(entry));
    if (protectedSource) messages.initializeQueueCustody(protectedSource.id, createInitialQueuedMessageCustody(entry));
    for (const catId of cats) {
      const invocationId = `inv-${catId}`;
      executions.createRunning({
        invocationId,
        parentInvocationId: 'parent',
        threadId: 'home',
        userId: 'owner',
        catId,
        executionKind: 'ordinary',
        startedAt: 1,
        ...(live ? { queueCompletionPolicy: 'explicit_source' } : {}),
      });
      executions.transitionTerminal(invocationId, { status: 'succeeded', endedAt: Date.now() });
      queue.markQueuedSeen('home', 'owner', entry.id, catId, invocationId, 10);
      messages.append({
        userId: 'owner',
        threadId: 'home',
        catId,
        content: 'answered user source',
        mentions: [],
        timestamp: 20,
        replyTo: source.id,
        extra: { stream: { invocationId, turnInvocationId: invocationId } },
      });
    }
    await coordinator.persistEntry(queue.getEntrySnapshot('home', 'owner', entry.id));
    queue.enqueue({
      threadId: 'home',
      userId: 'owner',
      content: 'next independent request',
      targetCats: ['codex-sol'],
      source: 'user',
      intent: 'execute',
      ownerAuthProvenance: 'strict',
    });
    const repaired = [],
      errors = [],
      starts = [];
    const started = Promise.withResolvers();
    const processor = new QueueProcessor({
      queue,
      messageStore: messages,
      queueCustodyCoordinator: coordinator,
      invocationRecordStore: new InvocationRecordStore(),
      turnExecutionStore: executions,
      invocationTracker: new InvocationTracker(),
      socketManager,
      log: { ...quietLog, error: (...args) => errors.push(args) },
      repairDispatchReceipts: async (input) => {
        repaired.push(input);
        if (input.catId === 'codex-sol') throw new Error('fixture receipt backend unavailable');
      },
      router: {
        async *routeExecution(_user, text) {
          starts.push(text);
          started.resolve();
        },
        async ackCollectedCursors() {},
      },
    });
    await processor.onInvocationComplete('home', 'codex-sol', 'succeeded', 'parent', cats, false, {
      'codex-sol': 'inv-codex-sol',
      opus: 'inv-opus',
    });
    assert.deepEqual(new Set(messages.getById(source.id).queueCustody.handledByCatIds), new Set(cats));
    if (protectedSource)
      assert.deepEqual(
        messages.getById(protectedSource.id).queueCustody.handledByCatIds,
        [],
        'repair failure cannot let Live outer success consume the uncompleted dispatch',
      );
    assert.deepEqual(
      repaired.map((item) => item.catId),
      cats,
      'one target failure must not skip another target repair',
    );
    await started.promise;
    assert.deepEqual(
      starts,
      ['next independent request'],
      'the next ordinary request starts without another external wake',
    );
    assert.ok(errors.some(([context]) => context.invocationId === 'inv-codex-sol' && context.catId === 'codex-sol'));
  });
}

for (const originalExposure of [true, false]) {
  test(`an ordinary terminal after a Live read cannot wedge the other target (ordinary exposure=${originalExposure})`, async () => {
    const h = await createLiveDispatchReceiptFixture();
    const first = h.messageStore.getById(h.source.id);
    h.messageStore.transitionQueueCustody(first.id, {
      expectedRevision: first.queueCustody.revision,
      next: {
        ...first.queueCustody,
        revision: first.queueCustody.revision + 1,
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
    if (originalExposure) {
      h.queue.markQueuedSeen('thread-1', 'user-1', h.entry.id, 'codex-sol', 'ordinary', 1800);
      await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id));
    }
    await h.service.complete(createA2ADispositionAuth(h, { invocationId: 'ordinary' }), 'completed');
    if (originalExposure) {
      const outcome = {
        invocationId: 'ordinary',
        disposition: 'completed_with_turn',
        handledAt: 2100,
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'ordinary' },
      };
      await h.coordinator.commitSuccessfulTargetsForMessages(
        h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id),
        [h.source.id],
        ['codex-sol'],
        'ordinary',
        2100,
        { [h.source.id]: { 'codex-sol': outcome } },
      );
      const current = h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id);
      h.queue.restoreEntrySnapshotIfUnchanged(
        current,
        projectUnconsumedQueueCarrier(current, [h.messageStore.getById(h.source.id)]),
      );
    }
    const receipts = new DispatchReceiptService({
      messageStore: h.messageStore,
      queue: h.queue,
      coordinator: h.coordinator,
      eventLog: h.eventLog,
      onSettled() {
        assert.fail('ordinary completion must not publish a Live dispatch receipt');
      },
    });
    const before = structuredClone(h.messageStore.getById(h.source.id).queueCustody);
    await receipts.repairSource(h.source.id);
    assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody, before);
    if (originalExposure) {
      let starts = 0;
      const started = Promise.withResolvers();
      const processor = new QueueProcessor({
        queue: h.queue,
        messageStore: h.messageStore,
        invocationRecordStore: new InvocationRecordStore(),
        queueCustodyCoordinator: h.coordinator,
        invocationTracker: new InvocationTracker(),
        socketManager,
        log: quietLog,
        repairDispatchSource: (id) => receipts.repairSource(id),
        router: {
          async *routeExecution() {
            starts++;
            started.resolve();
          },
          async ackCollectedCursors() {},
        },
      });
      assert.equal((await processor.processNext('thread-1', 'user-1')).started, true);
      await started.promise;
      assert.equal(starts, 1, 'ordinary target completion cannot block its sibling');
    }
  });
}

test('a later Live adoption replays an ordinary terminal without manufacturing an adopted receipt', async () => {
  const h = await createLiveDispatchReceiptFixture();
  await h.service.complete(createA2ADispositionAuth(h, { invocationId: 'ordinary' }), 'completed');
  const service = new A2ADispatchDispositionService({
    registry: { isLatest: async () => true },
    messageStore: h.messageStore,
    ballCustodyEventLog: h.eventLog,
    ballCustodyProjectionStore: h.projectionStore,
    ballCustody: h.ingest,
    repairProjection: async () => {},
    now: () => 3000,
    isLiveCarrierInvocation: async () => true,
    getReadEvidenceForMessage: async ({ messageId }) => ({
      messageId,
      seenAt: 2500,
      evidenceKind: 'full_contiguous_thread_context',
    }),
    projectAdoptedDisposition: async () => assert.fail('ordinary terminal has no adopted receipt to project'),
  });
  const result = await service.completeAdopted(
    createA2ADispositionAuth(h, { invocationId: 'later-live' }),
    h.source.id,
    'handled',
  );
  assert.equal(result.outcome, 'replayed');
  assert.equal(result.disposition, 'completed', 'the original ordinary disposition remains authoritative');
  assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
});

test('a genuine adopted terminal still rejects a competing ordinary outcome', async () => {
  const h = await createLiveDispatchReceiptFixture({ failReceipt: true });
  await assert.rejects(
    h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed'),
    /receipt unavailable/,
  );
  const outcome = {
    invocationId: 'inv-1',
    disposition: 'completed_with_turn',
    handledAt: 2100,
    evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-1' },
  };
  await h.coordinator.commitSuccessfulTargetsForMessages(
    h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id),
    [h.source.id],
    ['codex-sol'],
    'inv-1',
    2100,
    { [h.source.id]: { 'codex-sol': outcome } },
  );
  const receipts = new DispatchReceiptService({
    messageStore: h.messageStore,
    queue: h.queue,
    coordinator: h.coordinator,
    eventLog: h.eventLog,
  });
  await assert.rejects(
    receipts.repair({ threadId: 'thread-1', catId: 'codex-sol', sourceMessageId: h.source.id }),
    /conflicts with an existing outcome/,
  );
});
