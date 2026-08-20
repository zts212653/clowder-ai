/**
 * F118 post-close: QueueProcessor reads stay pure; the serialized owner reaper
 * invokes the only stale-reservation mutation APIs.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const SHORT_TTL = 1000;
const T0 = 100_000;

const slotKey = (threadId, catId) => JSON.stringify([threadId, catId]);

function reservation(startedAt, entryId = 'entry-test', invocationId, trackerStarted = false) {
  return {
    startedAt,
    entryId,
    userId: 'u1',
    ...(invocationId ? { invocationId } : {}),
    ...(trackerStarted ? { trackerStarted: true } : {}),
  };
}

function stubDeps(overrides = {}) {
  return {
    queue: new InvocationQueue(),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      completeByExecutionId: mock.fn(() => 'absent'),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-stub' })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: 'msg-stub' })),
      getById: mock.fn(async () => null),
    },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    ...overrides,
  };
}

function enqueueProcessing(deps, content = 'recover me') {
  const entry = deps.queue.enqueue({
    ownerAuthProvenance: 'unknown',
    threadId: 't1',
    userId: 'u1',
    content,
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
  }).entry;
  assert.ok(entry);
  assert.ok(deps.queue.markProcessingById('t1', entry.id));
  return entry;
}

describe('QueueProcessor explicit stale-owner recovery (F118)', () => {
  it('does not mutate an old reservation from read or admission APIs', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const key = slotKey('t1', 'opus');
    /** @type {any} */ (processor).processingSlots.set(key, reservation(T0));
    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(processor.isThreadBusy('t1'), true);
    assert.equal(processor.hasActiveExecution('t1'), true);
    assert.equal(processor.isCatBusy('t1', 'opus'), true);
    await processor.tryAutoExecute('t1');
    assert.equal(/** @type {any} */ (processor).processingSlots.has(key), true);
  });

  it('explicitly reaps and requeues the exact stale pre-provider reservation', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const persisted = [];
    const deps = stubDeps({
      queueCustodyCoordinator: {
        persistEntry: mock.fn(async (entry) => persisted.push(structuredClone(entry))),
      },
    });
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const entry = enqueueProcessing(deps);
    /** @type {any} */ (processor).processingSlots.set(slotKey('t1', 'opus'), reservation(T0, entry.id));
    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(processor.reapStalePrestartReservations(), 1);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(slotKey('t1', 'opus')), false);
    assert.equal(deps.queue.getEntrySnapshot('t1', 'u1', entry.id)?.status, 'queued');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'queued');
  });

  it('treats a bound reservation as pre-provider until tracker installation is proven', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const entry = enqueueProcessing(deps);
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('t1', 'opus'),
      reservation(T0, entry.id, 'exec-bound-before-start'),
    );
    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(processor.reapStalePrestartReservations(), 1);
    assert.equal(deps.queue.getEntrySnapshot('t1', 'u1', entry.id)?.status, 'queued');
  });

  it('never reaps a started provider reservation without lifecycle reconciliation', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const entry = enqueueProcessing(deps);
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('t1', 'opus'),
      reservation(T0, entry.id, 'exec-provider', true),
    );
    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(processor.reapStalePrestartReservations(), 0);
    assert.equal(deps.queue.getEntrySnapshot('t1', 'u1', entry.id)?.status, 'processing');
    assert.deepEqual(processor.listStaleProcessingLeases(), [
      {
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        executionId: 'exec-provider',
        startedAt: T0,
        ageMs: SHORT_TTL + 1,
      },
    ]);
  });

  it('enumerates only stale exact owners and preserves fresh or unrelated slots', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('thread-old', 'opus'),
      reservation(T0, 'entry-old', 'exec-old', true),
    );
    t.mock.timers.tick(SHORT_TTL + 1);
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('thread-fresh', 'opus'),
      reservation(Date.now(), 'entry-fresh', 'exec-fresh', true),
    );

    assert.deepEqual(processor.listStaleProcessingLeases(), [
      {
        threadId: 'thread-old',
        catId: 'opus',
        userId: 'u1',
        executionId: 'exec-old',
        startedAt: T0,
        ageMs: SHORT_TTL + 1,
      },
    ]);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(slotKey('thread-fresh', 'opus')), true);
  });

  it('exact release cannot remove a replacement reservation', () => {
    const deps = stubDeps({
      invocationTracker: {
        start: mock.fn(() => new AbortController()),
        startAll: mock.fn(() => new AbortController()),
        complete: mock.fn(),
        completeAll: mock.fn(),
        completeByExecutionId: mock.fn(() => 'replacement'),
        has: mock.fn(() => true),
      },
    });
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('t1', 'opus'),
      reservation(T0, 'entry-new', 'exec-replacement', true),
    );

    const release = processor.releaseExactExecutionOwner('t1', ['opus'], 'exec-old');

    assert.deepEqual(release.replacementCatIds, ['opus']);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(slotKey('t1', 'opus')), true);
  });
});
