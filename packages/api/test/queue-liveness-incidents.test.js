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
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    invokeSingleCat: mock.fn(async () => {}),
  };
}

function enqueueUserEntry(deps, content = 'queued user work') {
  const enqueued = deps.queue.enqueue({
    threadId: 't1',
    userId: 'u1',
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
  it('marks the slot paused instead of returning silently', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);
    deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'unknown',
      content: 'work the user interrupted',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });

    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-canceled', ['opus'], true);

    assert.equal(
      processor.isPaused('t1', 'opus'),
      true,
      'a requeued entry the user interrupted must be visibly parked, not silently idle',
    );
    assert.equal(deps.queue.list('t1', 'u1').length, 1, 'the entry itself is still there');
  });

  it('explains a stalled continuation even once the queued user message is stale', async () => {
    // `hasQueuedForThread` reports false for non-agent entries past the stale
    // threshold — exactly the "sitting for minutes" case this log exists for.
    // Kept alongside the outcome assertions, not instead of them.
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);
    const enqueued = deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'unknown',
      content: 'user message that has been waiting a long time',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });
    assert.ok(enqueued.entry);
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - 600_000;
    assert.equal(deps.queue.hasQueuedForThread('t1'), false, 'precondition: the old gate has already gone quiet');
    assert.equal(deps.queue.hasDispatchableQueuedForThread('t1'), true);
    deps.invocationTracker.has = mock.fn(() => true);

    await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-done', ['opus']);

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
      ownerAuthProvenance: 'unknown',
      content: 'queued behind a busy target',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });
    deps.invocationTracker.has = mock.fn(() => true);

    await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-done', ['opus']);

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

  it('names no_dispatchable_candidate when the scan finds nothing for this cat', async () => {
    // The thread still holds dispatchable work, but none of it targets this cat,
    // so the scan legitimately starts nothing and must say which of the three
    // reasons applied.
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);
    enqueueUserEntry(deps, 'work for a different cat').targetCats = ['codex'];
    deps.queue.list('t1', 'u1')[0].targetCats = ['codex'];

    const result = await processor.tryExecuteNextAcrossUsers('t1', 'opus', { onlyTargetCat: true });

    assert.equal(result.started, false);
    const diagnostic = continuationDiagnostic(deps);
    assert.ok(diagnostic, 'a scan that starts nothing while work is queued must explain itself');
    assert.equal(diagnostic.arguments[0].outcome, 'no_dispatchable_candidate');
    assert.equal(diagnostic.arguments[0].deferredForBusySlot, 0);
    assert.equal(diagnostic.arguments[0].entryId, undefined);
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
