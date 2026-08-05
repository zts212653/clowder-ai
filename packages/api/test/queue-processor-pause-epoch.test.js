import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const SLOT_KEY = JSON.stringify(['thread-1', 'opus']);
const CODEX_SLOT_KEY = JSON.stringify(['thread-1', 'codex']);

function deferred() {
  /** @type {(value: { outcome: string; invocationId: string }) => void} */
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function asyncGate() {
  /** @type {() => void} */
  let resolve;
  const promise = new Promise((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

function depsWithQueuedThread(invocationTracker = { has: mock.fn(() => false) }) {
  return {
    queue: {
      hasQueuedForThread: mock.fn(() => true),
      hasDispatchableQueuedForThread: mock.fn(() => true),
      listUsersForThread: mock.fn(() => []),
      list: mock.fn(() => []),
      markQueuedFailedForCatAcrossUsers: mock.fn(() => []),
      fallbackAuthorIntentsForParentAcrossUsers: mock.fn(() => []),
    },
    invocationTracker,
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-stub' })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {}),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      getById: mock.fn(async () => null),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
  };
}

describe('QueueProcessor pause epoch', () => {
  it('manual clear advances the epoch before a later refail', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deps = depsWithQueuedThread();
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    await processor.onInvocationComplete('thread-1', 'opus', 'failed');
    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(SLOT_KEY), 1);

    processor.clearPause('thread-1', 'opus');
    assert.equal(
      /** @type {any} */ (processor).pauseEpoch.get(SLOT_KEY),
      2,
      'clearPause must advance the generation so the old recovery timer can never regain ownership',
    );
    assert.equal(/** @type {any} */ (processor).pausedSlots.has(SLOT_KEY), false);

    await processor.onInvocationComplete('thread-1', 'opus', 'failed');

    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(SLOT_KEY), 3);
    assert.equal(
      /** @type {any} */ (processor).pausedSlots.has(SLOT_KEY),
      true,
      'newer pause should remain active until its own recovery timer',
    );
  });

  it('releases an old zombie owner before entering failed recovery', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const zombieController = tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'inv-zombie');
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));

    const result = await processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');

    assert.deepEqual(result, { recoveredCatIds: ['opus'], replacementCatIds: [], ownerStates: { opus: 'released' } });
    assert.equal(tracker.has('thread-1', 'opus'), false);
    assert.equal(zombieController.signal.aborted, false, 'terminal recovery retires ownership without aborting');
    assert.equal(processor.isPaused('thread-1', 'opus'), true);
    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(SLOT_KEY), 1);
  });

  it('releases an exact old processing reservation instead of treating every slot as a replacement', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));
    /** @type {any} */ (processor).processingSlots.set(SLOT_KEY, {
      startedAt: Date.now(),
      entryId: 'entry-zombie',
      invocationId: 'inv-zombie',
    });

    const result = await processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');

    assert.deepEqual(result, { recoveredCatIds: ['opus'], replacementCatIds: [], ownerStates: { opus: 'released' } });
    assert.equal(/** @type {any} */ (processor).processingSlots.has(SLOT_KEY), false);
    assert.equal(processor.isPaused('thread-1', 'opus'), true);
  });

  it('retires an exact old reservation while preserving a replacement tracker owner', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const replacement = tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'inv-replacement');
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));
    /** @type {any} */ (processor).processingSlots.set(SLOT_KEY, {
      startedAt: Date.now(),
      entryId: 'entry-zombie',
      invocationId: 'inv-zombie',
    });

    const result = await processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');

    assert.deepEqual(result, {
      recoveredCatIds: [],
      replacementCatIds: ['opus'],
      ownerStates: { opus: 'replacement' },
    });
    assert.equal(
      /** @type {any} */ (processor).processingSlots.has(SLOT_KEY),
      false,
      'the known-old reservation must not survive behind a replacement tracker',
    );
    assert.equal(tracker.has('thread-1', 'opus'), true);
    assert.equal(replacement.signal.aborted, false);
    assert.equal(processor.isPaused('thread-1', 'opus'), false);
    assert.equal(/** @type {any} */ (processor).pauseEpoch.has(SLOT_KEY), false);
  });

  it('recovers a zombie with no tracker owner and still advances pause epoch', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));

    const result = await processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');

    assert.deepEqual(result, { recoveredCatIds: ['opus'], replacementCatIds: [], ownerStates: { opus: 'absent' } });
    assert.equal(processor.isPaused('thread-1', 'opus'), true);
    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(SLOT_KEY), 1);
  });

  it('rejects an old zombie terminal when a replacement owns the slot without touching pause epoch', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const replacement = tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'inv-replacement');
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));

    const result = await processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');

    assert.deepEqual(result, {
      recoveredCatIds: [],
      replacementCatIds: ['opus'],
      ownerStates: { opus: 'replacement' },
    });
    assert.equal(tracker.has('thread-1', 'opus'), true);
    assert.equal(replacement.signal.aborted, false);
    assert.equal(processor.isPaused('thread-1', 'opus'), false);
    assert.equal(
      /** @type {any} */ (processor).pauseEpoch.has(SLOT_KEY),
      false,
      'a late old terminal must not poison the replacement epoch',
    );
  });

  it('rejects an old zombie terminal while a replacement owns the pre-start processing reservation', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.invocationRecordStore.create = mock.fn(() => new Promise(() => {}));
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'replacement starts first',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'keep queued work visible for pause detection',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    const started = await processor.processNext('thread-1', 'user-1');
    assert.equal(started.started, true);
    assert.equal(tracker.has('thread-1', 'opus'), false, 'record creation is blocked before tracker.startAll');
    assert.equal(/** @type {any} */ (processor).processingSlots.has(SLOT_KEY), true);

    const result = await processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');

    assert.deepEqual(result, {
      recoveredCatIds: [],
      replacementCatIds: ['opus'],
      ownerStates: { opus: 'replacement' },
    });
    assert.equal(processor.isPaused('thread-1', 'opus'), false);
    assert.equal(
      /** @type {any} */ (processor).pauseEpoch.has(SLOT_KEY),
      false,
      'an old terminal must not advance the epoch of a pre-start replacement',
    );
  });

  it('rejects an old zombie terminal after a replacement reservation binds its invocation id', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));
    /** @type {any} */ (processor).processingSlots.set(SLOT_KEY, {
      startedAt: Date.now(),
      entryId: 'entry-replacement',
      invocationId: 'inv-replacement',
    });

    const result = await processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');

    assert.deepEqual(result, {
      recoveredCatIds: [],
      replacementCatIds: ['opus'],
      ownerStates: { opus: 'replacement' },
    });
    assert.equal(/** @type {any} */ (processor).processingSlots.has(SLOT_KEY), true);
    assert.equal(processor.isPaused('thread-1', 'opus'), false);
    assert.equal(/** @type {any} */ (processor).pauseEpoch.has(SLOT_KEY), false);
  });

  it('retires every exact-old owner projection for a multi-cat terminal parent', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('thread-1', ['opus', 'codex'], 'user-1', 'inv-zombie');
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));
    /** @type {any} */ (processor).processingSlots.set(SLOT_KEY, {
      startedAt: Date.now(),
      entryId: 'entry-opus-zombie',
      invocationId: 'inv-zombie',
    });
    /** @type {any} */ (processor).processingSlots.set(CODEX_SLOT_KEY, {
      startedAt: Date.now(),
      entryId: 'entry-codex-zombie',
      invocationId: 'inv-zombie',
    });

    const result = await processor.onReconciledZombieComplete('thread-1', ['opus', 'codex'], 'inv-zombie');

    assert.deepEqual(result, {
      recoveredCatIds: ['opus', 'codex'],
      replacementCatIds: [],
      ownerStates: { opus: 'released', codex: 'released' },
    });
    assert.equal(tracker.has('thread-1', 'opus'), false);
    assert.equal(tracker.has('thread-1', 'codex'), false);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(SLOT_KEY), false);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(CODEX_SLOT_KEY), false);
    assert.equal(batch.signal.aborted, false, 'terminal retirement does not abort the old batch gate');
    assert.equal(processor.isPaused('thread-1', 'opus'), true);
    assert.equal(processor.isPaused('thread-1', 'codex'), true);
  });

  it('recovers exact-old siblings while preserving per-cat replacements', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    tracker.startAll('thread-1', ['opus', 'codex'], 'user-1', 'inv-zombie');
    const replacement = tracker.start('thread-1', 'codex', 'user-1', ['codex'], 'inv-replacement');
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));
    /** @type {any} */ (processor).processingSlots.set(SLOT_KEY, {
      startedAt: Date.now(),
      entryId: 'entry-opus-zombie',
      invocationId: 'inv-zombie',
    });
    const replacementReservation = {
      startedAt: Date.now(),
      entryId: 'entry-codex-replacement',
      invocationId: 'inv-replacement',
    };
    /** @type {any} */ (processor).processingSlots.set(CODEX_SLOT_KEY, replacementReservation);

    const result = await processor.onReconciledZombieComplete('thread-1', ['opus', 'codex'], 'inv-zombie');

    assert.deepEqual(result, {
      recoveredCatIds: ['opus'],
      replacementCatIds: ['codex'],
      ownerStates: { opus: 'released', codex: 'replacement' },
    });
    assert.equal(tracker.has('thread-1', 'opus'), false);
    assert.equal(tracker.has('thread-1', 'codex'), true);
    assert.equal(replacement.signal.aborted, false);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(SLOT_KEY), false);
    assert.equal(/** @type {any} */ (processor).processingSlots.get(CODEX_SLOT_KEY), replacementReservation);
    assert.equal(processor.isPaused('thread-1', 'opus'), true);
    assert.equal(processor.isPaused('thread-1', 'codex'), false);
    assert.equal(/** @type {any} */ (processor).pauseEpoch.has(CODEX_SLOT_KEY), false);
  });

  it('discards an old failed-terminal pause when a replacement acquires during queue preview I/O', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const previewGate = asyncGate();
    const queued = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'retained zombie read evidence',
      messageId: 'msg-retained',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    assert.ok(queued.entry);
    queue.markQueuedSeen('thread-1', 'user-1', queued.entry.id, 'opus', 'inv-zombie');

    tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'inv-zombie');
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.messageStore.getById = mock.fn(async () => {
      await previewGate.promise;
      return null;
    });
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    const recovery = processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deps.messageStore.getById.mock.calls.length, 1, 'recovery is blocked in real queue-preview I/O');

    const replacement = processor.acquireExternalExecution('thread-1', ['opus'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });
    assert.ok(replacement);
    previewGate.resolve();
    await recovery;

    assert.equal(tracker.has('thread-1', 'opus'), true);
    assert.equal(replacement.signal.aborted, false);
    assert.equal(processor.isPaused('thread-1', 'opus'), false);
    assert.equal(/** @type {any} */ (processor).pauseEpoch.has(SLOT_KEY), false);
    assert.equal(
      deps.socketManager.emitToUser.mock.calls.some((call) => call.arguments[1] === 'queue_paused'),
      false,
      'the discarded old terminal must not publish a paused replacement projection',
    );
  });

  it('fences a replacement sibling that arrives while another sibling awaits failed recovery I/O', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const previewGate = asyncGate();
    const queued = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'multi-cat retained evidence',
      messageId: 'msg-parent',
      source: 'user',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
    });
    assert.ok(queued.entry);
    queue.markQueuedSeen('thread-1', 'user-1', queued.entry.id, 'opus', 'inv-zombie');
    queue.markQueuedSeen('thread-1', 'user-1', queued.entry.id, 'codex', 'inv-zombie');

    tracker.startAll('thread-1', ['opus', 'codex'], 'user-1', 'inv-zombie');
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.messageStore.getById = mock.fn(async () => {
      await previewGate.promise;
      return null;
    });
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    const recovery = processor.onReconciledZombieComplete('thread-1', ['opus', 'codex'], 'inv-zombie');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deps.messageStore.getById.mock.calls.length, 1);

    const replacement = processor.acquireExternalExecution('thread-1', ['codex'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-codex-replacement',
    });
    assert.ok(replacement);
    previewGate.resolve();
    await recovery;

    assert.equal(processor.isPaused('thread-1', 'opus'), true, 'the unreplaced sibling still recovers');
    assert.equal(processor.isPaused('thread-1', 'codex'), false);
    assert.equal(/** @type {any} */ (processor).pauseEpoch.has(CODEX_SLOT_KEY), false);
    assert.equal(tracker.has('thread-1', 'codex'), true);
    assert.equal(replacement.signal.aborted, false);
  });

  it('replacement acquisition clears an already-committed old pause', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'inv-zombie');
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));

    await processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');
    assert.equal(processor.isPaused('thread-1', 'opus'), true);

    const replacement = processor.acquireExternalExecution('thread-1', ['opus'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });

    assert.ok(replacement);
    assert.equal(processor.isPaused('thread-1', 'opus'), false);
  });

  it('old auto-recovery timer performs no slot-keyed work after replacement acquisition', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tracker = new InvocationTracker();
    tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'inv-zombie');
    const deps = depsWithQueuedThread(tracker);
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    await processor.onReconciledZombieComplete('thread-1', ['opus'], 'inv-zombie');
    const replacement = processor.acquireExternalExecution('thread-1', ['opus'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });
    assert.ok(replacement);
    processor.clearPause('thread-1', 'opus');

    t.mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      deps.log.info.mock.calls.some(
        (call) => call.arguments[1] === '[QueueProcessor] Auto-recovering paused slot after timeout (#595)',
      ),
      false,
    );
    assert.equal(tracker.has('thread-1', 'opus'), true);
    assert.equal(replacement.signal.aborted, false);
  });

  it('does not let an old execution cleanup delete a replacement processing reservation', async () => {
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const oldCreate = deferred();
    const replacementCreate = deferred();
    let createCount = 0;
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.invocationRecordStore.create = mock.fn(() => {
      createCount += 1;
      return createCount === 1 ? oldCreate.promise : replacementCreate.promise;
    });
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    for (const content of ['old execution', 'replacement execution']) {
      queue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content,
        source: 'user',
        targetCats: ['opus'],
        intent: 'execute',
      });
    }

    assert.equal((await processor.processNext('thread-1', 'user-1')).started, true);
    processor.releaseSlot('thread-1', 'opus');
    assert.equal((await processor.processNext('thread-1', 'user-1')).started, true);

    const replacementReservation = /** @type {any} */ (processor).processingSlots.get(SLOT_KEY);
    oldCreate.resolve({ outcome: 'created', invocationId: 'inv-old' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      /** @type {any} */ (processor).processingSlots.get(SLOT_KEY),
      replacementReservation,
      'cleanup must compare the reservation owner instead of deleting by slot key',
    );
    assert.equal(processor.isPaused('thread-1', 'opus'), false);
  });

  it('invalidates a blocked queue reservation before a direct replacement starts', async () => {
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const oldCreate = deferred();
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.invocationRecordStore.create = mock.fn(() => oldCreate.promise);
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'old queued execution',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    assert.equal((await processor.processNext('thread-1', 'user-1')).started, true);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(SLOT_KEY), true);

    const replacement = processor.acquireExternalExecution('thread-1', ['opus'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });
    assert.ok(replacement);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(SLOT_KEY), false);
    assert.equal(
      queue.list('thread-1', 'user-1').some((entry) => entry.status === 'processing'),
      false,
      'replacement acquisition must tombstone the retired processing row before a blocked create can return',
    );

    oldCreate.resolve({ outcome: 'created', invocationId: 'inv-old' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(replacement.signal.aborted, false, 'late old start must not abort the direct replacement');
    assert.equal(tracker.has('thread-1', 'opus'), true);
    const canceledUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (call) =>
        call.arguments[0] === 'inv-old' &&
        call.arguments[1]?.status === 'canceled' &&
        call.arguments[1]?.error === 'queue_processing_reservation_replaced',
    );
    assert.ok(canceledUpdate, 'late-created old record cancels before tracker registration');
  });

  it('terminalizes a blocked freshness supplement when replacement tombstones its carrier', async () => {
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const supplementStore = new InMemoryFreshnessClosureStore();
    const offered = await supplementStore.offerSupplement({
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'opus',
      requiredMessageIds: ['msg-update'],
      requiredFrontierMessageId: 'msg-update',
      now: 100,
    });
    const oldCreate = deferred();
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.freshnessClosureStore = supplementStore;
    deps.invocationRecordStore.create = mock.fn(() => oldCreate.promise);
    deps.messageStore.markCanceled = mock.fn(async () => ({ deliveryTransitioned: true }));
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    const enqueued = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'blocked supplement carrier',
      messageId: 'msg-primary',
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });
    assert.ok(enqueued.entry);
    queue.backfillMessageId('thread-1', 'user-1', enqueued.entry.id, 'msg-merged');

    assert.equal((await processor.processNext('thread-1', 'user-1')).started, true);
    const replacement = processor.acquireExternalExecution('thread-1', ['opus'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });
    assert.ok(replacement);
    assert.equal(queue.list('thread-1', 'user-1').length, 0, 'replacement tombstones the exact carrier');

    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const terminal = await supplementStore.getSupplement(offered.supplement.id);
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.failureReason, 'user_cancel');
    assert.deepEqual(
      deps.messageStore.markCanceled.mock.calls.map((call) => call.arguments[0]).sort(),
      ['msg-merged', 'msg-primary'],
      'the removed carrier must cancel its primary and merged messages exactly once',
    );
    assert.deepEqual(
      deps.socketManager.emitToUser.mock.calls
        .filter((call) => call.arguments[1] === 'message_deleted')
        .map((call) => call.arguments[2])
        .sort((a, b) => a.messageId.localeCompare(b.messageId)),
      [
        { messageId: 'msg-merged', threadId: 'thread-1', deletedBy: 'user-1' },
        { messageId: 'msg-primary', threadId: 'thread-1', deletedBy: 'user-1' },
      ],
      'the removed carrier must emit one deletion event for every canceled message',
    );
  });

  it('does not cancel a delivered message when replacement tombstones its active carrier', async () => {
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const messageStore = new MessageStore();
    const routeEntered = asyncGate();
    const routeRelease = asyncGate();
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.messageStore = messageStore;
    deps.router.routeExecution = mock.fn(async function* () {
      routeEntered.resolve();
      await routeRelease.promise;
      yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
    });
    const processor = new QueueProcessor(/** @type {any} */ (deps));
    const message = messageStore.append({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: 'already read by active carrier',
      mentions: [],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });

    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: message.content,
      messageId: message.id,
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    assert.equal((await processor.processNext('thread-1', 'user-1')).started, true);
    await routeEntered.promise;
    assert.equal(messageStore.getById(message.id)?.deliveryStatus, 'delivered');

    const replacement = processor.acquireExternalExecution('thread-1', ['opus'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });
    assert.ok(replacement);
    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(
      messageStore.getById(message.id)?.deliveryStatus,
      'delivered',
      'replacement must not reverse an already-visible message to canceled',
    );
    assert.equal(
      deps.socketManager.emitToUser.mock.calls.some(
        (call) => call.arguments[1] === 'message_deleted' && call.arguments[2]?.messageId === message.id,
      ),
      false,
    );

    routeRelease.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('fences a secondary replacement before a multi-cat queued start resumes after record creation', async () => {
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const oldCreate = deferred();
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.invocationRecordStore.create = mock.fn(() => oldCreate.promise);
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'old multi-cat queued execution',
      source: 'user',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
    });

    assert.equal((await processor.processNext('thread-1', 'user-1')).started, true);
    const replacement = processor.acquireExternalExecution('thread-1', ['codex'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });
    assert.ok(replacement);
    const replacementSlotController = tracker.getController('thread-1', 'codex');
    assert.ok(replacementSlotController);

    oldCreate.resolve({ outcome: 'created', invocationId: 'inv-old' });
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(
      replacementSlotController.signal.aborted,
      false,
      'old multi-cat start must preserve the secondary replacement',
    );
    assert.equal(tracker.classifyExecutionId('thread-1', 'codex', 'inv-replacement'), 'matching');
    const canceledUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (call) =>
        call.arguments[0] === 'inv-old' &&
        call.arguments[1]?.status === 'canceled' &&
        call.arguments[1]?.error === 'queue_processing_reservation_replaced',
    );
    assert.ok(canceledUpdate, 'the whole old carrier cancels before mutating any target tracker');
  });

  it('rejects replacement acquisition when a processing reservation belongs to another user', async () => {
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const supplementStore = new InMemoryFreshnessClosureStore();
    const offered = await supplementStore.offerSupplement({
      lineageId: 'msg-foreign-original',
      originalMessageId: 'msg-foreign-original',
      userId: 'user-b',
      threadId: 'thread-1',
      catId: 'opus',
      requiredMessageIds: ['msg-foreign-update'],
      requiredFrontierMessageId: 'msg-foreign-update',
      now: 100,
    });
    const oldCreate = deferred();
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.freshnessClosureStore = supplementStore;
    deps.invocationRecordStore.create = mock.fn(() => oldCreate.promise);
    deps.messageStore.markCanceled = mock.fn(async () => null);
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    const enqueued = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-b',
      content: 'foreign supplement carrier',
      messageId: 'msg-foreign-primary',
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });
    assert.ok(enqueued.entry);
    queue.backfillMessageId('thread-1', 'user-b', enqueued.entry.id, 'msg-foreign-merged');

    assert.equal((await processor.processNext('thread-1', 'user-b')).started, true);
    const foreignReservation = /** @type {any} */ (processor).processingSlots.get(SLOT_KEY);
    assert.ok(foreignReservation);

    const attempted = processor.acquireExternalExecution('thread-1', ['opus'], 'user-a', {
      mode: 'replacement',
      executionId: 'inv-user-a',
    });

    assert.equal(attempted, null);
    assert.equal(
      /** @type {any} */ (processor).processingSlots.get(SLOT_KEY),
      foreignReservation,
      'rejected acquisition must not partially release foreign custody',
    );
    assert.equal(tracker.has('thread-1', 'opus'), false);
    assert.equal(queue.list('thread-1', 'user-b')[0]?.status, 'processing');
    assert.equal((await supplementStore.getSupplement(offered.supplement.id)).status, 'pending');
    assert.equal(deps.messageStore.markCanceled.mock.callCount(), 0);
    assert.equal(
      deps.socketManager.emitToUser.mock.calls.filter((call) => call.arguments[1] === 'message_deleted').length,
      0,
      'rejected acquisition must not emit message deletion events',
    );

    oldCreate.resolve({ outcome: 'created', invocationId: 'inv-user-b' });
    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it('rejects replacement acquisition when a tracker owner belongs to another user', () => {
    const tracker = new InvocationTracker();
    const foreign = tracker.startAll('thread-1', ['opus'], 'user-b', 'inv-user-b');
    const processor = new QueueProcessor(/** @type {any} */ (depsWithQueuedThread(tracker)));

    const attempted = processor.acquireExternalExecution('thread-1', ['opus'], 'user-a', {
      mode: 'replacement',
      executionId: 'inv-user-a',
    });

    assert.equal(attempted, null);
    assert.equal(foreign.signal.aborted, false);
    assert.equal(tracker.getUserId('thread-1', 'opus'), 'user-b');
    assert.equal(tracker.classifyExecutionId('thread-1', 'opus', 'inv-user-b'), 'matching');
  });

  it('rechecks a bound reservation after supplement preflight before tracker start', async () => {
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const supplementStore = new InMemoryFreshnessClosureStore();
    const offered = await supplementStore.offerSupplement({
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'opus',
      requiredMessageIds: ['msg-update'],
      requiredFrontierMessageId: 'msg-update',
      now: 100,
    });
    const preflightEntered = asyncGate();
    const resumePreflight = asyncGate();
    const getSupplement = supplementStore.getSupplement.bind(supplementStore);
    supplementStore.getSupplement = mock.fn(async (supplementId) => {
      preflightEntered.resolve();
      await resumePreflight.promise;
      return getSupplement(supplementId);
    });
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.freshnessClosureStore = supplementStore;
    deps.messageStore.getById = mock.fn(async (id) => ({
      id,
      threadId: 'thread-1',
      userId: 'user-1',
      catId: id === 'msg-original' ? 'opus' : null,
      content: id === 'msg-original' ? 'published answer' : 'late update',
      mentions: [],
      timestamp: 100,
    }));
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'supplement carrier',
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });

    assert.equal((await processor.processNext('thread-1', 'user-1')).started, true);
    await preflightEntered.promise;
    assert.equal(/** @type {any} */ (processor).processingSlots.get(SLOT_KEY)?.invocationId, 'inv-stub');

    const replacement = processor.acquireExternalExecution('thread-1', ['opus'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });
    assert.ok(replacement);
    const replacementSlotController = tracker.getController('thread-1', 'opus');
    assert.ok(replacementSlotController);

    resumePreflight.resolve();
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(replacementSlotController.signal.aborted, false, 'late queued start must not abort the replacement');
    assert.equal(tracker.classifyExecutionId('thread-1', 'opus', 'inv-replacement'), 'matching');
    const canceledUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (call) =>
        call.arguments[0] === 'inv-stub' &&
        call.arguments[1]?.status === 'canceled' &&
        call.arguments[1]?.error === 'queue_processing_reservation_replaced',
    );
    assert.ok(canceledUpdate, 'superseded carrier cancels before tracker registration');
  });

  it('rechecks every target after action preflight before multi-cat tracker start', async () => {
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    const preflightEntered = asyncGate();
    const resumePreflight = asyncGate();
    const deps = depsWithQueuedThread(tracker);
    deps.queue = queue;
    deps.actionSuccessorLeaseStore = {
      preflight: mock.fn(async () => {
        preflightEntered.resolve();
        await resumePreflight.promise;
        return { ok: true, reason: 'active' };
      }),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'active' } })),
    };
    const processor = new QueueProcessor(/** @type {any} */ (deps));

    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'multi-cat action carrier',
      source: 'agent',
      autoExecute: true,
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      actionSuccessorFence: {
        leaseId: 'lease-1',
        generation: 1,
        dispatchId: 'multi-mention:req-1',
      },
    });

    assert.equal((await processor.processNext('thread-1', 'user-1')).started, true);
    await preflightEntered.promise;

    const replacement = processor.acquireExternalExecution('thread-1', ['codex'], 'user-1', {
      mode: 'replacement',
      executionId: 'inv-replacement',
    });
    assert.ok(replacement);
    const replacementSlotController = tracker.getController('thread-1', 'codex');
    assert.ok(replacementSlotController);

    resumePreflight.resolve();
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(
      replacementSlotController.signal.aborted,
      false,
      'late multi-cat carrier must preserve secondary replacement',
    );
    assert.equal(tracker.classifyExecutionId('thread-1', 'codex', 'inv-replacement'), 'matching');
    const canceledUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (call) =>
        call.arguments[0] === 'inv-stub' &&
        call.arguments[1]?.status === 'canceled' &&
        call.arguments[1]?.error === 'queue_processing_reservation_replaced',
    );
    assert.ok(
      canceledUpdate,
      `superseded multi-cat carrier cancels before tracker registration; updates=${JSON.stringify(
        deps.invocationRecordStore.update.mock.calls.map((call) => call.arguments),
      )}`,
    );
  });
});
