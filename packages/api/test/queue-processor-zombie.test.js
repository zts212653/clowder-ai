/**
 * F118 D4: QueueProcessor.processingSlots Zombie Defense
 *
 * AC-D8: processingSlots exceeding threshold + invocationTracker.has() false → auto-cleanup
 * AC-D9: processingSlots exceeding threshold but invocationTracker.has() true → no cleanup (regression)
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const SHORT_TTL = 1000; // 1s for testing
const DEFAULT_SLOT_TTL = 75 * 60_000;
const T0 = 100_000;

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
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
  };
}

describe('QueueProcessor zombie defense (F118 D4)', () => {
  it('keeps the default processing slot TTL independent from disabled CLI timeout', (t) => {
    const savedTimeout = process.env.CLI_TIMEOUT_MS;
    process.env.CLI_TIMEOUT_MS = '0';
    t.after(() => {
      if (savedTimeout === undefined) delete process.env.CLI_TIMEOUT_MS;
      else process.env.CLI_TIMEOUT_MS = savedTimeout;
    });
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);
    const slotKey = 't1:opus';

    /** @type {any} */ (processor).processingSlots.set(slotKey, reservation(T0));
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    t.mock.timers.tick(1);
    assert.equal(
      processor.isThreadBusy('t1'),
      true,
      'disabled CLI timeout must not collapse the processing slot TTL to zero',
    );

    t.mock.timers.tick(DEFAULT_SLOT_TTL);
    assert.equal(processor.isThreadBusy('t1'), false, 'the independent stale-slot backstop must still expire zombies');
  });

  // ── AC-D8: zombie cleanup ──

  it('tryAutoExecute sweeps zombie processingSlot when tracker has no active slot', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });

    // Simulate a zombie: slot added to processingSlots at T0 but never cleaned
    const slotKey = 't1:opus';
    /** @type {any} */ (processor).processingSlots.set(slotKey, reservation(T0));

    // tracker.has() returns false — invocation already expired/completed on tracker side
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    // Advance past threshold
    t.mock.timers.tick(SHORT_TTL + 1);

    // Trigger sweep via tryAutoExecute
    processor.tryAutoExecute('t1');

    // Zombie should be cleaned
    assert.equal(/** @type {any} */ (processor).processingSlots.has(slotKey), false, 'zombie slot should be cleaned');
  });

  it('requeues the exact unbound pre-start row when its zombie slot is swept', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const persisted = [];
    const deps = stubDeps({
      queueCustodyCoordinator: {
        persistEntry: mock.fn(async (entry) => persisted.push(structuredClone(entry))),
      },
    });
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const enqueued = deps.queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 't1',
      userId: 'u1',
      content: 'retry after pre-start ownership vanished',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    }).entry;
    assert.ok(enqueued);
    assert.ok(deps.queue.markProcessingById('t1', enqueued.id));
    /** @type {any} */ (processor).processingSlots.set('t1:opus', reservation(T0, enqueued.id));
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(processor.isThreadBusy('t1'), false);

    const recovered = deps.queue.getEntrySnapshot('t1', 'u1', enqueued.id);
    assert.equal(recovered?.status, 'queued', 'pre-start work must become retryable instead of staying processing');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'queued', 'durable custody must observe the same recovered state');
    const queueUpdates = deps.socketManager.emitToUser.mock.calls.filter(
      (call) => call.arguments[1] === 'queue_updated',
    );
    assert.equal(queueUpdates.length, 1);
    assert.equal(queueUpdates[0].arguments[2].action, 'zombie_prestart_requeued');
    assert.equal(queueUpdates[0].arguments[2].queue[0].status, 'queued');
  });

  it('requeues a bound row when tracker installation never completed', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const enqueued = deps.queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 't1',
      userId: 'u1',
      content: 'record exists but durable preflight never reached startAll',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    }).entry;
    assert.ok(enqueued);
    assert.ok(deps.queue.markProcessingById('t1', enqueued.id));
    /** @type {any} */ (processor).processingSlots.set(
      't1:opus',
      reservation(T0, enqueued.id, 'inv-bound-before-start'),
    );
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(processor.isThreadBusy('t1'), false);
    assert.equal(
      deps.queue.getEntrySnapshot('t1', 'u1', enqueued.id)?.status,
      'queued',
      'an invocation id alone is not proof that provider execution started',
    );
  });

  it('does not requeue a bound row from the TTL sweep without lifecycle terminal proof', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const enqueued = deps.queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 't1',
      userId: 'u1',
      content: 'provider may already own this body',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    }).entry;
    assert.ok(enqueued);
    assert.ok(deps.queue.markProcessingById('t1', enqueued.id));
    /** @type {any} */ (processor).processingSlots.set(
      't1:opus',
      reservation(T0, enqueued.id, 'inv-bound-owner', true),
    );
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(processor.isThreadBusy('t1'), false);
    assert.equal(
      deps.queue.getEntrySnapshot('t1', 'u1', enqueued.id)?.status,
      'processing',
      'bound work requires #2917/#2928 lifecycle proof before queue convergence',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      deps.socketManager.emitToUser.mock.calls.filter((call) => call.arguments[1] === 'queue_updated').length,
      0,
    );
  });

  // ── AC-D9: tracker-alive no-cleanup regression ──

  it('tryAutoExecute does NOT sweep slot when tracker still has active invocation', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });

    const slotKey = 't1:opus';
    /** @type {any} */ (processor).processingSlots.set(slotKey, reservation(T0));

    // tracker.has() returns true — invocation is genuinely still running (just slow)
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    t.mock.timers.tick(SHORT_TTL + 1);
    processor.tryAutoExecute('t1');

    // Slot should be preserved
    assert.ok(/** @type {any} */ (processor).processingSlots.has(slotKey), 'active slot should NOT be cleaned');
  });

  it('zombie sweep does not affect slots within threshold', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });

    // Slot added at current time — still fresh
    const slotKey = 't1:opus';
    /** @type {any} */ (processor).processingSlots.set(slotKey, reservation(T0));
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    // Advance less than threshold
    t.mock.timers.tick(SHORT_TTL - 100);
    processor.tryAutoExecute('t1');

    assert.ok(/** @type {any} */ (processor).processingSlots.has(slotKey), 'fresh slot should NOT be cleaned');
  });

  it('zombie sweep only targets expired slot, preserves other thread slots', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });

    // Zombie slot (old)
    /** @type {any} */ (processor).processingSlots.set('t1:catA', reservation(T0, 'entry-a'));
    // Fresh slot (just started)
    t.mock.timers.tick(SHORT_TTL + 1);
    /** @type {any} */ (processor).processingSlots.set('t1:catB', reservation(Date.now(), 'entry-b'));

    deps.invocationTracker.has.mock.mockImplementation(() => false);

    processor.tryAutoExecute('t1');

    assert.equal(/** @type {any} */ (processor).processingSlots.has('t1:catA'), false, 'zombie catA should be cleaned');
    assert.ok(/** @type {any} */ (processor).processingSlots.has('t1:catB'), 'fresh catB should be preserved');
  });

  // ── P1 fix: processNext path also sweeps zombies ──

  it('processNext (manual path) sweeps zombie before slot check', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });

    // Enqueue an entry so processNext has something to try
    deps.queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 't1',
      userId: 'u1',
      content: 'hello',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    // Simulate zombie slot blocking the same cat
    /** @type {any} */ (processor).processingSlots.set('t1:opus', reservation(T0));
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    t.mock.timers.tick(SHORT_TTL + 1);

    // Without sweep, processNext would return started:false (zombie blocks).
    // With sweep, the zombie is cleared and execution starts.
    const result = await processor.processNext('t1', 'u1');
    assert.ok(result.started, 'processNext should succeed after sweeping zombie');
  });

  it('isThreadBusy ignores stale processingSlot when tracker has no active slot', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });

    /** @type {any} */ (processor).processingSlots.set('t1:opus', reservation(T0));
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(
      processor.isThreadBusy('t1'),
      false,
      'stale processingSlots without a live tracker entry must not permanently mark the thread busy',
    );
    assert.equal(/** @type {any} */ (processor).processingSlots.has('t1:opus'), false, 'zombie slot should be swept');
  });

  it('isThreadBusy preserves stale processingSlot while tracker still has active slot', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });

    /** @type {any} */ (processor).processingSlots.set('t1:opus', reservation(T0));
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(processor.isThreadBusy('t1'), true, 'live tracker entry should keep a slow invocation busy');
    assert.equal(/** @type {any} */ (processor).processingSlots.has('t1:opus'), true, 'live slot should be preserved');
  });
});
