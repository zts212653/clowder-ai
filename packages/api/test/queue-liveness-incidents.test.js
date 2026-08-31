/**
 * Queue liveness incident regressions: a queue that holds entries must never
 * look idle, and a continuation that starts nothing must say why.
 *
 * These drive the real QueueProcessor branches rather than the formatter, so a
 * mis-wired label or a dropped entryId fails here.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { createInitialQueuedMessageCustody } = await import(
  '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

function stubDeps() {
  return {
    queue: new InvocationQueue(),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-stub' })),
      update: mock.fn(async () => {}),
    },
    messageStore: { getById: mock.fn(() => null), append: mock.fn(() => ({ id: 'm' })) },
    socketManager: { emitToUser: mock.fn(), broadcastToRoom: mock.fn(), broadcastAgentMessage: mock.fn() },
    router: {
      resolveExplicitTargets: mock.fn(async (targetCats) => [...targetCats]),
      resolveConversationTargetsAtAdmission: mock.fn(async (targetCats) => [...targetCats]),
      routeExecution: mock.fn(async function* () {}),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    invokeSingleCat: mock.fn(async () => {}),
  };
}

function enqueueUserEntry(deps, content = 'queued user work') {
  const enqueued = deps.queue.enqueue({
    threadId: 't1',
    userId: 'u1',
    kind: 'conversation_input',
    ownerAuthProvenance: 'unknown',
    content,
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    priority: 'normal',
  });
  assert.ok(enqueued.entry);
  return enqueued.entry;
}

function continuationDiagnostic(deps) {
  return deps.log.info.mock.calls.find((call) =>
    String(call.arguments[1] ?? '').includes('continuation started nothing'),
  );
}

describe('user-cancel requeue stays visible', () => {
  /**
   * A user cancel puts the primary entry back in Queue and then returns
   * without restarting it — deliberately, so an interrupt is not silently
   * undone. But it also skipped the pause bookkeeping the failure path does,
   * so the slot reported idle while the entry sat there. Queue looked empty,
   * the message never moved, and the only recovery was a manual steer.
   */
  it('keeps an interrupted entry queued without resurrecting the deleted pause projection', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);
    deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      kind: 'conversation_input',
      ownerAuthProvenance: 'unknown',
      content: 'work the user interrupted',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });
    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-canceled', ['opus'], true);

    assert.equal(deps.queue.list('t1', 'u1').length, 1, 'the entry itself is still there');
    assert.equal(
      deps.socketManager.emitToUser.mock.calls.some((call) => call.arguments[1] === 'queue_paused'),
      false,
      'the removed retry/pause projection must not be rebuilt as compatibility state',
    );
  });

  it('explains a stalled continuation while old queued custody remains visible', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);
    const enqueued = deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      kind: 'conversation_input',
      ownerAuthProvenance: 'unknown',
      content: 'user message that has been waiting a long time',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });
    assert.ok(enqueued.entry);
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - 600_000;
    assert.equal(deps.queue.hasQueuedForThread('t1'), true, 'old pending work remains lifecycle-visible');
    assert.equal(deps.queue.hasDispatchableQueuedForThread('t1'), true);
    deps.invocationTracker.has = mock.fn(() => true);

    await processor.requestDrain('t1');

    const diagnostic = deps.log.info.mock.calls.find((call) =>
      String(call.arguments[1] ?? '').includes('continuation started nothing'),
    );
    assert.ok(diagnostic, 'a stalled queue must still say why nothing started');
    assert.equal(diagnostic.arguments[0].outcome, 'all_candidate_slots_busy');
  });

  it('names the exact reason a continuation started nothing', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);
    deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      kind: 'conversation_input',
      ownerAuthProvenance: 'unknown',
      content: 'queued behind a busy target',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });
    deps.invocationTracker.has = mock.fn(() => true);

    await processor.requestDrain('t1');

    const diagnostic = deps.log.info.mock.calls.find((call) =>
      String(call.arguments[1] ?? '').includes('continuation started nothing'),
    );
    assert.ok(diagnostic, 'a stalled continuation must be explained');
    // The label must be readable, not merely present: three outcomes collapsed
    // into one value would still satisfy a message-only assertion.
    assert.equal(diagnostic.arguments[0].outcome, 'all_candidate_slots_busy');
    assert.ok(diagnostic.arguments[0].deferredForBusySlot >= 1);
  });

  it('stays silent when the thread has nothing queued', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-done', ['opus']);

    assert.equal(
      deps.log.info.mock.calls.some((call) => String(call.arguments[1] ?? '').includes('continuation started nothing')),
      false,
      'an empty queue needs no excuse',
    );
  });

  it('does not auto-restart the entry the user just interrupted', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);
    deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      kind: 'conversation_input',
      ownerAuthProvenance: 'unknown',
      content: 'work the user interrupted',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });

    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-canceled', ['opus'], true);

    const entry = deps.queue.list('t1', 'u1')[0];
    assert.equal(entry.status, 'queued', 'an interrupt must not be quietly undone by a restart');
  });

  it('terminalizes a strict Queue head when routing resolves no target', async () => {
    const deps = stubDeps();
    deps.messageStore = new MessageStore();
    const processor = new QueueProcessor(deps);
    const enqueued = deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      kind: 'conversation_input',
      ownerAuthProvenance: 'unknown',
      content: 'work whose admission has no deterministic target',
      source: 'user',
      targetCats: [],
      intent: 'execute',
      priority: 'normal',
    });
    assert.ok(enqueued.entry);
    const message = deps.messageStore.append({
      userId: 'u1',
      catId: null,
      content: enqueued.entry.content,
      mentions: [],
      timestamp: enqueued.entry.createdAt,
      threadId: 't1',
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(enqueued.entry),
    });
    deps.queue.backfillMessageId('t1', 'u1', enqueued.entry.id, message.id);

    const result = await processor.tryExecuteNextAcrossUsers('t1');

    assert.equal(result.started, false);
    assert.equal(result.progressed, true, 'terminal failure is forward progress even though no invocation starts');
    assert.equal(deps.queue.hasQueuedForThread('t1'), false, 'an undeliverable strict head must not remain queued');
    const timeline = deps.messageStore.getByThread('t1');
    assert.equal(timeline.length, 2, 'the source must stay visible beside its durable failure result');
    assert.equal(timeline[0].id, message.id);
    assert.equal(timeline[0].queueCustody, undefined);
    assert.equal(timeline[0].deliveryStatus, 'delivered');
    assert.equal(timeline[0].lifecycle.kind, 'input');
    assert.equal(timeline[1].lifecycle.kind, 'delivery_failure');
    assert.equal(timeline[1].lifecycle.inputMessageId, message.id);
    assert.equal(timeline[1].content, '消息未能送达：当前没有可用的接收对象。');
  });

  it('names start_rejected with the exact entry that would not start', async () => {
    const deps = stubDeps();
    deps.queueCustodyCoordinator = {
      persistEntry: mock.fn(async () => {
        throw new Error('reservation persistence rejected');
      }),
    };
    const processor = new QueueProcessor(deps);
    const entry = enqueueUserEntry(deps, 'work whose reservation cannot persist');

    const result = await processor.tryExecuteNextAcrossUsers('t1', 'opus', { onlyTargetCat: true });

    assert.equal(result.started, false);
    assert.equal(deps.queue.list('t1', 'u1')[0].status, 'queued', 'a rejected start must roll the entry back');
    const diagnostic = continuationDiagnostic(deps);
    assert.ok(diagnostic, 'a rejected start must be explained');
    assert.equal(diagnostic.arguments[0].outcome, 'start_rejected');
    assert.equal(diagnostic.arguments[0].entryId, entry.id, 'the exact entry must be named');
  });
});
