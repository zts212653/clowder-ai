import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

async function loadModules() {
  const reaper = await import('../dist/domains/cats/services/runtime-session/RuntimeSessionSealReaper.js');
  const store = await import('../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js');
  return { ...reaper, ...store };
}

function metadataFor(sessionId, overrides = {}) {
  return {
    sessionId,
    runtime: 'antigravity-desktop',
    runtimeSessionId: `cascade-${sessionId}`,
    threadId: 'thread-1',
    catId: 'antig-opus',
    userId: 'user-1',
    surface: 'cat-cafe-dispatch',
    identityHistory: [
      {
        catId: 'antig-opus',
        model: 'claude-opus-4-6',
        from: 1000,
        source: 'session_init',
      },
    ],
    lifecycle: {
      state: 'runtime_seal_pending',
      startedAt: 1000,
      lastObservedAt: 2000,
      pendingSince: 2000,
      sealReason: 'model_capacity',
      retryCount: 0,
    },
    ...overrides,
  };
}

function makeSessionSealer(events = []) {
  return {
    requestSeal: mock.fn(async (args) => {
      events.push({ type: 'requestSeal', args });
      return { accepted: true, status: 'sealing', sessionId: args.sessionId };
    }),
    finalize: mock.fn(async (args) => {
      events.push({ type: 'finalize', args });
    }),
    reconcileStuck: async () => 0,
    reconcileAllStuck: async () => 0,
  };
}

describe('RuntimeSessionSealReaper', () => {
  test('scans runtime_seal_pending records, drains, and finalizes successful complete drain', async () => {
    const { RuntimeSessionSealReaper, RuntimeSessionStore } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();
    const events = [];
    const originalUpdateLifecycle = runtimeSessionStore.updateLifecycle.bind(runtimeSessionStore);
    runtimeSessionStore.updateLifecycle = (sessionId, patch) => {
      events.push({ type: 'updateLifecycle', sessionId, patch });
      return originalUpdateLifecycle(sessionId, patch);
    };
    runtimeSessionStore.upsert(metadataFor('session-complete'));
    const sessionSealer = makeSessionSealer(events);
    const drainRuntimeSession = mock.fn(async (record) => ({
      ok: true,
      drainResult: 'complete',
      lastObservedStepCount: record.runtimeSessionId === 'cascade-session-complete' ? 3 : 0,
    }));

    const reaper = new RuntimeSessionSealReaper({
      runtimeSessionStore,
      sessionSealer,
      drainRuntimeSession,
      now: () => 3000,
    });

    const result = await reaper.runOnce();
    const updated = runtimeSessionStore.getBySessionId('session-complete');

    assert.equal(result.scanned, 1);
    assert.equal(result.sealed, 1);
    assert.equal(drainRuntimeSession.mock.callCount(), 1);
    assert.equal(sessionSealer.requestSeal.mock.callCount(), 1);
    const requestSealIndex = events.findIndex((event) => event.type === 'requestSeal');
    const markSealedIndex = events.findIndex(
      (event) => event.type === 'updateLifecycle' && event.patch.state === 'sealed',
    );
    assert.ok(requestSealIndex >= 0, 'must request host session seal');
    assert.ok(markSealedIndex >= 0, 'must mark runtime sealed');
    assert.ok(
      requestSealIndex < markSealedIndex,
      'host session seal must be requested before runtime is marked sealed',
    );
    assert.deepEqual(sessionSealer.requestSeal.mock.calls[0].arguments[0], {
      sessionId: 'session-complete',
      reason: 'model_capacity',
    });
    assert.equal(sessionSealer.finalize.mock.callCount(), 1);
    assert.equal(updated.lifecycle.state, 'sealed');
    assert.equal(updated.lifecycle.drainResult, 'complete');
  });

  test('finalizes already-sealing sessions after a complete runtime drain', async () => {
    const { RuntimeSessionSealReaper, RuntimeSessionStore } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();
    runtimeSessionStore.upsert(metadataFor('session-already-sealing'));
    const sessionSealer = {
      ...makeSessionSealer(),
      requestSeal: mock.fn(async (args) => ({
        accepted: false,
        status: 'sealing',
        sessionId: args.sessionId,
      })),
    };
    const drainRuntimeSession = mock.fn(async () => ({
      ok: true,
      drainResult: 'complete',
      lastObservedStepCount: 2,
    }));

    const reaper = new RuntimeSessionSealReaper({
      runtimeSessionStore,
      sessionSealer,
      drainRuntimeSession,
      now: () => 3500,
    });

    const result = await reaper.runOnce();
    const updated = runtimeSessionStore.getBySessionId('session-already-sealing');

    assert.equal(result.scanned, 1);
    assert.equal(result.sealed, 1);
    assert.equal(sessionSealer.requestSeal.mock.callCount(), 1);
    assert.equal(sessionSealer.finalize.mock.callCount(), 1);
    assert.deepEqual(sessionSealer.finalize.mock.calls[0].arguments[0], {
      sessionId: 'session-already-sealing',
    });
    assert.equal(updated.lifecycle.state, 'sealed');
    assert.equal(updated.lifecycle.drainResult, 'complete');
  });

  test('keeps runtime pending when host seal request is rejected after complete runtime drain', async () => {
    const { RuntimeSessionSealReaper, RuntimeSessionStore } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();
    runtimeSessionStore.upsert(metadataFor('session-rejected'));
    const sessionSealer = {
      ...makeSessionSealer(),
      requestSeal: mock.fn(async () => ({
        accepted: false,
        status: 'active',
        sessionId: 'session-rejected',
      })),
      finalize: mock.fn(async () => {
        throw new Error('finalize must not run when requestSeal is rejected');
      }),
    };
    const drainRuntimeSession = mock.fn(async () => ({
      ok: true,
      drainResult: 'complete',
      lastObservedStepCount: 2,
    }));

    const reaper = new RuntimeSessionSealReaper({
      runtimeSessionStore,
      sessionSealer,
      drainRuntimeSession,
      now: () => 3750,
    });

    const result = await reaper.runOnce();
    const updated = runtimeSessionStore.getBySessionId('session-rejected');

    assert.equal(result.scanned, 1);
    assert.equal(result.sealed, 0);
    assert.equal(result.failed, 1);
    assert.equal(sessionSealer.requestSeal.mock.callCount(), 1);
    assert.equal(sessionSealer.finalize.mock.callCount(), 0);
    assert.equal(updated.lifecycle.state, 'runtime_seal_pending');
    assert.equal(updated.lifecycle.retryCount, 1);
    assert.equal(updated.lifecycle.lastRetryAt, 3750);
    assert.equal(updated.lifecycle.drainResult, 'complete');
    assert.match(updated.lifecycle.lastFailureReason, /not accepted.*active/i);
  });

  test('keeps best-effort failures pending and records retry metadata', async () => {
    const { RuntimeSessionSealReaper, RuntimeSessionStore } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();
    runtimeSessionStore.upsert(metadataFor('session-pending', { lifecycle: { ...metadataFor('x').lifecycle } }));
    const sessionSealer = makeSessionSealer();
    const drainRuntimeSession = mock.fn(async () => ({
      ok: false,
      drainResult: 'best_effort_quiet_window',
      reason: 'cascade still has in-flight operation(s)',
    }));

    const reaper = new RuntimeSessionSealReaper({
      runtimeSessionStore,
      sessionSealer,
      drainRuntimeSession,
      now: () => 4000,
      maxRetries: 3,
    });

    const result = await reaper.runOnce();
    const updated = runtimeSessionStore.getBySessionId('session-pending');

    assert.equal(result.scanned, 1);
    assert.equal(result.pending, 1);
    assert.equal(sessionSealer.requestSeal.mock.callCount(), 0);
    assert.equal(updated.lifecycle.state, 'runtime_seal_pending');
    assert.equal(updated.lifecycle.retryCount, 1);
    assert.equal(updated.lifecycle.lastRetryAt, 4000);
    assert.equal(updated.lifecycle.drainResult, 'best_effort_quiet_window');
    assert.match(updated.lifecycle.lastFailureReason, /in-flight/i);
  });

  test('skips records that reached max retries and leaves them visible as runtime_seal_pending', async () => {
    const { RuntimeSessionSealReaper, RuntimeSessionStore } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();
    runtimeSessionStore.upsert(
      metadataFor('session-maxed', {
        lifecycle: {
          ...metadataFor('x').lifecycle,
          retryCount: 3,
          lastFailureReason: 'still busy',
        },
      }),
    );
    const sessionSealer = makeSessionSealer();
    const drainRuntimeSession = mock.fn(async () => {
      throw new Error('should not drain maxed record');
    });

    const reaper = new RuntimeSessionSealReaper({
      runtimeSessionStore,
      sessionSealer,
      drainRuntimeSession,
      maxRetries: 3,
      now: () => 5000,
    });

    const result = await reaper.runOnce();
    const updated = runtimeSessionStore.getBySessionId('session-maxed');

    assert.equal(result.scanned, 1);
    assert.equal(result.skippedMaxRetries, 1);
    assert.equal(drainRuntimeSession.mock.callCount(), 0);
    assert.equal(sessionSealer.requestSeal.mock.callCount(), 0);
    assert.equal(updated.lifecycle.state, 'runtime_seal_pending');
    assert.equal(updated.lifecycle.retryCount, 3);
  });

  test('runtime disconnected seals with runtime_disconnected only after recording degraded drain evidence', async () => {
    const { RuntimeSessionSealReaper, RuntimeSessionStore } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();
    const events = [];
    const originalUpdateLifecycle = runtimeSessionStore.updateLifecycle.bind(runtimeSessionStore);
    runtimeSessionStore.updateLifecycle = (sessionId, patch) => {
      events.push({ type: 'updateLifecycle', sessionId, patch });
      return originalUpdateLifecycle(sessionId, patch);
    };
    runtimeSessionStore.upsert(metadataFor('session-disconnected'));
    const sessionSealer = makeSessionSealer(events);
    const drainRuntimeSession = mock.fn(async () => ({
      ok: false,
      drainResult: 'skipped_runtime_unreachable',
      reason: 'ECONNREFUSED',
    }));

    const reaper = new RuntimeSessionSealReaper({
      runtimeSessionStore,
      sessionSealer,
      drainRuntimeSession,
      now: () => 6000,
    });

    const result = await reaper.runOnce();
    const updated = runtimeSessionStore.getBySessionId('session-disconnected');
    const firstSealIndex = events.findIndex((event) => event.type === 'requestSeal');
    const evidenceIndex = events.findIndex(
      (event) =>
        event.type === 'updateLifecycle' &&
        event.patch.state === 'runtime_seal_pending' &&
        event.patch.drainResult === 'skipped_runtime_unreachable' &&
        /ECONNREFUSED/.test(event.patch.lastFailureReason),
    );

    assert.equal(result.sealed, 1);
    assert.ok(evidenceIndex >= 0, 'must record degraded drain evidence before force-sealing disconnected runtime');
    assert.ok(evidenceIndex < firstSealIndex, 'degraded drain metadata must be written before requestSeal');
    assert.deepEqual(sessionSealer.requestSeal.mock.calls[0].arguments[0], {
      sessionId: 'session-disconnected',
      reason: 'runtime_disconnected',
    });
    assert.equal(updated.lifecycle.state, 'sealed');
    assert.equal(updated.lifecycle.sealReason, 'runtime_disconnected');
    assert.equal(updated.lifecycle.drainResult, 'skipped_runtime_unreachable');
  });

  test('records retry metadata when processing throws after a complete drain', async () => {
    const { RuntimeSessionSealReaper, RuntimeSessionStore } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();
    runtimeSessionStore.upsert(metadataFor('session-seal-throws'));
    const sessionSealer = {
      ...makeSessionSealer(),
      requestSeal: mock.fn(async () => {
        throw new Error('seal request failed');
      }),
    };
    const drainRuntimeSession = mock.fn(async () => ({
      ok: true,
      drainResult: 'complete',
      lastObservedStepCount: 4,
    }));

    const reaper = new RuntimeSessionSealReaper({
      runtimeSessionStore,
      sessionSealer,
      drainRuntimeSession,
      now: () => 7000,
      maxRetries: 3,
    });

    const result = await reaper.runOnce();
    const updated = runtimeSessionStore.getBySessionId('session-seal-throws');

    assert.equal(result.scanned, 1);
    assert.equal(result.drained, 1);
    assert.equal(result.failed, 1);
    assert.equal(sessionSealer.requestSeal.mock.callCount(), 1);
    assert.equal(updated.lifecycle.state, 'runtime_seal_pending');
    assert.equal(updated.lifecycle.retryCount, 1);
    assert.equal(updated.lifecycle.lastRetryAt, 7000);
    assert.equal(updated.lifecycle.lastObservedAt, 7000);
    assert.equal(updated.lifecycle.drainResult, 'complete');
    assert.match(updated.lifecycle.lastFailureReason, /seal request failed/);
  });

  test('serialized interval skips overlapping runtime seal reaper sweeps', async () => {
    const { startSerializedRuntimeSessionSealReaperInterval } = await loadModules();
    let tick;
    const timer = { unref: mock.fn() };
    const setIntervalFn = mock.fn((callback, intervalMs) => {
      tick = callback;
      assert.equal(intervalMs, 10);
      return timer;
    });
    let releaseFirst;
    const firstRun = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const reaper = {
      runOnce: mock.fn(async () => {
        if (reaper.runOnce.mock.callCount() === 1) return firstRun;
        return { scanned: 0, drained: 0, sealed: 1, pending: 0, skippedMaxRetries: 0, failed: 0 };
      }),
    };

    const handle = startSerializedRuntimeSessionSealReaperInterval({
      runtimeSessionSealReaper: reaper,
      intervalMs: 10,
      setIntervalFn,
    });

    assert.equal(handle, timer);
    tick();
    tick();
    assert.equal(reaper.runOnce.mock.callCount(), 1, 'second tick must not overlap the in-flight sweep');

    releaseFirst({ scanned: 0, drained: 0, sealed: 0, pending: 0, skippedMaxRetries: 0, failed: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    tick();
    assert.equal(reaper.runOnce.mock.callCount(), 2, 'next tick after completion should run a new sweep');
  });
});
