/**
 * F194 Phase B (Bundle) — reconcileZombies cleanup pathway tests.
 *
 * Coverage (AC-B7~B10):
 * - AC-B7: marks zombie record `failed(error='zombie_record_detected')` + clears TaskProgress
 * - AC-B8: read-only: helper not invoked here; cleanup is independent of read path
 * - AC-B9: audit log emitted per zombie + summary at end
 * - AC-B10: idempotent — second call on same zombie is a no-op (state machine guard)
 *
 * F220 Phase 2a (#972) — queue convergence regression tests:
 * - P1-1 (Sol R2): precise entry identity via idempotencyKey — only the zombie's own
 *   queue entry is removed; older user follow-ups dispatched by the winner survive
 * - P1-2 (Sol review): fair dispatch — tryDispatchNext calls cross-user drain
 * - P2-1 (Sol review): convergence failure counted in errors; terminal-path retry safe
 * - P2-3 (Sol review): real adapter tests (InvocationQueue + buildQueueConvergence)
 * - Sol R2 regression: pinned-continuation/older-follow-up scenario cannot delete
 *   legitimate entries dispatched by the winner's fair-drain
 * - Sol maintainer R17 P1: owner-bound slot reservation — immediate convergence and
 *   delayed retry release ONLY the exact stale entry's slot; a replacement that
 *   reclaimed the slot after a TTL sweep survives, and no third dispatch can start
 * - Sol maintainer R17 P2: explicit processingSlotTtlMs in slot tests (no
 *   CLI_TIMEOUT_MS env inheritance) + direct regressions for the a12d1f69f
 *   delayed-retry and late batch-finalizer fences
 * - Cloud R18-R20: all full queue snapshots publish in mutation-time call order
 *   for the same runtime/thread/user scope without blocking independent scopes
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { reconcileZombies } = await import('../dist/domains/cats/services/agents/invocation/reconcileZombies.js');
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { emitQueueUpdated } = await import('../dist/utils/queue-enrichment.js');

function makeZombie({ invocationId, catId = 'opus', recordUpdatedAt = Date.now() - 700_000 }) {
  return {
    invocationId,
    catId,
    recordStatus: 'running',
    recordUpdatedAt,
    reason: 'no_tracker_no_fresh_draft_age_exceeded',
  };
}

function makeTaskProgressStore() {
  const cleared = [];
  return {
    cleared,
    deleteSnapshot: async (threadId, catId) => {
      cleared.push({ threadId, catId });
    },
    deleteSnapshotIfOwner: async (threadId, catId) => {
      cleared.push({ threadId, catId });
      return true;
    },
  };
}

function makeRecordingLogger() {
  const records = { info: [], warn: [], error: [] };
  return {
    records,
    info: (...args) => records.info.push(args),
    warn: (...args) => records.warn.push(args),
    error: (...args) => records.error.push(args),
  };
}

/** Build a minimal QueueProcessor for adapter tests. */
function buildQueueProcessorWithQueue(queue, overrides = {}) {
  const log = makeRecordingLogger();
  const dispatchCalls = [];
  const socketEmits = [];

  const socketManager = overrides.socketManager ?? {
    broadcastAgentMessage: () => {},
    broadcastToRoom: () => {},
    emitToUser: (userId, event, data) => socketEmits.push({ userId, event, data }),
  };
  const messageStore = overrides.messageStore ?? {
    list: () => [],
    get: () => null,
    getById: async () => null,
    create: async () => ({ id: 'm1' }),
    update: async () => {},
    delete: async () => {},
  };

  const qp = new QueueProcessor({
    queue,
    invocationTracker: {
      start: () => ({}),
      startAll: () => ({}),
      complete: () => {},
      completeAll: () => {},
      has: () => false,
    },
    invocationRecordStore: {
      create: async () => ({ outcome: 'created', invocationId: 'test-inv' }),
      update: async () => {},
    },
    router: {
      routeExecution: async () => ({ status: 'succeeded', response: '' }),
    },
    socketManager,
    messageStore,
    log,
  });

  // Spy on tryExecuteNextAcrossUsers and tryAutoExecute
  const origTryExecAcrossUsers = qp.tryExecuteNextAcrossUsers?.bind(qp);
  const origTryAutoExecute = qp.tryAutoExecute?.bind(qp);

  return { qp, log, dispatchCalls, socketEmits };
}

/** Build a QueueProcessor whose routeExecution can be held open and settled on demand.
 *  Each routeExecution call registers a resolver in holdResolvers (index = dispatch order).
 *  opts are forwarded to the QueueProcessor constructor (e.g. explicit processingSlotTtlMs
 *  so tests never inherit the environment-dependent CLI_TIMEOUT_MS default). */
function buildHoldableQueueProcessor(queue, holdResolvers, opts) {
  const log = makeRecordingLogger();
  const qp = new QueueProcessor(
    {
      queue,
      invocationTracker: {
        start: () => ({ signal: new AbortController().signal }),
        startAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
        getController: () => undefined,
      },
      invocationRecordStore: {
        create: async () => ({ outcome: 'created', invocationId: `inv-${holdResolvers.length}` }),
        update: async () => {},
      },
      router: {
        routeExecution: async function* () {
          // Hold open until manually resolved — simulates long-running execution
          await new Promise((resolve) => holdResolvers.push(resolve));
        },
        ackCollectedCursors: async () => {},
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        list: () => [],
        get: () => null,
        create: async () => ({ id: 'm1' }),
        update: async () => {},
        delete: async () => {},
        markDelivered: async () => null,
      },
      log,
    },
    opts,
  );
  return { qp, log };
}

describe('F194 reconcileZombies — cleanup pathway', () => {
  it('AC-B7: marks zombie record failed + clears TaskProgress + emits audit log', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k1',
    });
    store.update(created.invocationId, { status: 'running' });
    const taskProgressStore = makeTaskProgressStore();
    const logger = makeRecordingLogger();

    const zombie = makeZombie({ invocationId: created.invocationId });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore,
      log: logger,
    });

    assert.equal(result.reconciled, 1);
    assert.equal(result.alreadyTerminal, 0);
    assert.equal(result.taskProgressCleared, 1);
    assert.equal(result.errors, 0);

    // Record now in failed status with the zombie error
    const updated = store.get(created.invocationId);
    assert.equal(updated.status, 'failed');
    assert.equal(updated.error, 'zombie_record_detected');

    // TaskProgress snapshot cleared
    assert.deepEqual(taskProgressStore.cleared, [{ threadId: 't1', catId: 'opus' }]);

    // Audit log emitted
    const auditLine = logger.records.info.find((args) => args[1]?.includes?.('marked failed'));
    assert.ok(auditLine, 'must emit "marked failed" audit log');
    // log signature is (obj, msg); after the swap, args[0] is the structured obj
    assert.equal(auditLine[0].invocationId, created.invocationId);
    assert.equal(auditLine[0].reason, 'no_tracker_no_fresh_draft_age_exceeded');

    // Summary log emitted
    const summary = logger.records.info.find((args) => args[1]?.includes?.('sweep complete'));
    assert.ok(summary, 'must emit summary log');
  });

  it('AC-B10: idempotent — second call on same zombie is a no-op', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k-idem',
    });
    store.update(created.invocationId, { status: 'running' });

    const zombie = makeZombie({ invocationId: created.invocationId });
    const deps = {
      invocationRecordStore: store,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
    };

    // First call: marks failed
    const r1 = await reconcileZombies([zombie], deps);
    assert.equal(r1.reconciled, 1);
    assert.equal(r1.alreadyTerminal, 0);

    // Second call: state machine guard rejects 'failed' → 'failed' self-transition,
    // and CAS expectedStatus='running' fails (current is now 'failed') → update returns null
    const r2 = await reconcileZombies([zombie], deps);
    assert.equal(r2.reconciled, 0, 'second call must not double-write');
    assert.equal(r2.alreadyTerminal, 1, 'second call must count as already-terminal');
  });

  it('cloud R15 P1: terminal record + transient TaskProgress failure → retry cleanup on next reconcile', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'r15-p1-key',
    });
    // Drive the record to a terminal state (failed) BEFORE reconcileZombies sees it
    store.update(created.invocationId, { status: 'running' });
    store.update(created.invocationId, { status: 'failed', error: 'concurrent-zombie-detected' });

    const taskProgressStore = makeTaskProgressStore();
    const logger = makeRecordingLogger();

    const zombie = makeZombie({ invocationId: created.invocationId });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore,
      log: logger,
    });

    // CAS update returns null (record is already failed, expectedStatus='running' mismatches)
    assert.equal(result.reconciled, 0, 'no new reconcile (record already terminal)');
    assert.equal(result.alreadyTerminal, 1, 'counted as already-terminal');
    // Fix: deleteSnapshot still attempted for terminal records → cleanup happens
    assert.equal(result.taskProgressCleared, 1, 'TaskProgress cleared even when CAS fails on terminal record');
    assert.deepEqual(taskProgressStore.cleared, [{ threadId: 't1', catId: 'opus' }]);
  });

  it('cloud R17 P2: CAS update returns null but record still running → counted as transient error, not alreadyTerminal', async () => {
    const phantomZombieRecord = {
      id: 'inv-phantom',
      threadId: 't1',
      userId: 'u1',
      userMessageId: null,
      targetCats: ['opus'],
      intent: 'execute',
      status: 'running',
      idempotencyKey: 'k-phantom',
      createdAt: Date.now() - 1_000_000,
      updatedAt: Date.now() - 1_000_000,
    };
    const stubStore = {
      get: async () => phantomZombieRecord,
      update: async () => null, // simulate CAS-drift retry exhaustion
    };
    const taskProgressStore = makeTaskProgressStore();
    const logger = makeRecordingLogger();

    const result = await reconcileZombies([makeZombie({ invocationId: 'inv-phantom' })], {
      invocationRecordStore: stubStore,
      taskProgressStore,
      log: logger,
    });

    assert.equal(result.reconciled, 0, 'no reconcile (CAS failed)');
    assert.equal(result.alreadyTerminal, 0, 'NOT counted as terminal — record still alive');
    assert.equal(result.errors, 1, 'counted as transient error so monitors can flag');
    assert.equal(result.taskProgressCleared, 0, 'no cleanup for non-terminal record');
    // Warn log emitted
    const warnLog = logger.records.warn.find((args) => args[1]?.includes?.('still alive'));
    assert.ok(warnLog, 'must emit transient-failure warning');
  });

  it('cloud R15 P1: missing record → no deleteSnapshot attempt (avoid spurious cleanup)', async () => {
    const store = new InvocationRecordStore();
    const taskProgressStore = makeTaskProgressStore();
    const logger = makeRecordingLogger();

    const zombie = makeZombie({ invocationId: 'inv-truly-gone' });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore,
      log: logger,
    });

    assert.equal(result.reconciled, 0);
    assert.equal(result.alreadyTerminal, 1);
    assert.equal(result.taskProgressCleared, 0, 'no deleteSnapshot for missing record');
    assert.equal(taskProgressStore.cleared.length, 0);
  });

  it('AC-B7: handles missing record gracefully (idempotent no-op)', async () => {
    const store = new InvocationRecordStore();
    const taskProgressStore = makeTaskProgressStore();
    const logger = makeRecordingLogger();

    const zombie = makeZombie({ invocationId: 'inv-never-existed' });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore,
      log: logger,
    });

    assert.equal(result.reconciled, 0);
    assert.equal(result.alreadyTerminal, 1);
    assert.equal(result.errors, 0);
    assert.equal(taskProgressStore.cleared.length, 0);
  });

  it('AC-B7: handles batch of mixed zombies (some live → reconciled, some terminal → skipped)', async () => {
    const store = new InvocationRecordStore();
    const r1 = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'a',
    });
    const r2 = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['gpt52'],
      intent: 'execute',
      idempotencyKey: 'b',
    });
    store.update(r1.invocationId, { status: 'running' });
    store.update(r2.invocationId, { status: 'running' });
    store.update(r2.invocationId, { status: 'succeeded' }); // r2 already terminal

    const zombies = [
      makeZombie({ invocationId: r1.invocationId }),
      makeZombie({ invocationId: r2.invocationId, catId: 'gpt52' }),
    ];
    const taskProgressStore = makeTaskProgressStore();
    const result = await reconcileZombies(zombies, {
      invocationRecordStore: store,
      taskProgressStore,
      log: makeRecordingLogger(),
    });

    assert.equal(result.reconciled, 1, 'r1 (running) reconciled');
    assert.equal(result.alreadyTerminal, 1, 'r2 (already succeeded) skipped');
    // Cloud R15 P1: terminal records also trigger redundant cleanup (defensive against
    // concurrent reconciles where the winner's deleteSnapshot might have failed transiently).
    // Both r1 (newly failed) and r2 (already succeeded) get TaskProgress cleared.
    assert.equal(result.taskProgressCleared, 2, 'both r1 (new) and r2 (terminal redundancy) cleared');
    assert.equal(result.errors, 0);
  });

  it('AC-B7: TaskProgress error does not propagate (cleanup is best-effort)', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k',
    });
    store.update(created.invocationId, { status: 'running' });
    const failingTaskStore = {
      deleteSnapshot: async () => {
        throw new Error('redis down');
      },
    };
    const logger = makeRecordingLogger();

    const result = await reconcileZombies([makeZombie({ invocationId: created.invocationId })], {
      invocationRecordStore: store,
      taskProgressStore: failingTaskStore,
      log: logger,
    });

    // Record is still marked failed even though TaskProgress clearing fails
    assert.equal(result.reconciled, 1);
    assert.equal(result.errors, 1);
    assert.equal(result.taskProgressCleared, 0);
    assert.equal(store.get(created.invocationId).status, 'failed');

    // Error logged
    const errorLog = logger.records.warn.find((args) => args[1]?.includes?.('failed to clear TaskProgress'));
    assert.ok(errorLog, 'must log TaskProgress error');
  });

  it('AC-B7: empty zombies list returns clean result + no log spam', async () => {
    const logger = makeRecordingLogger();
    const result = await reconcileZombies([], {
      invocationRecordStore: new InvocationRecordStore(),
      taskProgressStore: makeTaskProgressStore(),
      log: logger,
    });

    assert.equal(result.reconciled, 0);
    assert.equal(result.alreadyTerminal, 0);
    assert.equal(result.errors, 0);
    // No summary log when zombies list was empty
    const summary = logger.records.info.find((args) => args[1]?.includes?.('sweep complete'));
    assert.equal(summary, undefined, 'no summary for empty input');
  });
});

// ── F220 Phase 2a: queue convergence — mock-based interface tests ──

describe('F220 Phase 2a: reconcileZombies + QueueConvergence (mock interface)', () => {
  it('#972: reconcileZombies passes raw idempotencyKey to queueConvergence (Sol R3)', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'queue-stale-entry-1',
    });
    store.update(created.invocationId, { status: 'running' });

    // Track queueConvergence calls
    const convergenceCalls = [];
    const queueConvergence = {
      removeStaleProcessing: (threadId, catId, userId, idempotencyKey) => {
        convergenceCalls.push({ op: 'removeStaleProcessing', threadId, catId, userId, idempotencyKey });
        return { removed: true, entryId: 'stale-entry-1', primaryCatId: 'opus' };
      },
      releaseSlot: (threadId, catId) => {
        convergenceCalls.push({ op: 'releaseSlot', threadId, catId });
      },
      tryDispatchNext: (threadId, catId) => {
        convergenceCalls.push({ op: 'tryDispatchNext', threadId, catId });
      },
    };

    const zombie = makeZombie({ invocationId: created.invocationId });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      queueConvergence,
    });

    assert.equal(result.reconciled, 1);
    assert.equal(result.errors, 0);
    assert.equal(convergenceCalls.length, 3, 'removeStaleProcessing + releaseSlot + tryDispatchNext');
    const removeCall = convergenceCalls.find((c) => c.op === 'removeStaleProcessing');
    assert.ok(removeCall, 'must call removeStaleProcessing');
    assert.equal(removeCall.threadId, 't1');
    assert.equal(removeCall.catId, 'opus');
    assert.equal(removeCall.userId, 'u1', 'must pass userId for user-scoped lookup');
    // Sol R3: raw idempotencyKey passed directly — adapter parses it
    assert.equal(removeCall.idempotencyKey, 'queue-stale-entry-1', 'must pass raw idempotencyKey');
    const dispatchCall = convergenceCalls.find((c) => c.op === 'tryDispatchNext');
    assert.ok(dispatchCall, 'must kick queue after slot release');
    assert.equal(dispatchCall.catId, 'opus', 'tryDispatchNext must receive catId for fair drain');
  });

  it('#972: connector-sourced zombie passes connector idempotencyKey (Sol R3 P2)', async () => {
    // Connector-sourced invocations use idempotencyKey = connector-${messageId}.
    // The raw key is passed to the adapter which parses it for connector matching.
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'connector-msg-123',
    });
    store.update(created.invocationId, { status: 'running' });

    const convergenceCalls = [];
    const queueConvergence = {
      removeStaleProcessing: (threadId, catId, userId, idempotencyKey) => {
        convergenceCalls.push({ op: 'removeStaleProcessing', idempotencyKey });
        return { removed: true, entryId: 'conn-entry-1', primaryCatId: 'opus' };
      },
      releaseSlot: (threadId, catId) => convergenceCalls.push({ op: 'releaseSlot', threadId, catId }),
      tryDispatchNext: (threadId, catId) => convergenceCalls.push({ op: 'tryDispatchNext', threadId, catId }),
    };

    const zombie = makeZombie({ invocationId: created.invocationId });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      queueConvergence,
    });

    assert.equal(result.reconciled, 1);
    assert.equal(result.errors, 0);
    const removeCall = convergenceCalls.find((c) => c.op === 'removeStaleProcessing');
    assert.ok(removeCall);
    // Sol R3 P2: connector key now passed through for adapter-side matching
    assert.equal(removeCall.idempotencyKey, 'connector-msg-123', 'connector idempotencyKey passed to adapter');
    // Since mock returns removed=true, releaseSlot + dispatch should fire
    assert.equal(convergenceCalls.filter((c) => c.op === 'releaseSlot').length, 1);
    assert.equal(convergenceCalls.filter((c) => c.op === 'tryDispatchNext').length, 1);
  });

  it('#972: terminal-path convergence runs for zombie-terminalized records (P2-1)', async () => {
    // Record terminalized by zombie reconciliation (error='zombie_record_detected').
    // Terminal-path convergence SHOULD run — the normal .then() path is dead.
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'queue-stale-from-terminal',
    });
    store.update(created.invocationId, { status: 'running' });
    store.update(created.invocationId, { status: 'failed', error: 'zombie_record_detected' });

    const convergenceCalls = [];
    const queueConvergence = {
      removeStaleProcessing: (threadId, catId, userId, idempotencyKey) => {
        convergenceCalls.push({ op: 'removeStaleProcessing', threadId, catId, userId, idempotencyKey });
        return { removed: true, entryId: 'stale-from-terminal', primaryCatId: 'codex' };
      },
      releaseSlot: (threadId, catId) => {
        convergenceCalls.push({ op: 'releaseSlot', threadId, catId });
      },
      tryDispatchNext: (threadId, catId) => {
        convergenceCalls.push({ op: 'tryDispatchNext', threadId, catId });
      },
    };

    const zombie = makeZombie({ invocationId: created.invocationId, catId: 'codex' });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      queueConvergence,
    });

    assert.equal(result.alreadyTerminal, 1);
    assert.ok(convergenceCalls.length > 0, 'convergence must be attempted for zombie-terminalized record');
    const removeCall = convergenceCalls.find((c) => c.op === 'removeStaleProcessing');
    assert.ok(removeCall, 'must call removeStaleProcessing');
    assert.equal(removeCall.catId, 'codex');
    assert.equal(removeCall.idempotencyKey, 'queue-stale-from-terminal', 'raw idempotencyKey passed');
  });

  it('#972: terminal-path convergence SKIPPED for normal completion (codex R6 P2 slot mutex)', async () => {
    // Record terminalized by normal execution (succeeded). The normal executeEntry
    // .then() cleanup handles slot release + dispatch. Running convergence alongside
    // it would risk double-releasing the processingSlot mutex.
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'queue-normal-complete',
    });
    store.update(created.invocationId, { status: 'running' });
    store.update(created.invocationId, { status: 'succeeded' });

    const convergenceCalls = [];
    const queueConvergence = {
      removeStaleProcessing: (threadId, catId, userId, idempotencyKey) => {
        convergenceCalls.push({ op: 'removeStaleProcessing' });
        return { removed: true, entryId: 'should-not-reach', primaryCatId: 'codex' };
      },
      releaseSlot: () => convergenceCalls.push({ op: 'releaseSlot' }),
      tryDispatchNext: () => convergenceCalls.push({ op: 'tryDispatchNext' }),
    };

    const zombie = makeZombie({ invocationId: created.invocationId, catId: 'codex' });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      queueConvergence,
    });

    assert.equal(result.alreadyTerminal, 1);
    assert.equal(convergenceCalls.length, 0, 'convergence must NOT run for normal completion (slot mutex safety)');
    assert.equal(result.errors, 0, 'no errors — skipping is intentional');
  });

  it('#972: convergence failure counted as error + scheduleRetry called (Sol R3 P2)', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'queue-conv-fail-entry',
    });
    store.update(created.invocationId, { status: 'running' });

    const retryCalls = [];
    const queueConvergence = {
      removeStaleProcessing: () => {
        throw new Error('queue store unavailable');
      },
      releaseSlot: () => {},
      tryDispatchNext: () => {},
      scheduleRetry: (threadId, catId, userId, idempotencyKey) => {
        retryCalls.push({ threadId, catId, userId, idempotencyKey });
      },
    };

    const logger = makeRecordingLogger();
    const zombie = makeZombie({ invocationId: created.invocationId });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore: makeTaskProgressStore(),
      log: logger,
      queueConvergence,
    });

    // Zombie still reconciled despite queue convergence failure
    assert.equal(result.reconciled, 1);
    assert.equal(store.get(created.invocationId).status, 'failed');
    // P2-1: convergence failure COUNTED in errors (not silently swallowed)
    assert.equal(result.errors, 1, 'convergence failure must increment errors');
    // Sol R3 P2: scheduleRetry called with the idempotencyKey
    assert.equal(retryCalls.length, 1, 'scheduleRetry must be called on convergence failure');
    assert.equal(retryCalls[0].threadId, 't1');
    assert.equal(retryCalls[0].catId, 'opus');
    assert.equal(retryCalls[0].idempotencyKey, 'queue-conv-fail-entry');
    // Error logged
    const warnLog = logger.records.warn.find((args) => args[1]?.includes?.('queue convergence'));
    assert.ok(warnLog, 'must log queue convergence failure');
  });

  it('#972: removeStaleProcessing returns removed=false → no releaseSlot/dispatch', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'queue-noop-entry',
    });
    store.update(created.invocationId, { status: 'running' });

    const convergenceCalls = [];
    const queueConvergence = {
      removeStaleProcessing: (threadId, catId, userId, idempotencyKey) => {
        convergenceCalls.push({ op: 'removeStaleProcessing', threadId, catId, userId, idempotencyKey });
        return { removed: false }; // no stale entry found
      },
      releaseSlot: () => convergenceCalls.push({ op: 'releaseSlot' }),
      tryDispatchNext: () => convergenceCalls.push({ op: 'tryDispatchNext' }),
    };

    const zombie = makeZombie({ invocationId: created.invocationId });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      queueConvergence,
    });

    assert.equal(result.reconciled, 1);
    assert.equal(result.errors, 0);
    // removeStaleProcessing called but returned false → no further actions
    assert.equal(convergenceCalls.filter((c) => c.op === 'removeStaleProcessing').length, 1);
    assert.equal(
      convergenceCalls.filter((c) => c.op === 'releaseSlot').length,
      0,
      'no releaseSlot when nothing removed',
    );
    assert.equal(
      convergenceCalls.filter((c) => c.op === 'tryDispatchNext').length,
      0,
      'no tryDispatchNext when nothing removed',
    );
  });
});

// ── F220 Phase 2a: real adapter tests (P2-3 Sol review) ──
// These exercise the actual buildQueueConvergence() adapter against a real InvocationQueue,
// verifying precise entry identity and dispatch semantics — not just mock callback invocation.

describe('F220 Phase 2a: buildQueueConvergence real adapter (Sol P2-3)', () => {
  it("P1-1 (Sol R2): precise entry identity — only removes the zombie's own entry, not same-cat entries", async () => {
    // Scenario: two processing entries for the same cat. removeStaleProcessing with
    // zombieEntryId must only remove the EXACT entry by ID, not the other one.
    const queue = new InvocationQueue();
    const { qp } = buildQueueProcessorWithQueue(queue);

    // Enqueue zombie's entry
    const zombieResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'zombie @codex message',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    assert.equal(zombieResult.outcome, 'enqueued');
    const zombieEntryId = zombieResult.entry.id;

    // Enqueue a live entry for the same cat (legitimate, dispatched by winner)
    const liveResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'live @codex follow-up',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    assert.equal(liveResult.outcome, 'enqueued');
    const liveEntryId = liveResult.entry.id;

    // Mark both as processing
    queue.markProcessingById('t1', zombieEntryId);
    queue.markProcessingById('t1', liveEntryId);

    const beforeList = queue.list('t1', 'u1');
    const processingBefore = beforeList.filter((e) => e.status === 'processing');
    assert.equal(processingBefore.length, 2, 'two processing entries before');

    // Call adapter with idempotencyKey format
    const adapter = qp.buildQueueConvergence();
    const result = adapter.removeStaleProcessing('t1', 'codex', 'u1', `queue-${zombieEntryId}`);

    assert.equal(result.removed, true, 'zombie entry must be removed');
    assert.equal(result.entryId, zombieEntryId, 'must remove the zombie entry specifically');

    // Live entry must survive — this is the core Sol R2 P1-1 requirement
    const afterList = queue.list('t1', 'u1');
    const processingAfter = afterList.filter((e) => e.status === 'processing');
    assert.equal(processingAfter.length, 1, 'only one processing entry remains');
    assert.equal(processingAfter[0].id, liveEntryId, 'surviving entry must be the live one');
  });

  it('#972: batch siblings rolled back during zombie convergence (codex R10 P1)', async () => {
    // Scenario: executeEntry batched 2 sibling user messages (same targetCats + intent).
    // The primary becomes a zombie. removeStaleProcessing removes the primary and
    // rolls back siblings (batchParentId === primary.id) to 'queued' so they retry.
    const queue = new InvocationQueue();
    const { qp } = buildQueueProcessorWithQueue(queue);

    // Enqueue primary entry
    const primaryResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: '@codex first message',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const primaryId = primaryResult.entry.id;
    queue.markProcessingById('t1', primaryId);

    // Enqueue two sibling entries (simulating collectUserBatch)
    const sib1Result = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: '@codex second message',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const sib1Id = sib1Result.entry.id;
    // Mark processing with batchParentId = primary entry ID (as executeEntry does)
    queue.markProcessingById('t1', sib1Id, primaryId);

    const sib2Result = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: '@codex third message',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const sib2Id = sib2Result.entry.id;
    queue.markProcessingById('t1', sib2Id, primaryId);

    // Verify: 3 processing entries
    const before = queue.list('t1', 'u1');
    assert.equal(before.filter((e) => e.status === 'processing').length, 3, '3 processing before');

    // Call adapter — remove primary entry
    const adapter = qp.buildQueueConvergence();
    const result = adapter.removeStaleProcessing('t1', 'codex', 'u1', `queue-${primaryId}`);

    assert.equal(result.removed, true, 'primary removed');
    assert.equal(result.entryId, primaryId);
    assert.deepEqual(result.rolledBackSiblings.sort(), [sib1Id, sib2Id].sort(), 'both siblings rolled back');

    // Verify: primary gone, siblings back to 'queued'
    const after = queue.list('t1', 'u1');
    assert.equal(after.filter((e) => e.id === primaryId).length, 0, 'primary entry removed');
    const sib1After = after.find((e) => e.id === sib1Id);
    const sib2After = after.find((e) => e.id === sib2Id);
    assert.equal(sib1After.status, 'queued', 'sibling 1 rolled back to queued');
    assert.equal(sib2After.status, 'queued', 'sibling 2 rolled back to queued');
  });

  it('#972: batch sibling rollback does NOT affect non-sibling processing entries', async () => {
    // Ensure that processing entries without batchParentId (independently dispatched)
    // are NOT rolled back — only entries with matching batchParentId are affected.
    const queue = new InvocationQueue();
    const { qp } = buildQueueProcessorWithQueue(queue);

    // Primary zombie entry
    const primaryResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: '@codex zombie message',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const primaryId = primaryResult.entry.id;
    queue.markProcessingById('t1', primaryId);

    // Independent live entry (no batchParentId — dispatched by winner)
    const liveResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: '@codex live follow-up',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const liveId = liveResult.entry.id;
    queue.markProcessingById('t1', liveId); // No batchParentId

    const adapter = qp.buildQueueConvergence();
    const result = adapter.removeStaleProcessing('t1', 'codex', 'u1', `queue-${primaryId}`);

    assert.equal(result.removed, true);
    assert.deepEqual(result.rolledBackSiblings, [], 'no siblings rolled back');

    // Live entry must remain processing
    const after = queue.list('t1', 'u1');
    const liveAfter = after.find((e) => e.id === liveId);
    assert.equal(liveAfter.status, 'processing', 'independent entry stays processing');
  });

  it('P1-1: no idempotencyKey → removed=false (safe default)', async () => {
    const queue = new InvocationQueue();
    const { qp } = buildQueueProcessorWithQueue(queue);

    const enqResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: '@codex',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    queue.markProcessingById('t1', enqResult.entry.id);

    const adapter = qp.buildQueueConvergence();
    const result = adapter.removeStaleProcessing('t1', 'codex', 'u1', undefined);

    assert.equal(result.removed, false, 'must not remove anything without idempotencyKey');
    const entries = queue.list('t1', 'u1');
    assert.equal(entries.length, 1, 'entry must survive');
    assert.equal(entries[0].status, 'processing');
  });

  it('P1-1: wrong entry ID in idempotencyKey → removed=false', async () => {
    const queue = new InvocationQueue();
    const { qp } = buildQueueProcessorWithQueue(queue);

    const enqResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: '@codex',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    queue.markProcessingById('t1', enqResult.entry.id);

    const adapter = qp.buildQueueConvergence();
    const result = adapter.removeStaleProcessing('t1', 'codex', 'u1', 'queue-nonexistent-id');

    assert.equal(result.removed, false, 'must not remove when entry ID does not match');
    const entries = queue.list('t1', 'u1');
    assert.equal(entries.length, 1, 'entry must survive');
  });

  it('Sol R3 P2 connector: adapter matches connector-${messageId} by entry.messageId', async () => {
    // Connector-sourced entries use idempotencyKey = connector-${messageId}.
    // The adapter must parse this and match by entry.messageId.
    const queue = new InvocationQueue();
    const { qp } = buildQueueProcessorWithQueue(queue);

    const connResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'connector message',
      source: 'connector',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
      messageId: 'msg-abc-123',
    });
    assert.equal(connResult.outcome, 'enqueued');
    queue.markProcessingById('t1', connResult.entry.id);

    const adapter = qp.buildQueueConvergence();
    const result = adapter.removeStaleProcessing('t1', 'codex', 'u1', 'connector-msg-abc-123');

    assert.equal(result.removed, true, 'connector entry must be removed via messageId match');
    assert.equal(result.entryId, connResult.entry.id);
    const entries = queue.list('t1', 'u1');
    assert.equal(entries.length, 0, 'connector entry removed');
  });

  it('P1-2: tryDispatchNext calls cross-user fair drain (not just autoExecute)', async () => {
    // Verify that tryDispatchNext invokes tryExecuteNextAcrossUsers (which handles
    // user/connector entries) in addition to tryAutoExecute.
    const queue = new InvocationQueue();
    const log = makeRecordingLogger();
    const methodsCalled = [];

    const qp = new QueueProcessor({
      queue,
      invocationTracker: {
        start: () => ({}),
        startAll: () => ({}),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: async () => ({ outcome: 'created', invocationId: 'test-inv' }),
        update: async () => {},
      },
      router: {
        routeExecution: async () => ({ status: 'succeeded', response: '' }),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        list: () => [],
        get: () => null,
        create: async () => ({ id: 'm1' }),
        update: async () => {},
        delete: async () => {},
      },
      log,
    });

    // Intercept both dispatch methods to track calls (Sol P3: actually assert the call)
    qp.tryExecuteNextAcrossUsers = async (...args) => {
      methodsCalled.push({ method: 'tryExecuteNextAcrossUsers', args });
    };
    qp.tryAutoExecute = async (...args) => {
      methodsCalled.push({ method: 'tryAutoExecute', args });
    };

    const adapter = qp.buildQueueConvergence();
    adapter.tryDispatchNext('t1', 'codex');
    await new Promise((r) => setTimeout(r, 50));

    // Sol P3: both dispatch methods must be called in order
    assert.equal(methodsCalled.length, 2, 'both tryExecuteNextAcrossUsers and tryAutoExecute must be called');
    assert.equal(methodsCalled[0].method, 'tryExecuteNextAcrossUsers', 'fair drain called first');
    assert.deepEqual(methodsCalled[0].args, ['t1', 'codex'], 'fair drain receives threadId + catId');
    assert.equal(methodsCalled[1].method, 'tryAutoExecute', 'autoExecute scan called second');
    assert.deepEqual(methodsCalled[1].args, ['t1'], 'autoExecute receives threadId');
  });

  it('P2-1: full convergence pipeline — zombie reconcile removes stale + kicks dispatch', async () => {
    // End-to-end: create zombie invocation record, stale queue entry, and queued user entry.
    // After reconcileZombies, the stale entry is removed and the queued entry becomes
    // eligible for dispatch. This is the core #972 AC regression.
    //
    // Key: the invocation record's idempotencyKey = queue-${staleEntryId} provides
    // the precise identity link back to the queue entry.
    const invRecordStore = new InvocationRecordStore();
    const queue = new InvocationQueue();
    const { qp, log } = buildQueueProcessorWithQueue(queue);

    // 1. Enqueue the zombie's queue entry FIRST (to get the entry ID)
    const staleResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'stale @codex from opus A2A',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      priority: 'normal',
    });
    const staleEntryId = staleResult.entry.id;
    queue.markProcessingById('t1', staleEntryId);

    // 2. Create the zombie's invocation record with queue-${entry.id} idempotencyKey
    // (this mirrors what QueueProcessor.executeEntry does at line 961)
    const zombieInv = invRecordStore.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: `queue-${staleEntryId}`,
    });
    invRecordStore.update(zombieInv.invocationId, { status: 'running' });

    // 3. Enqueue the user's @codex message (blocked behind stale slot)
    const userResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'user @codex message',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    assert.equal(userResult.outcome, 'enqueued');
    assert.equal(userResult.entry.status, 'queued');

    // Verify: 1 processing + 1 queued
    const beforeEntries = queue.list('t1', 'u1');
    assert.equal(beforeEntries.filter((e) => e.status === 'processing').length, 1);
    assert.equal(beforeEntries.filter((e) => e.status === 'queued').length, 1);

    // 4. Build convergence adapter and run reconcileZombies
    const adapter = qp.buildQueueConvergence();
    const zombie = makeZombie({ invocationId: zombieInv.invocationId, catId: 'codex' });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: invRecordStore,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      queueConvergence: adapter,
    });

    // Redispatch is intentionally chained behind the convergence queue_updated
    // enrichment barrier. Let that ordered fire-and-forget chain settle before
    // asserting the replacement state.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(result.reconciled, 1, 'zombie must be reconciled');
    assert.equal(result.errors, 0, 'no errors');

    // 5. Verify stale entry was removed — it should not appear in the queue at all
    const afterEntries = queue.list('t1', 'u1');
    const staleStillPresent = afterEntries.some((e) => e.id === staleEntryId);
    assert.equal(staleStillPresent, false, 'stale processing entry must be removed');

    // 6. Verify user's entry was dispatched by tryDispatchNext (P1-2 fair drain).
    // tryExecuteNextAcrossUsers kicks the user @codex entry. Depending on timing
    // (codex R12 P2 reorder: convergence before clearTaskProgress), the dispatch
    // may fully complete during the clearTaskProgress await — so the entry is either
    // 'processing' (dispatch started) or fully consumed (dispatch finished). Both
    // prove the #972 fix: the blocked user message is no longer idle.
    const userEntry = afterEntries.find((e) => e.content === 'user @codex message');
    if (userEntry) {
      assert.equal(userEntry.status, 'processing', 'user entry dispatched (processing) by fair drain');
    }
    // If userEntry is absent, it was fully consumed by dispatch — even better.

    // 7. Verify invocation record is now failed
    const updatedRecord = invRecordStore.get(zombieInv.invocationId);
    assert.equal(updatedRecord.status, 'failed');
    assert.equal(updatedRecord.error, 'zombie_record_detected');
  });

  it('P2-1: terminal-path convergence failure counted as error', async () => {
    // Already-terminal zombie + convergence throws → error counted (not swallowed)
    const invRecordStore = new InvocationRecordStore();
    const created = invRecordStore.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'terminal-conv-fail',
    });
    invRecordStore.update(created.invocationId, { status: 'running' });
    // Must be zombie-terminalized (zombie_record_detected) for convergence to run
    invRecordStore.update(created.invocationId, { status: 'failed', error: 'zombie_record_detected' });

    const queueConvergence = {
      removeStaleProcessing: () => {
        throw new Error('redis timeout');
      },
      releaseSlot: () => {},
      tryDispatchNext: () => {},
    };

    const result = await reconcileZombies([makeZombie({ invocationId: created.invocationId })], {
      invocationRecordStore: invRecordStore,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      queueConvergence,
    });

    assert.equal(result.alreadyTerminal, 1);
    assert.equal(result.errors, 1, 'convergence failure in terminal path must count as error');
  });

  it('Sol R4 P2: durable retry with backoff — failure → retry failure → later success removes entry', async (t) => {
    // Sol R4 requirement: retry that fails again must be re-discoverable (not fire-and-forget).
    // Verify: exponential backoff (30s → 60s → 120s), dedup, and eventual convergence.
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const queue = new InvocationQueue();
    const log = makeRecordingLogger();

    const qp = new QueueProcessor({
      queue,
      invocationTracker: {
        start: () => ({}),
        startAll: () => ({}),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: async () => ({ outcome: 'created', invocationId: 'test-inv' }),
        update: async () => {},
      },
      router: {
        routeExecution: async () => ({ status: 'succeeded', response: '' }),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        list: () => [],
        get: () => null,
        create: async () => ({ id: 'm1' }),
        update: async () => {},
        delete: async () => {},
      },
      log,
    });

    // Set up a stale processing entry
    const staleResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'stale @codex',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    queue.markProcessingById('t1', staleResult.entry.id);
    assert.equal(
      queue.list('t1', 'u1').filter((e) => e.status === 'processing').length,
      1,
      'precondition: 1 processing',
    );

    // Patch removeProcessed to fail on first 2 attempts, succeed on 3rd
    let attempt = 0;
    const origRemoveProcessed = queue.removeProcessed.bind(queue);
    queue.removeProcessed = (...args) => {
      attempt++;
      if (attempt <= 2) throw new Error(`transient failure #${attempt}`);
      return origRemoveProcessed(...args);
    };

    const adapter = qp.buildQueueConvergence();
    adapter.scheduleRetry('t1', 'codex', 'u1', `queue-${staleResult.entry.id}`);

    // Dedup: second call with same key must not create a new timer
    adapter.scheduleRetry('t1', 'codex', 'u1', `queue-${staleResult.entry.id}`);

    // Attempt 0 at 30s (30_000 * 2^0) — fails
    t.mock.timers.tick(30_000);
    assert.equal(attempt, 1, '1st retry attempted at 30s');
    assert.equal(queue.list('t1', 'u1').length, 1, 'entry survives 1st failure');
    const warn1 = log.records.warn.find((a) => a[1]?.includes?.('rescheduling with backoff'));
    assert.ok(warn1, 'backoff warning logged on 1st failure');
    assert.equal(warn1[0].attempt, 0, 'attempt 0 logged');

    // Attempt 1 at 60s (30_000 * 2^1) — fails
    t.mock.timers.tick(60_000);
    assert.equal(attempt, 2, '2nd retry attempted at 60s');
    assert.equal(queue.list('t1', 'u1').length, 1, 'entry survives 2nd failure');

    // Attempt 2 at 120s (30_000 * 2^2, capped at 120s) — succeeds
    t.mock.timers.tick(120_000);
    assert.equal(attempt, 3, '3rd retry succeeds at 120s');
    assert.equal(queue.list('t1', 'u1').length, 0, 'stale entry finally removed on 3rd attempt');

    // Success logged with attempt number
    const successLog = log.records.info.find((a) => a[1]?.includes?.('durable retry: removed stale'));
    assert.ok(successLog, 'success logged');
    assert.equal(successLog[0].attempt, 2, 'attempt 2 (0-indexed) logged on success');
  });

  it('#972: durable retry also rolls back batch siblings (codex R11 P2)', async (t) => {
    // When the initial convergence fails and scheduleRetry succeeds later,
    // the retry path must also roll back batch siblings (batchParentId match).
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const queue = new InvocationQueue();
    const log = makeRecordingLogger();

    const qp = new QueueProcessor({
      queue,
      invocationTracker: {
        start: () => ({}),
        startAll: () => ({}),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: async () => ({ outcome: 'created', invocationId: 'test-inv' }),
        update: async () => {},
      },
      router: {
        routeExecution: async () => ({ status: 'succeeded', response: '' }),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        list: () => [],
        get: () => null,
        create: async () => ({ id: 'm1' }),
        update: async () => {},
        delete: async () => {},
      },
      log,
    });

    // Primary stale entry
    const primaryResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: '@codex primary',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const primaryId = primaryResult.entry.id;
    queue.markProcessingById('t1', primaryId);

    // Batch sibling (batchParentId = primary)
    const sibResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: '@codex sibling',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const sibId = sibResult.entry.id;
    queue.markProcessingById('t1', sibId, primaryId);

    assert.equal(queue.list('t1', 'u1').filter((e) => e.status === 'processing').length, 2, '2 processing before');

    const adapter = qp.buildQueueConvergence();
    adapter.scheduleRetry('t1', 'codex', 'u1', `queue-${primaryId}`);

    // Fire retry at 30s
    t.mock.timers.tick(30_000);

    // Primary must be removed
    const after = queue.list('t1', 'u1');
    assert.equal(after.filter((e) => e.id === primaryId).length, 0, 'primary removed by retry');

    // Sibling was rolled back to 'queued', then immediately re-dispatched to
    // 'processing' by tryExecuteNextAcrossUsers (the dispatch kick). Verify via
    // the log that rollback happened — rolledBackSiblings=1 proves the sibling
    // was successfully rolled back before dispatch re-claimed it.
    const retryLog = log.records.info.find((a) => a[1]?.includes?.('durable retry: removed stale'));
    assert.ok(retryLog, 'retry success logged');
    assert.equal(retryLog[0].rolledBackSiblings, 1, 'rolledBackSiblings=1 proves sibling was rolled back');

    // Sibling still exists in queue (re-dispatched by kick)
    const sibAfter = after.find((e) => e.id === sibId);
    assert.ok(sibAfter, 'sibling still in queue (re-dispatched by kick)');
  });

  it('Sol R4 P2: durable retry dedup — concurrent scheduleRetry for different keys both run', async (t) => {
    // Two different idempotencyKeys must both schedule independently (no cross-key dedup).
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const queue = new InvocationQueue();
    const log = makeRecordingLogger();

    const qp = new QueueProcessor({
      queue,
      invocationTracker: {
        start: () => ({}),
        startAll: () => ({}),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: async () => ({ outcome: 'created', invocationId: 'test-inv' }),
        update: async () => {},
      },
      router: {
        routeExecution: async () => ({ status: 'succeeded', response: '' }),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        list: () => [],
        get: () => null,
        create: async () => ({ id: 'm1' }),
        update: async () => {},
        delete: async () => {},
      },
      log,
    });

    // Set up two stale processing entries
    const entry1 = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'stale1 @codex',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const entry2 = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'stale2 @codex',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    queue.markProcessingById('t1', entry1.entry.id);
    queue.markProcessingById('t1', entry2.entry.id);
    assert.equal(queue.list('t1', 'u1').filter((e) => e.status === 'processing').length, 2);

    const adapter = qp.buildQueueConvergence();
    adapter.scheduleRetry('t1', 'codex', 'u1', `queue-${entry1.entry.id}`);
    adapter.scheduleRetry('t1', 'codex', 'u1', `queue-${entry2.entry.id}`);

    // Both fire at 30s
    t.mock.timers.tick(30_000);
    assert.equal(queue.list('t1', 'u1').length, 0, 'both stale entries removed');
  });

  it('Sol R2 regression: pinned-continuation zombie cleanup must not delete older follow-up dispatched by winner', async () => {
    // Sol's exact reproduction scenario (R2 P1-1):
    // 1. Pinned continuation zombie is cleaned → winner's fair-drain dispatches
    //    an OLDER user follow-up message (createdAt < zombie's createdAt)
    // 2. Terminal loser runs removeStaleProcessing for the same cat
    // 3. With time-based matching (createdAt <= zombieCreatedAt), the loser would
    //    delete the legitimate older follow-up → afterLoser=[] → messages lost!
    // 4. With precise entry identity, the loser's entry ID doesn't match →
    //    the follow-up SURVIVES
    const invRecordStore = new InvocationRecordStore();
    const queue = new InvocationQueue();
    const { qp } = buildQueueProcessorWithQueue(queue);

    // Step 1: Create the zombie's queue entry (pinned continuation)
    const zombieQueueResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'pinned continuation @codex',
      source: 'agent',
      sourceCategory: 'continuation',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      priority: 'normal',
    });
    const zombieEntryId = zombieQueueResult.entry.id;

    // Step 2: Create an OLDER user follow-up (queued before the zombie was created)
    const olderFollowup = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'older user @codex follow-up',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const olderEntryId = olderFollowup.entry.id;

    // Make the follow-up OLDER than the zombie entry (createdAt < zombie's createdAt)
    const olderInternal = queue.list('t1', 'u1').find((e) => e.id === olderEntryId);
    olderInternal.createdAt = Date.now() - 1_000_000; // much older

    // Step 3: Winner already cleaned the zombie entry; fair-drain dispatched
    // the older follow-up to processing. Simulate this state:
    // - Zombie entry: already removed by winner (not in queue)
    queue.markProcessingById('t1', zombieEntryId);
    queue.removeProcessed('t1', 'u1', zombieEntryId);
    // - Older follow-up: now in processing (dispatched by winner's fair-drain)
    queue.markProcessingById('t1', olderEntryId);

    const entriesBefore = queue.list('t1', 'u1');
    assert.equal(entriesBefore.length, 1, 'only older follow-up remains');
    assert.equal(entriesBefore[0].id, olderEntryId);
    assert.equal(entriesBefore[0].status, 'processing');

    // Step 4: Create the LOSER's invocation record (concurrent terminal retry)
    // Its idempotencyKey = queue-${zombieEntryId} — the ZOMBIE's entry, not the follow-up
    const loserInv = invRecordStore.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: `queue-${zombieEntryId}`,
    });
    invRecordStore.update(loserInv.invocationId, { status: 'running' });
    invRecordStore.update(loserInv.invocationId, { status: 'failed', error: 'concurrent' });

    // Step 5: Terminal loser runs convergence retry
    const adapter = qp.buildQueueConvergence();
    const zombie = makeZombie({ invocationId: loserInv.invocationId, catId: 'codex' });
    const result = await reconcileZombies([zombie], {
      invocationRecordStore: invRecordStore,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      queueConvergence: adapter,
    });

    assert.equal(result.alreadyTerminal, 1, 'loser sees terminal record');

    // CRITICAL ASSERTION: the older follow-up MUST survive
    const entriesAfter = queue.list('t1', 'u1');
    assert.equal(entriesAfter.length, 1, 'older follow-up must survive loser convergence');
    assert.equal(entriesAfter[0].id, olderEntryId, 'surviving entry must be the older follow-up');
    assert.equal(entriesAfter[0].status, 'processing', 'follow-up status unchanged');
    assert.equal(entriesAfter[0].content, 'older user @codex follow-up', 'follow-up content preserved');
  });

  it('Sol maintainer P1: stale execution callback cannot steal replacement slot (reservation fence)', async () => {
    // Reproduced race from maintainer review:
    // 1. Old execution A owns slot S — executeEntry Promise still settling
    // 2. Zombie convergence deletes S and dispatches replacement B into S
    // 3. Old A's .then callback calls releaseSlotIfOwned(sk, old_reservation)
    // 4. MUST NOT delete B's slot: reservation mismatch → no-op
    //
    // We test through the full dispatch pipeline by using an async-generator
    // routeExecution mock that we can hold open and settle on demand.
    //
    // Sol maintainer R17 P2: pass an explicit nonzero processingSlotTtlMs — the
    // default (2.5 × CLI_TIMEOUT_MS) is environment-dependent: with the valid
    // local config CLI_TIMEOUT_MS=0 the TTL is 0 and tryExecuteNextForUser's
    // sweep immediately expires the replacement's slot, failing this test for
    // reasons unrelated to the reservation fence.
    const queue = new InvocationQueue();
    const holdResolvers = [];
    const { qp, log } = buildHoldableQueueProcessor(queue, holdResolvers, { processingSlotTtlMs: 60_000 });

    // Enqueue entries A (zombie) and B (replacement)
    const aResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'entry A',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'entry B',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });

    // Start A via processNext — captures slot reservation_A in closure
    const dispatchA = await qp.processNext('t1', 'u1');
    assert.equal(dispatchA.started, true, 'A must start');
    // Wait for executeEntry to reach routeExecution (async generator)
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(holdResolvers.length, 1, 'A routeExecution reached');

    // Convergence: remove A, release slot, dispatch B
    const adapter = qp.buildQueueConvergence();
    const rmResult = adapter.removeStaleProcessing('t1', 'codex', 'u1', `queue-${aResult.entry.id}`);
    assert.equal(rmResult.removed, true, 'A entry removed by convergence');
    adapter.releaseSlot('t1', 'codex', aResult.entry.id);
    adapter.tryDispatchNext('t1', 'codex');

    // Wait for B's dispatch (fire-and-forget async path)
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(holdResolvers.length, 2, 'B routeExecution reached — replacement dispatched');

    // Now: B is executing (held open), slot owned by reservation_B.
    // Resolve old A — its stale callback tries releaseSlotIfOwned(sk, reservation_A)
    holdResolvers[0](); // resolve A's routeExecution
    await new Promise((r) => setTimeout(r, 100)); // let A's .then callback fire

    // CRITICAL: B's slot must survive — trying to start C must fail (slot busy)
    queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'canary C',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const dispatchC = await qp.processNext('t1', 'u1');
    assert.equal(dispatchC.started, false, 'C must NOT start — B still owns the slot (reservation fence)');
    // Without reservation fence: A's .then does processingSlots.delete(sk) → B's slot gone → C starts

    // Cleanup: resolve B
    holdResolvers[1]();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('Sol maintainer R17 P1: immediate convergence must not delete replacement reservation (owner-bound slot)', async () => {
    // Exact production path from maintainer review (no concurrent processes):
    // 1. Processing entry A owns reservation 1 and becomes stale with no tracker.
    // 2. tryExecuteNextForUser sweeps the stale slot and starts replacement B
    //    with reservation 2. The old A queue row still exists.
    // 3. Zombie reconciliation precisely removes row A, then releaseSlot.
    // 4. MUST NOT delete B's slot (owner mismatch) — otherwise C starts beside B.
    const queue = new InvocationQueue();
    const holdResolvers = [];
    const { qp } = buildHoldableQueueProcessor(queue, holdResolvers, { processingSlotTtlMs: 60_000 });
    const sk = JSON.stringify(['t1', 'codex']);

    // Enqueue entry A (zombie). B is enqueued AFTER A's execution starts so it
    // is not collected into A's user-message batch (executeEntry batches adjacent
    // queued user entries at start) — B must stay 'queued' to become the replacement.
    const aResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'entry A',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });

    // 1. Start A — owns the slot (ownerId = A's entry id, reservation 1)
    const dispatchA = await qp.processNext('t1', 'u1');
    assert.equal(dispatchA.started, true, 'A must start');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(holdResolvers.length, 1, 'A routeExecution reached');

    // Expire A's slot: age beyond TTL with no active tracker → sweep-eligible zombie
    qp.processingSlots.get(sk).startedAt = Date.now() - 120_000;

    // Replacement B queued behind the stale row
    queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'entry B',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });

    // 2. Dispatch path sweeps the stale slot and starts replacement B (reservation 2).
    //    A's queue row remains 'processing' (the hung executeEntry never cleaned it).
    const dispatchB = await qp.processNext('t1', 'u1');
    assert.equal(dispatchB.started, true, 'B must start after sweep releases the stale slot');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(holdResolvers.length, 2, 'B routeExecution reached');
    assert.equal(
      queue.list('t1', 'u1').filter((e) => e.status === 'processing').length,
      2,
      'precondition: stale row A + replacement B both processing',
    );

    // 3. Zombie reconciliation precisely removes row A, then owner-guarded releaseSlot
    const adapter = qp.buildQueueConvergence();
    const rmResult = adapter.removeStaleProcessing('t1', 'codex', 'u1', `queue-${aResult.entry.id}`);
    assert.equal(rmResult.removed, true, 'A entry removed by convergence');
    assert.equal(rmResult.entryId, aResult.entry.id);
    adapter.releaseSlot('t1', 'codex', aResult.entry.id);

    // 4. CRITICAL: B's slot must survive — its ownerId is B's entry, not A's
    assert.ok(qp.processingSlots.has(sk), 'replacement slot must survive convergence of the old row');

    // Canary C must NOT start — B still owns the slot
    queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'canary C',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const dispatchC = await qp.processNext('t1', 'u1');
    assert.equal(dispatchC.started, false, 'C must NOT start beside B (owner-bound reservation)');

    // Positive control: owner-matched release still works — releasing B's own
    // reservation frees the slot (proves the guard is ownership, not "never release").
    adapter.releaseSlot('t1', 'codex', dispatchB.entry.id);
    assert.equal(qp.processingSlots.has(sk), false, 'owner-matched release frees the slot');

    // Cleanup: resolve held executions
    holdResolvers.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 100));
  });

  it('Sol maintainer R17 P1: delayed retry must not delete replacement slot reclaimed during backoff', async (t) => {
    // a12d1f69f retry-slot fence, regression per maintainer R17 P2.
    // 1. Stale entry A owns the slot; convergence fails → scheduleRetry (30s backoff).
    // 2. During the backoff window the slot is released (steer/cancel/sweep) and
    //    reclaimed by replacement B.
    // 3. The retry fires, removes stale row A — MUST NOT release B's slot.
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const queue = new InvocationQueue();
    const holdResolvers = [];
    const { qp, log } = buildHoldableQueueProcessor(queue, holdResolvers, { processingSlotTtlMs: 60_000 });
    const sk = JSON.stringify(['t1', 'codex']);

    const aResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'stale A',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });

    // 1. A starts and owns the slot (B enqueued later so it is not batched into A)
    const dispatchA = await qp.processNext('t1', 'u1');
    assert.equal(dispatchA.started, true, 'A must start and own the slot');

    const adapter = qp.buildQueueConvergence();
    adapter.scheduleRetry('t1', 'codex', 'u1', `queue-${aResult.entry.id}`);

    // 2. Backoff window: replacement B queued; slot force-released (steer/cancel
    //    path) and reclaimed by B
    queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'replacement B',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    qp.releaseSlot('t1', 'codex');
    const dispatchB = await qp.processNext('t1', 'u1');
    assert.equal(dispatchB.started, true, 'B must reclaim the slot during the backoff window');

    // 3. Retry fires — removes stale row A, must preserve B's slot
    t.mock.timers.tick(30_000);
    assert.equal(
      queue.list('t1', 'u1').some((e) => e.id === aResult.entry.id),
      false,
      'stale row A removed by retry',
    );
    assert.ok(qp.processingSlots.has(sk), 'replacement slot must survive the delayed retry');
    const retryLog = log.records.info.find((a) => a[1]?.includes?.('durable retry: removed stale'));
    assert.ok(retryLog, 'retry success logged');
    assert.equal(retryLog[0].slotReleased, false, 'owner mismatch → retry must not release the slot');

    // Canary C must NOT start beside B
    queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'canary C',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const dispatchC = await qp.processNext('t1', 'u1');
    assert.equal(dispatchC.started, false, 'C must NOT start beside B');

    // Cleanup
    holdResolvers.forEach((r) => r());
  });

  it('Sol maintainer R17 P2: late batch finalizer must not touch the re-dispatched sibling (a12d1f69f fence)', async () => {
    // a12d1f69f sibling fence, regression per maintainer R17 P2.
    // 1. Primary A executing; sibling S batched in (processing, batchParentId = A).
    // 2. Zombie convergence removes A, rolls back S (batch dissolved — batchParentId
    //    cleared), and tryDispatchNext re-dispatches S as a standalone execution.
    // 3. Old A's executeEntry finally settles: its late finalizer still holds S in
    //    batchedEntryIds — on success it would REMOVE S's queue row, on failure it
    //    would ROLL BACK S to queued. Both are fenced by the batchParentId ownership
    //    check; S must stay processing and its replacement execution untouched.
    const queue = new InvocationQueue();
    const holdResolvers = [];
    const { qp } = buildHoldableQueueProcessor(queue, holdResolvers, { processingSlotTtlMs: 60_000 });

    const aResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'primary A',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    const sResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'sibling S',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });

    // 1. Start A — executeEntry batches the adjacent sibling S
    const dispatchA = await qp.processNext('t1', 'u1');
    assert.equal(dispatchA.started, true, 'A must start');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(holdResolvers.length, 1, 'A routeExecution reached');
    const sBatched = queue.list('t1', 'u1').find((e) => e.id === sResult.entry.id);
    assert.equal(sBatched.status, 'processing', 'S batched into A execution');
    assert.equal(sBatched.batchParentId, aResult.entry.id, 'S owned by A batch');

    // 2. Zombie convergence: remove A, roll back S, re-dispatch S standalone
    const adapter = qp.buildQueueConvergence();
    const rmResult = adapter.removeStaleProcessing('t1', 'codex', 'u1', `queue-${aResult.entry.id}`);
    assert.equal(rmResult.removed, true, 'A removed by convergence');
    assert.deepEqual(rmResult.rolledBackSiblings, [sResult.entry.id], 'S rolled back (batch dissolved)');
    adapter.releaseSlot('t1', 'codex', aResult.entry.id);
    adapter.tryDispatchNext('t1', 'codex');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(holdResolvers.length, 2, 'S re-dispatched as standalone execution');
    const sRedispatched = queue.list('t1', 'u1').find((e) => e.id === sResult.entry.id);
    assert.equal(sRedispatched.status, 'processing', 'S re-dispatched');

    // 3. Old A's execution finally settles — late finalizer must skip re-dispatched S
    holdResolvers[0]();
    await new Promise((r) => setTimeout(r, 100));

    const sFinal = queue.list('t1', 'u1').find((e) => e.id === sResult.entry.id);
    assert.ok(sFinal, 'S queue row must survive old A finalizer (success-path removal fenced)');
    assert.equal(sFinal.status, 'processing', 'S must stay processing (failure-path rollback fenced)');
    assert.equal(holdResolvers.length, 2, 'S replacement execution untouched');

    // Cleanup
    holdResolvers[1]();
    await new Promise((r) => setTimeout(r, 100));
  });
});

// ── Sol maintainer review P2: deferred TaskProgress cleanup regression ──

describe('Sol maintainer review: deferred cleanup', () => {
  it('P2: zombie B converges before zombie A cleanup resolves (two-zombie deferred-cleanup)', async () => {
    // Reproduced from maintainer review:
    // Before fix: processZombie awaits clearTaskProgress serially → A's hanging
    // Redis delete prevents B from reaching convergence (record update + queue cleanup).
    // After fix: clearTaskProgress deferred → all zombies converge first, cleanup in parallel.
    const store = new InvocationRecordStore();
    const recA = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'queue-a',
    });
    store.update(recA.invocationId, { status: 'running' });

    const recB = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'queue-b',
    });
    store.update(recB.invocationId, { status: 'running' });

    // Track operation order — A's cleanup hangs via controlled promise
    const opLog = [];
    let resolveACleanup;
    const taskProgressStore = {
      deleteSnapshot: async (_threadId, catId) => {
        opLog.push(`${catId}-cleanup-start`);
        if (catId === 'codex') {
          // A's cleanup — hangs until manually resolved (simulates Redis stall)
          await new Promise((r) => {
            resolveACleanup = r;
          });
        }
        opLog.push(`${catId}-cleanup-done`);
      },
      deleteSnapshotIfOwner: async (_threadId, catId) => {
        opLog.push(`${catId}-cleanup-start`);
        if (catId === 'codex') {
          await new Promise((r) => {
            resolveACleanup = r;
          });
        }
        opLog.push(`${catId}-cleanup-done`);
        return true;
      },
    };

    const convergenceCalls = [];
    const queueConvergence = {
      removeStaleProcessing: (_threadId, catId) => {
        opLog.push(`${catId}-convergence`);
        convergenceCalls.push(catId);
        return { removed: true, entryId: `e-${catId}`, primaryCatId: catId };
      },
      releaseSlot: () => {},
      tryDispatchNext: () => {},
    };

    const resultPromise = reconcileZombies(
      [
        makeZombie({ invocationId: recA.invocationId, catId: 'codex' }),
        makeZombie({ invocationId: recB.invocationId, catId: 'opus' }),
      ],
      {
        invocationRecordStore: store,
        taskProgressStore,
        log: makeRecordingLogger(),
        queueConvergence,
      },
    );

    // Wait for async operations to settle (convergence is sync per zombie,
    // but deleteSnapshot calls fire as the deferred promises are created)
    await new Promise((r) => setTimeout(r, 50));

    // CRITICAL: B MUST have converged even though A's cleanup is still hanging
    assert.ok(convergenceCalls.includes('opus'), 'B convergence must have run');
    assert.ok(convergenceCalls.includes('codex'), 'A convergence must have run');
    const bConvergenceIdx = opLog.indexOf('opus-convergence');
    assert.ok(bConvergenceIdx >= 0, 'B convergence in opLog');
    assert.ok(!opLog.includes('codex-cleanup-done'), 'A cleanup must NOT have resolved yet');

    // Both records are already terminal (convergence complete for both)
    assert.equal(store.get(recA.invocationId).status, 'failed', 'A record failed');
    assert.equal(store.get(recB.invocationId).status, 'failed', 'B record failed');

    // Resolve A's cleanup so reconcileZombies can complete
    resolveACleanup();
    const result = await resultPromise;

    assert.equal(result.reconciled, 2, 'both zombies reconciled');
    assert.equal(result.taskProgressCleared, 2, 'both TaskProgress cleared');
    assert.equal(result.errors, 0, 'no errors');
    assert.ok(opLog.includes('codex-cleanup-done'), 'A cleanup eventually resolved');
  });

  it('R18 P1: deferred zombie cleanup preserves TaskProgress owned by replacement B', async () => {
    const store = new InvocationRecordStore();
    const recA = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'queue-a',
    });
    store.update(recA.invocationId, { status: 'running' });

    let snapshot = { lastInvocationId: recA.invocationId };
    let releaseDelete;
    let deleteStarted;
    const deleteStartedPromise = new Promise((resolve) => {
      deleteStarted = resolve;
    });
    const taskProgressStore = {
      deleteSnapshot: async () => {
        deleteStarted();
        await new Promise((resolve) => {
          releaseDelete = resolve;
        });
        snapshot = null;
      },
      deleteSnapshotIfOwner: async (_threadId, _catId, invocationId) => {
        deleteStarted();
        await new Promise((resolve) => {
          releaseDelete = resolve;
        });
        if (snapshot?.lastInvocationId !== invocationId) return false;
        snapshot = null;
        return true;
      },
    };

    const resultPromise = reconcileZombies([makeZombie({ invocationId: recA.invocationId, catId: 'codex' })], {
      invocationRecordStore: store,
      taskProgressStore,
      log: makeRecordingLogger(),
    });
    await deleteStartedPromise;

    snapshot = { lastInvocationId: 'replacement-B' };
    releaseDelete();
    const result = await resultPromise;

    assert.deepEqual(snapshot, { lastInvocationId: 'replacement-B' }, 'old A cleanup must preserve B snapshot');
    assert.equal(result.taskProgressCleared, 0, 'owner mismatch is a safe no-op, not a cleared snapshot');
    assert.equal(result.errors, 0);
  });
});

describe('Sol maintainer R18: convergence event ordering', () => {
  it('older zombie snapshot is emitted before replacement processing can publish newer state', async () => {
    const invRecordStore = new InvocationRecordStore();
    const queue = new InvocationQueue();
    const socketEmits = [];
    let releaseEnrichment;
    let enrichmentStarted;
    const enrichmentStartedPromise = new Promise((resolve) => {
      enrichmentStarted = resolve;
    });
    const messageStore = {
      list: () => [],
      get: () => null,
      getById: async () => {
        enrichmentStarted();
        await new Promise((resolve) => {
          releaseEnrichment = resolve;
        });
        return null;
      },
      create: async () => ({ id: 'm1' }),
      update: async () => {},
      delete: async () => {},
    };
    const socketManager = {
      broadcastAgentMessage: () => {},
      broadcastToRoom: () => {},
      emitToUser: (userId, event, data) => socketEmits.push({ userId, event, data }),
    };
    const { qp } = buildQueueProcessorWithQueue(queue, { messageStore, socketManager });

    const stale = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'stale A',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    queue.markProcessingById('t1', stale.entry.id);
    const replacement = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'replacement B',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
      messageId: 'msg-b',
    });
    const recA = invRecordStore.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: `queue-${stale.entry.id}`,
    });
    invRecordStore.update(recA.invocationId, { status: 'running' });

    qp.tryExecuteNextAcrossUsers = async () => {
      queue.markProcessingById('t1', replacement.entry.id);
      socketManager.emitToUser('u1', 'queue_updated', {
        threadId: 't1',
        queue: queue.list('t1', 'u1'),
        action: 'processing',
      });
    };
    qp.tryAutoExecute = async () => {};

    const resultPromise = reconcileZombies([makeZombie({ invocationId: recA.invocationId, catId: 'codex' })], {
      invocationRecordStore: invRecordStore,
      taskProgressStore: makeTaskProgressStore(),
      queueConvergence: qp.buildQueueConvergence(),
      log: makeRecordingLogger(),
    });
    await enrichmentStartedPromise;
    assert.deepEqual(socketEmits, [], 'replacement dispatch waits for the older convergence event');

    releaseEnrichment();
    await resultPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      socketEmits.map((event) => event.data.action),
      ['zombie_convergence', 'processing'],
      'full snapshots must be emitted in mutation order',
    );
  });

  it('R19 P1: serializes concurrent zombie removal snapshots for the same thread and user', async () => {
    const queue = new InvocationQueue();
    const socketEmits = [];
    let releaseFirstEnrichment;
    let firstEnrichmentStarted;
    const firstEnrichmentStartedPromise = new Promise((resolve) => {
      firstEnrichmentStarted = resolve;
    });
    const messageStore = {
      list: () => [],
      get: () => null,
      getById: async (messageId) => {
        if (messageId === 'msg-b') {
          firstEnrichmentStarted();
          await new Promise((resolve) => {
            releaseFirstEnrichment = resolve;
          });
        }
        return null;
      },
      create: async () => ({ id: 'm1' }),
      update: async () => {},
      delete: async () => {},
    };
    const socketManager = {
      broadcastAgentMessage: () => {},
      broadcastToRoom: () => {},
      emitToUser: (userId, event, data) => socketEmits.push({ userId, event, data }),
    };
    const { qp } = buildQueueProcessorWithQueue(queue, { messageStore, socketManager });

    const zombieA = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'zombie A',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
      messageId: 'msg-a',
    });
    const zombieB = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'zombie B',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
      messageId: 'msg-b',
    });
    const independentZombie = queue.enqueue({
      threadId: 't1',
      userId: 'u2',
      content: 'independent zombie',
      source: 'user',
      targetCats: ['gemini'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
      messageId: 'msg-c',
    });
    queue.markProcessingById('t1', zombieA.entry.id);
    queue.markProcessingById('t1', zombieB.entry.id);
    queue.markProcessingById('t1', independentZombie.entry.id);

    const convergence = qp.buildQueueConvergence();
    const removedA = convergence.removeStaleProcessing('t1', 'codex', 'u1', `queue-${zombieA.entry.id}`);
    assert.equal(removedA.removed, true);
    await firstEnrichmentStartedPromise;

    const removedB = convergence.removeStaleProcessing('t1', 'opus', 'u1', `queue-${zombieB.entry.id}`);
    assert.equal(removedB.removed, true);
    const removedIndependent = convergence.removeStaleProcessing(
      't1',
      'gemini',
      'u2',
      `queue-${independentZombie.entry.id}`,
    );
    assert.equal(removedIndependent.removed, true);
    await removedIndependent.queueUpdate;
    assert.deepEqual(
      socketEmits.filter((event) => event.userId === 'u1'),
      [],
      'newer B snapshot must wait behind slow older A publication',
    );
    assert.equal(socketEmits.filter((event) => event.userId === 'u2').length, 1, 'a different scope stays independent');

    releaseFirstEnrichment();
    await Promise.all([removedA.queueUpdate, removedB.queueUpdate]);

    assert.deepEqual(
      socketEmits.filter((event) => event.userId === 'u1').map((event) => event.data.queue.map((entry) => entry.id)),
      [[zombieB.entry.id], []],
      'same-scope full snapshots must publish in queue mutation order',
    );
  });

  it('R20 P1: serializes route removal behind an older same-scope zombie snapshot', async () => {
    const queue = new InvocationQueue();
    const socketEmits = [];
    let releaseZombieEnrichment;
    let zombieEnrichmentStarted;
    const zombieEnrichmentStartedPromise = new Promise((resolve) => {
      zombieEnrichmentStarted = resolve;
    });
    const messageStore = {
      list: () => [],
      get: () => null,
      getById: async (messageId) => {
        if (messageId === 'msg-b') {
          zombieEnrichmentStarted();
          await new Promise((resolve) => {
            releaseZombieEnrichment = resolve;
          });
        }
        return null;
      },
      create: async () => ({ id: 'm1' }),
      update: async () => {},
      delete: async () => {},
    };
    const socketManager = {
      broadcastAgentMessage: () => {},
      broadcastToRoom: () => {},
      emitToUser: (userId, event, data) => socketEmits.push({ userId, event, data }),
    };
    const { qp } = buildQueueProcessorWithQueue(queue, { messageStore, socketManager });

    const zombieA = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'zombie A',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
      messageId: 'msg-a',
    });
    const queuedB = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'queued B',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
      messageId: 'msg-b',
    });
    queue.markProcessingById('t1', zombieA.entry.id);

    const convergence = qp.buildQueueConvergence();
    const removedA = convergence.removeStaleProcessing('t1', 'codex', 'u1', `queue-${zombieA.entry.id}`);
    assert.equal(removedA.removed, true);
    await zombieEnrichmentStartedPromise;

    assert.ok(queue.remove('t1', 'u1', queuedB.entry.id));
    const routeRemovalUpdate = emitQueueUpdated(
      socketManager,
      'u1',
      't1',
      queue.list('t1', 'u1'),
      messageStore,
      'removed',
    );
    await Promise.resolve();
    assert.deepEqual(socketEmits, [], 'newer route snapshot must wait behind the older zombie publication');

    releaseZombieEnrichment();
    await Promise.all([removedA.queueUpdate, routeRemovalUpdate]);

    assert.deepEqual(
      socketEmits.map((event) => ({
        action: event.data.action,
        queueIds: event.data.queue.map((entry) => entry.id),
      })),
      [
        { action: 'zombie_convergence', queueIds: [queuedB.entry.id] },
        { action: 'removed', queueIds: [] },
      ],
      'all same-scope full snapshots must publish in queue mutation order',
    );
  });

  it('R20 P1: a failed publisher does not poison later same-scope publications', async () => {
    const emittedActions = [];
    let failFirst = true;
    const socketManager = {
      emitToUser: (_userId, _event, data) => {
        if (failFirst) {
          failFirst = false;
          throw new Error('synthetic emit failure');
        }
        emittedActions.push(data.action);
      },
    };

    const failed = emitQueueUpdated(socketManager, 'u1', 't1', [], null, 'first');
    const following = emitQueueUpdated(socketManager, 'u1', 't1', [], null, 'second');

    await assert.rejects(failed, /synthetic emit failure/);
    await following;
    assert.deepEqual(emittedActions, ['second']);
  });

  it('R21 P2: stalled enrichment falls back to raw and releases the same-scope tail', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const emitted = [];
    let enrichmentStarted;
    const enrichmentStartedPromise = new Promise((resolve) => {
      enrichmentStarted = resolve;
    });
    const messageStore = {
      getById: async () => {
        enrichmentStarted();
        return new Promise(() => {});
      },
    };
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };
    const stalledEntry = {
      id: 'q-stalled',
      messageId: 'msg-stalled',
      mergedMessageIds: [],
      targetCats: ['codex'],
      status: 'queued',
    };

    const stalled = emitQueueUpdated(socketManager, 'u1', 't1', [stalledEntry], messageStore, 'stalled');
    await enrichmentStartedPromise;
    const following = emitQueueUpdated(socketManager, 'u1', 't1', [], messageStore, 'following');

    t.mock.timers.tick(2_000);
    await stalled;
    await following;

    assert.deepEqual(
      emitted.map((event) => ({ action: event.action, queue: event.queue })),
      [
        { action: 'stalled', queue: [stalledEntry] },
        { action: 'following', queue: [] },
      ],
      'the head publisher must emit raw and release its tail after the enrichment deadline',
    );
  });

  it('R21 P2: enrichment that settles before the deadline still publishes its preview', async () => {
    const emittedQueues = [];
    const socketManager = {
      emitToUser: (_userId, _event, data) => emittedQueues.push(data.queue),
    };
    const messageStore = {
      getById: async () => ({
        contentBlocks: [{ kind: 'text', text: 'preview text' }],
        replyTo: 'msg-parent',
      }),
    };
    const entry = {
      id: 'q-enriched',
      messageId: 'msg-enriched',
      mergedMessageIds: [],
      targetCats: ['codex'],
      status: 'queued',
    };

    await emitQueueUpdated(socketManager, 'u1', 't1', [entry], messageStore, 'enriched');

    assert.deepEqual(emittedQueues[0][0].messagePreview, {
      contentBlocks: [{ kind: 'text', text: 'preview text' }],
      replyTo: 'msg-parent',
    });
  });

  it('R20 P1: freezes legacy partial queue projections without requiring array fields', async () => {
    const emittedQueues = [];
    const socketManager = {
      emitToUser: (_userId, _event, data) => emittedQueues.push(data.queue),
    };
    const legacyProjection = { id: 'q-legacy', status: 'queued' };

    await emitQueueUpdated(socketManager, 'u1', 't1', [legacyProjection], null, 'enqueued');

    assert.deepEqual(emittedQueues, [[legacyProjection]]);
  });
});
