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
const T0 = 100_000;

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
  // ── AC-D8: zombie cleanup ──

  it('tryAutoExecute sweeps zombie processingSlot when tracker has no active slot', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });

    // Simulate a zombie: slot added to processingSlots at T0 but never cleaned
    const slotKey = 't1:opus';
    /** @type {any} */ (processor).processingSlots.set(slotKey, T0);

    // tracker.has() returns false — invocation already expired/completed on tracker side
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    // Advance past threshold
    t.mock.timers.tick(SHORT_TTL + 1);

    // Trigger sweep via tryAutoExecute
    processor.tryAutoExecute('t1');

    // Zombie should be cleaned
    assert.equal(/** @type {any} */ (processor).processingSlots.has(slotKey), false, 'zombie slot should be cleaned');
  });

  // ── AC-D9: tracker-alive no-cleanup regression ──

  it('tryAutoExecute does NOT sweep slot when tracker still has active invocation', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });

    const slotKey = 't1:opus';
    /** @type {any} */ (processor).processingSlots.set(slotKey, T0);

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
    /** @type {any} */ (processor).processingSlots.set(slotKey, T0);
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
    /** @type {any} */ (processor).processingSlots.set('t1:catA', T0);
    // Fresh slot (just started)
    t.mock.timers.tick(SHORT_TTL + 1);
    /** @type {any} */ (processor).processingSlots.set('t1:catB', Date.now());

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
      threadId: 't1',
      userId: 'u1',
      content: 'hello',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    // Simulate zombie slot blocking the same cat
    /** @type {any} */ (processor).processingSlots.set('t1:opus', T0);
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

    /** @type {any} */ (processor).processingSlots.set('t1:opus', T0);
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

    /** @type {any} */ (processor).processingSlots.set('t1:opus', T0);
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(processor.isThreadBusy('t1'), true, 'live tracker entry should keep a slow invocation busy');
    assert.equal(/** @type {any} */ (processor).processingSlots.has('t1:opus'), true, 'live slot should be preserved');
  });
});
