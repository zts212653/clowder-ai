import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { TurnExecutionStartupReconciler } = await import(
  '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { PersistedQueueDelivery } = await import(
  '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js'
);
const { createDeliverFn } = await import('../dist/infrastructure/scheduler/delivery.js');
const { continueRestartInterruptedCats, RESTART_CONTINUATION_CONNECTOR, RESTART_CONTINUATION_CONTENT } = await import(
  '../dist/domains/cats/services/agents/invocation/restart-continuation/RestartContinuation.js'
);

const PROCESS_STARTED_AT = 1_000;

function running(invocationId, overrides = {}) {
  return {
    invocationId,
    parentInvocationId: `parent-${invocationId}`,
    threadId: 'thread-a',
    userId: 'user-1',
    catId: 'opus',
    executionKind: 'ordinary',
    startedAt: 100,
    ...overrides,
  };
}

/** The real home path: History + Queue admission through the scheduler's system delivery. */
function createHome() {
  const turns = new InMemoryTurnExecutionStore();
  const messages = new MessageStore();
  const queue = new InvocationQueue(undefined, { resolveTargets: async (requested) => [...requested] });
  // The Queue processor owns the actual wake; here it records the request and leaves the entry queued.
  const wakes = [];
  const progress = async (entry, targetCatId) => {
    wakes.push({ entryId: entry.id, targetCatId });
    return 'owned_deferred_busy';
  };
  const delivery = new PersistedQueueDelivery({ messages, queue, progress });
  const socketManager = { broadcastAgentMessage: mock.fn(), broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
  const deliver = createDeliverFn({ messageStore: messages, socketManager, persistedQueueDelivery: delivery });
  const log = { warn: mock.fn() };
  return { turns, messages, queue, deliver, log, wakes, deps: { turns, messages, queue, deliver, log } };
}

async function restartInterrupt(turns) {
  const reconciled = await new TurnExecutionStartupReconciler({ store: turns, now: () => 2_000 }).reconcile({
    processStartedAt: PROCESS_STARTED_AT,
  });
  return reconciled.invocationIds;
}

/** Admitted input stays queued, off the delivered timeline, until the Queue hands it to the cat. */
function continuationMessages(messages, threadId) {
  return messages
    .getByThreadIncludingQueued(threadId, 50)
    .filter((m) => m.source?.connector === RESTART_CONTINUATION_CONNECTOR);
}

describe('F048 Phase C restart continuation', () => {
  test('wakes each cat the restart cut off, once per thread, as a visible system input', async () => {
    const home = createHome();
    await home.turns.createRunning(running('opus-older', { startedAt: 100 }));
    await home.turns.createRunning(running('opus-latest', { startedAt: 200 }));
    await home.turns.createRunning(running('codex-b', { threadId: 'thread-b', catId: 'codex', startedAt: 150 }));
    // Not cut off by this restart: stopped by a person before it, or a watcher with its own owner.
    await home.turns.createRunning(running('stopped', { threadId: 'thread-c', catId: 'gemini' }));
    await home.turns.transitionTerminal('stopped', { status: 'canceled', endedAt: 500, terminalReason: 'user_stop' });
    await home.turns.createRunning(running('watcher', { threadId: 'thread-d', executionKind: 'watcher' }));

    const result = await continueRestartInterruptedCats(home.deps, await restartInterrupt(home.turns));

    assert.deepEqual(
      result.delivered.map(({ threadId, catId, interruptedInvocationId }) => [
        threadId,
        catId,
        interruptedInvocationId,
      ]),
      [
        ['thread-a', 'opus', 'opus-latest'],
        ['thread-b', 'codex', 'codex-b'],
      ],
    );
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.failed, []);

    const [visible] = continuationMessages(home.messages, 'thread-a');
    assert.equal(continuationMessages(home.messages, 'thread-a').length, 1);
    assert.equal(visible.content, RESTART_CONTINUATION_CONTENT);
    assert.deepEqual(visible.from, { kind: 'system', service: RESTART_CONTINUATION_CONNECTOR });
    assert.equal(visible.source.meta.interruptedInvocationId, 'opus-latest');
    for (const thread of ['thread-c', 'thread-d']) assert.equal(continuationMessages(home.messages, thread).length, 0);

    const [entry] = home.queue.listPendingAcrossUsers('thread-a');
    assert.deepEqual(entry.targets, ['opus'], 'the Queue owes the wake to the interrupted cat');
    assert.ok(
      home.wakes.some((wake) => wake.entryId === entry.id && wake.targetCatId === 'opus'),
      'admission asks the Queue processor to run that cat',
    );
    assert.equal(entry.execution.ownerAuthProvenance, 'unknown', 'a retired authority is never revived');
    assert.equal(entry.execution.readOnlyToolPolicy, undefined);
  });

  test('a repeated startup pass does not send a second continuation', async () => {
    const home = createHome();
    await home.turns.createRunning(running('opus-a'));
    const interrupted = await restartInterrupt(home.turns);

    await continueRestartInterruptedCats(home.deps, interrupted);
    const replay = await continueRestartInterruptedCats(home.deps, interrupted);

    assert.deepEqual(replay.delivered, []);
    assert.equal(continuationMessages(home.messages, 'thread-a').length, 1);
    assert.equal(home.queue.listPendingAcrossUsers('thread-a').length, 1);
  });

  test('the same continuation identity replays instead of admitting a second input', async () => {
    const home = createHome();
    await home.turns.createRunning(running('opus-a'));
    const interrupted = await restartInterrupt(home.turns);
    const first = await continueRestartInterruptedCats(home.deps, interrupted);
    // The Queue may already have run the first continuation; the delivery key alone must hold.
    const replay = await continueRestartInterruptedCats({ ...home.deps, queue: emptyQueue() }, interrupted);

    assert.equal(replay.delivered[0].messageId, first.delivered[0].messageId);
    assert.equal(continuationMessages(home.messages, 'thread-a').length, 1);
  });

  test('a cat that already has input waiting in the Queue is left to that input', async () => {
    const home = createHome();
    await home.turns.createRunning(running('opus-a'));
    const interrupted = await restartInterrupt(home.turns);
    await home.deliver({
      userId: 'user-1',
      threadId: 'thread-a',
      targetCatId: 'opus',
      content: 'You 在重启前追加的一句话',
      idempotencyKey: 'queued-before-restart',
    });

    const result = await continueRestartInterruptedCats(home.deps, interrupted);

    assert.deepEqual(result.delivered, []);
    assert.deepEqual(
      result.skipped.map(({ catId, reason }) => [catId, reason]),
      [['opus', 'queued_work']],
    );
    assert.equal(continuationMessages(home.messages, 'thread-a').length, 0);
  });

  test('a continuation that is cut off again is not woken into the same crash', async () => {
    const home = createHome();
    await home.turns.createRunning(running('opus-first'));
    const first = await continueRestartInterruptedCats(home.deps, await restartInterrupt(home.turns));
    const continuationId = first.delivered[0].messageId;

    // The woken cat started its continuation turn, then the runtime went down again.
    await home.turns.createRunning(
      running('opus-continuation', { startedAt: 3_000, causal: { triggerMessageId: continuationId } }),
    );
    const again = await new TurnExecutionStartupReconciler({ store: home.turns, now: () => 4_000 }).reconcile({
      processStartedAt: 3_500,
    });
    const result = await continueRestartInterruptedCats({ ...home.deps, queue: emptyQueue() }, again.invocationIds);

    assert.deepEqual(result.delivered, []);
    assert.deepEqual(
      result.skipped.map(({ interruptedInvocationId, reason }) => [interruptedInvocationId, reason]),
      [['opus-continuation', 'interrupted_again']],
    );
    assert.equal(continuationMessages(home.messages, 'thread-a').length, 1);
  });

  test('one failed delivery is logged and the other cats are still woken', async () => {
    const home = createHome();
    await home.turns.createRunning(running('opus-a', { startedAt: 100 }));
    await home.turns.createRunning(running('codex-b', { threadId: 'thread-b', catId: 'codex', startedAt: 150 }));
    const interrupted = await restartInterrupt(home.turns);
    const deliver = async (opts) => {
      if (opts.threadId === 'thread-a') throw new Error('queue unavailable');
      return home.deliver(opts);
    };

    const result = await continueRestartInterruptedCats({ ...home.deps, deliver }, interrupted);

    assert.deepEqual(
      result.failed.map(({ catId, error }) => [catId, error]),
      [['opus', 'Error: queue unavailable']],
    );
    assert.deepEqual(
      result.delivered.map(({ catId }) => catId),
      ['codex'],
    );
    assert.equal(home.log.warn.mock.callCount(), 1);
  });

  test('an unreadable interrupted record costs only its own wake and never fails startup', async () => {
    const home = createHome();
    await home.turns.createRunning(running('opus-a', { startedAt: 100 }));
    await home.turns.createRunning(running('codex-b', { threadId: 'thread-b', catId: 'codex', startedAt: 150 }));
    const interrupted = await restartInterrupt(home.turns);
    const turns = {
      get: async (invocationId) => {
        if (invocationId === 'opus-a') throw new Error('redis read failed');
        return home.turns.get(invocationId);
      },
    };

    const result = await continueRestartInterruptedCats({ ...home.deps, turns }, interrupted);

    assert.deepEqual(
      result.delivered.map(({ catId }) => catId),
      ['codex'],
    );
    assert.equal(home.log.warn.mock.callCount(), 1);
  });
});

function emptyQueue() {
  return { listPendingAcrossUsers: () => [], findProcessingByCat: () => null };
}
