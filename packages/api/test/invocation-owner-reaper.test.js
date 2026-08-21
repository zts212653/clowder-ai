import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { DEFAULT_INVOCATION_SLOT_TTL_MS, InvocationTracker } = await import(
  '../dist/domains/cats/services/agents/invocation/InvocationTracker.js'
);
const { InvocationOwnerReaper } = await import(
  '../dist/domains/cats/services/agents/invocation/InvocationOwnerReaper.js'
);
const { startSerializedInvocationOwnerReaperInterval } = await import(
  '../dist/domains/cats/services/agents/invocation/InvocationOwnerReaperInterval.js'
);

const SHORT_TTL = 1000;
const T0 = 100_000;

function record(id, overrides = {}) {
  return {
    id,
    threadId: 'thread-1',
    userId: 'user-1',
    targetCats: ['codex-sol'],
    status: 'running',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    reconciled: 0,
    alreadyTerminal: 0,
    taskProgressCleared: 0,
    queueConverged: 0,
    errors: 0,
    durationMs: 0,
    ...overrides,
  };
}

function makeReaper({ tracker, records, children = [], lifecycle, reconcileZombie, releaseExactOwner, log } = {}) {
  return new InvocationOwnerReaper({
    invocationTracker: tracker,
    invocationRecordStore: {
      get: mock.fn(async (id) => records?.get(id) ?? null),
    },
    turnExecutionStore: {
      listByParent: mock.fn(async () => children),
    },
    getProviderLifecycle: mock.fn(() => lifecycle),
    reconcileZombie: reconcileZombie ?? mock.fn(async () => result()),
    releaseExactOwner: releaseExactOwner ?? mock.fn(),
    log: log ?? { info: mock.fn(), warn: mock.fn() },
  });
}

describe('InvocationOwnerReaper (F118 post-close)', () => {
  it('does not reap an execution older than 75m when verified provider activity is current', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker();
    const controller = tracker.start('thread-1', 'codex-sol', 'user-1', ['codex-sol'], 'exec-live');
    const records = new Map([['exec-live', record('exec-live')]]);
    const reconcileZombie = mock.fn(async () => result({ reconciled: 1 }));
    t.mock.timers.tick(DEFAULT_INVOCATION_SLOT_TTL_MS + 1);

    const reaper = makeReaper({
      tracker,
      records,
      lifecycle: {
        stage: 'active',
        lastActivityAt: Date.now() - 34_000,
        recoveryAttempt: 0,
        turnStartSent: true,
        turnAccepted: true,
        itemObserved: true,
        toolSurfaceObserved: true,
      },
      reconcileZombie,
    });

    const sweep = await reaper.runOnce();

    assert.equal(sweep.keptActive, 1);
    assert.equal(sweep.reaped, 0);
    assert.equal(reconcileZombie.mock.callCount(), 0);
    assert.equal(tracker.has('thread-1', 'codex-sol'), true);
    assert.equal(controller.signal.aborted, false);
  });

  it('reaps a stale execution only after independent owner evidence proves absence', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const controller = tracker.start('thread-1', 'codex-sol', 'user-1', ['codex-sol'], 'exec-zombie');
    const records = new Map([['exec-zombie', record('exec-zombie')]]);
    const reconcileZombie = mock.fn(async (zombie) => {
      records.get(zombie.invocationId).status = 'failed';
      return result({ reconciled: 1 });
    });
    const releaseExactOwner = mock.fn((threadId, targetCats, executionId) => {
      for (const catId of targetCats) tracker.completeByExecutionId(threadId, catId, executionId);
    });
    t.mock.timers.tick(SHORT_TTL + 1);

    const sweep = await makeReaper({ tracker, records, reconcileZombie, releaseExactOwner }).runOnce();

    assert.equal(sweep.reaped, 1);
    assert.equal(records.get('exec-zombie').status, 'failed');
    assert.equal(reconcileZombie.mock.callCount(), 1);
    assert.equal(releaseExactOwner.mock.callCount(), 1);
    assert.equal(tracker.has('thread-1', 'codex-sol'), false);
    assert.equal(controller.signal.aborted, false, 'an absent provider needs no synthetic abort');
  });

  it('releases an exact stale canceled tombstone after durable terminal reconciliation', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('thread-1', 'codex-sol', 'user-1', ['codex-sol'], 'exec-canceled-zombie');
    tracker.cancelAll('thread-1', 'user-1', 'cancel_all');
    const records = new Map([['exec-canceled-zombie', record('exec-canceled-zombie')]]);
    const reconcileZombie = mock.fn(async () => {
      records.get('exec-canceled-zombie').status = 'failed';
      return result({ reconciled: 1 });
    });
    const releaseExactOwner = mock.fn((threadId, targetCats, executionId) => {
      for (const catId of targetCats) tracker.releaseTerminalByExecutionId(threadId, catId, executionId);
    });
    t.mock.timers.tick(SHORT_TTL + 1);

    const sweep = await makeReaper({ tracker, records, reconcileZombie, releaseExactOwner }).runOnce();

    assert.equal(sweep.reaped, 1);
    assert.equal(releaseExactOwner.mock.callCount(), 1);
    const guard = tracker.guardSessionSeal('thread-1', 'codex-sol');
    assert.equal(guard.acquired, true, 'reconciled canceled owner must no longer fence manual seal');
    guard.release();
  });

  it('releases dynamic A2A slots omitted from the durable invocation target set', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const controller = tracker.startAll('thread-1', ['opus'], 'user-1', 'exec-a2a-zombie');
    assert.ok(controller);
    assert.equal(
      tracker.trackExternalSlot('thread-1', 'codex-sol', controller, 'user-1', ['codex-sol'], 'exec-a2a-zombie'),
      true,
    );
    tracker.cancelAll('thread-1', 'user-1', 'cancel_all');
    const records = new Map([['exec-a2a-zombie', record('exec-a2a-zombie', { targetCats: ['opus'] })]]);
    const reconcileZombie = mock.fn(async () => {
      records.get('exec-a2a-zombie').status = 'failed';
      return result({ reconciled: 1 });
    });
    const releaseExactOwner = mock.fn((threadId, targetCats, executionId) => {
      for (const catId of targetCats) tracker.releaseTerminalByExecutionId(threadId, catId, executionId);
    });
    t.mock.timers.tick(SHORT_TTL + 1);

    const sweep = await makeReaper({ tracker, records, reconcileZombie, releaseExactOwner }).runOnce();

    assert.equal(sweep.reaped, 1);
    assert.deepEqual(
      [...releaseExactOwner.mock.calls[0].arguments[1]].sort(),
      ['codex-sol', 'opus'],
      'durable and dynamically tracked target cats must both be released',
    );
    const opusGuard = tracker.guardSessionSeal('thread-1', 'opus');
    const codexGuard = tracker.guardSessionSeal('thread-1', 'codex-sol');
    assert.equal(opusGuard.acquired, true);
    assert.equal(codexGuard.acquired, true, 'reaped dynamic A2A owner must no longer fence manual seal');
    opusGuard.release();
    codexGuard.release();
  });

  it('reaps a durable zombie even after its process-local tracker projection is absent', async () => {
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const zombieRecord = record('exec-record-only', {
      createdAt: T0,
      executionStartedAt: T0,
    });
    const records = new Map([[zombieRecord.id, zombieRecord]]);
    const reconcileZombie = mock.fn(async () => result({ reconciled: 1 }));
    const releaseExactOwner = mock.fn();
    const reaper = new InvocationOwnerReaper({
      invocationTracker: tracker,
      invocationRecordStore: { get: mock.fn(async (id) => records.get(id) ?? null) },
      turnExecutionStore: { listByParent: mock.fn(async () => []) },
      getProviderLifecycle: () => undefined,
      listRunningRecords: mock.fn(async () => [zombieRecord]),
      reconcileZombie,
      releaseExactOwner,
      ownerLeaseTtlMs: SHORT_TTL,
      now: () => T0 + SHORT_TTL + 1,
      log: { info: mock.fn(), warn: mock.fn() },
    });

    const sweep = await reaper.runOnce();

    assert.equal(sweep.scanned, 1);
    assert.equal(sweep.reaped, 1);
    assert.equal(reconcileZombie.mock.callCount(), 1);
    assert.equal(releaseExactOwner.mock.callCount(), 1);
  });

  it('rechecks exact ownership so an old sweep cannot remove a replacement or another thread', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('thread-1', 'codex-sol', 'user-1', ['codex-sol'], 'exec-old');
    const records = new Map([['exec-old', record('exec-old')]]);
    const reconcileZombie = mock.fn(async () => result({ reconciled: 1 }));
    let replacement;
    t.mock.timers.tick(SHORT_TTL + 1);
    tracker.start('thread-2', 'codex-sol', 'user-1', ['codex-sol'], 'exec-other-thread');
    const reaper = new InvocationOwnerReaper({
      invocationTracker: tracker,
      invocationRecordStore: { get: mock.fn(async (id) => records.get(id) ?? null) },
      turnExecutionStore: {
        listByParent: mock.fn(async () => {
          replacement = tracker.start('thread-1', 'codex-sol', 'user-1', ['codex-sol'], 'exec-replacement');
          return [];
        }),
      },
      getProviderLifecycle: () => undefined,
      reconcileZombie,
      releaseExactOwner: (threadId, targetCats, executionId) => {
        for (const catId of targetCats) tracker.completeByExecutionId(threadId, catId, executionId);
      },
      log: { info: mock.fn(), warn: mock.fn() },
    });

    const sweep = await reaper.runOnce();

    assert.equal(sweep.replacements, 1);
    assert.equal(reconcileZombie.mock.callCount(), 1, 'the old durable record should still converge');
    assert.equal(tracker.getController('thread-1', 'codex-sol'), replacement);
    assert.equal(tracker.getExecutionId('thread-1', 'codex-sol'), 'exec-replacement');
    assert.equal(tracker.getExecutionId('thread-2', 'codex-sol'), 'exec-other-thread');
  });

  it('fails safe when an independent liveness probe is unknown', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('thread-1', 'codex-sol', 'user-1', ['codex-sol'], 'exec-unknown');
    const records = new Map([['exec-unknown', record('exec-unknown')]]);
    const reconcileZombie = mock.fn(async () => result({ reconciled: 1 }));
    const log = { info: mock.fn(), warn: mock.fn() };
    t.mock.timers.tick(SHORT_TTL + 1);
    const reaper = new InvocationOwnerReaper({
      invocationTracker: tracker,
      invocationRecordStore: { get: mock.fn(async (id) => records.get(id) ?? null) },
      turnExecutionStore: { listByParent: mock.fn(async () => Promise.reject(new Error('store unavailable'))) },
      getProviderLifecycle: () => undefined,
      reconcileZombie,
      releaseExactOwner: mock.fn(),
      log,
    });

    const sweep = await reaper.runOnce();

    assert.equal(sweep.deferredUnknown, 1);
    assert.equal(reconcileZombie.mock.callCount(), 0);
    assert.equal(tracker.has('thread-1', 'codex-sol'), true);
    assert.equal(log.warn.mock.callCount(), 1);
  });

  it('serializes interval sweeps so a slow probe cannot overlap itself', async () => {
    let scheduled;
    let releaseFirst;
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const runOnce = mock.fn(async () => first);
    const handle = startSerializedInvocationOwnerReaperInterval({
      reaper: { runOnce },
      intervalMs: 10,
      setIntervalFn: (callback) => {
        scheduled = callback;
        return /** @type {ReturnType<typeof setInterval>} */ ({ fake: true });
      },
    });

    assert.deepEqual(handle, { fake: true });
    scheduled();
    scheduled();
    assert.equal(runOnce.mock.callCount(), 1);

    releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    scheduled();
    assert.equal(runOnce.mock.callCount(), 2);
  });
});
