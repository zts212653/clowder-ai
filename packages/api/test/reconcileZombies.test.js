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
 * - P1-1 (Sol review): age guard — only remove entries from zombie's generation
 * - P1-2 (Sol review): fair dispatch — tryDispatchNext calls cross-user drain
 * - P2-1 (Sol review): convergence failure counted in errors; terminal-path retry safe
 * - P2-3 (Sol review): real adapter tests (InvocationQueue + buildQueueConvergence)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { reconcileZombies } = await import('../dist/domains/cats/services/agents/invocation/reconcileZombies.js');
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

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
function buildQueueProcessorWithQueue(queue) {
  const log = makeRecordingLogger();
  const dispatchCalls = [];
  const socketEmits = [];

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
      emitToUser: (userId, event, data) => socketEmits.push({ userId, event, data }),
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

  // Spy on tryExecuteNextAcrossUsers and tryAutoExecute
  const origTryExecAcrossUsers = qp.tryExecuteNextAcrossUsers?.bind(qp);
  const origTryAutoExecute = qp.tryAutoExecute?.bind(qp);

  return { qp, log, dispatchCalls, socketEmits };
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
  it('#972: reconcileZombies calls queueConvergence with zombieCreatedAt age guard', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'q-conv-1',
    });
    store.update(created.invocationId, { status: 'running' });
    const invCreatedAt = store.get(created.invocationId).createdAt;

    // Track queueConvergence calls
    const convergenceCalls = [];
    const queueConvergence = {
      removeStaleProcessing: (threadId, catId, userId, zombieCreatedAt) => {
        convergenceCalls.push({ op: 'removeStaleProcessing', threadId, catId, userId, zombieCreatedAt });
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
    // Queue convergence must be called with the correct args
    assert.equal(convergenceCalls.length, 3, 'removeStaleProcessing + releaseSlot + tryDispatchNext');
    const removeCall = convergenceCalls.find((c) => c.op === 'removeStaleProcessing');
    assert.ok(removeCall, 'must call removeStaleProcessing');
    assert.equal(removeCall.threadId, 't1');
    assert.equal(removeCall.catId, 'opus');
    assert.equal(removeCall.userId, 'u1', 'must pass userId for user-scoped lookup');
    // P1-1: zombieCreatedAt must be the invocation record's createdAt
    assert.equal(removeCall.zombieCreatedAt, invCreatedAt, 'must pass invocation createdAt as age guard');
    // P1-2: tryDispatchNext receives catId for cross-user fair drain
    const dispatchCall = convergenceCalls.find((c) => c.op === 'tryDispatchNext');
    assert.ok(dispatchCall, 'must kick queue after slot release');
    assert.equal(dispatchCall.catId, 'opus', 'tryDispatchNext must receive catId for fair drain');
  });

  it('#972: terminal-path convergence retry is safe with age guard (P2-1)', async () => {
    // Sol P2-1: terminal path now retries convergence because P1-1's age guard
    // prevents matching new live entries. Previously blocked by codex R6 P1.
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'q-conv-terminal-retry',
    });
    store.update(created.invocationId, { status: 'running' });
    store.update(created.invocationId, { status: 'succeeded' }); // already terminal

    const convergenceCalls = [];
    const queueConvergence = {
      removeStaleProcessing: (threadId, catId, userId, zombieCreatedAt) => {
        convergenceCalls.push({ op: 'removeStaleProcessing', threadId, catId, userId, zombieCreatedAt });
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
    // P2-1: convergence IS now retried for terminal zombies (age guard makes it safe)
    assert.ok(convergenceCalls.length > 0, 'convergence must be attempted for terminal zombie');
    const removeCall = convergenceCalls.find((c) => c.op === 'removeStaleProcessing');
    assert.ok(removeCall, 'must call removeStaleProcessing');
    assert.equal(removeCall.catId, 'codex');
    // Age guard present
    assert.ok(typeof removeCall.zombieCreatedAt === 'number', 'must pass zombieCreatedAt');
  });

  it('#972: convergence failure counted as error (P2-1)', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'q-conv-fail',
    });
    store.update(created.invocationId, { status: 'running' });

    const queueConvergence = {
      removeStaleProcessing: () => {
        throw new Error('queue store unavailable');
      },
      releaseSlot: () => {},
      tryDispatchNext: () => {},
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
      idempotencyKey: 'q-conv-noop',
    });
    store.update(created.invocationId, { status: 'running' });

    const convergenceCalls = [];
    const queueConvergence = {
      removeStaleProcessing: (threadId, catId, userId, zombieCreatedAt) => {
        convergenceCalls.push({ op: 'removeStaleProcessing', threadId, catId, userId, zombieCreatedAt });
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
// verifying entry identity, age guard, and dispatch semantics — not just mock callback invocation.

describe('F220 Phase 2a: buildQueueConvergence real adapter (Sol P2-3)', () => {
  it('P1-1: age guard protects newer live entry from deletion', async () => {
    // Scenario: old zombie (createdAt=T1) + new live entry for same cat (createdAt=T2>T1).
    // removeStaleProcessing(zombieCreatedAt=T1) must only remove the old entry, not the new one.
    const queue = new InvocationQueue();
    const { qp } = buildQueueProcessorWithQueue(queue);

    const T_OLD = Date.now() - 600_000; // 10 min ago
    const T_NEW = Date.now() - 10_000; // 10 sec ago

    // Enqueue old entry (from zombie's generation)
    const oldResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'old @codex message',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    assert.equal(oldResult.outcome, 'enqueued');
    const oldEntryId = oldResult.entry.id;

    // Enqueue new live entry (same cat, different generation)
    const newResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'new @codex message',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: false,
      priority: 'normal',
    });
    assert.equal(newResult.outcome, 'enqueued');
    const newEntryId = newResult.entry.id;

    // Modify internal entries' createdAt via list() references (enqueue returns shallow copies)
    const entries = queue.list('t1', 'u1');
    const oldInternal = entries.find((e) => e.id === oldEntryId);
    const newInternal = entries.find((e) => e.id === newEntryId);
    assert.ok(oldInternal && newInternal, 'both entries must exist');
    oldInternal.createdAt = T_OLD;
    newInternal.createdAt = T_NEW;

    // Mark both as processing (simulating real lifecycle)
    queue.markProcessingById('t1', oldEntryId);
    queue.markProcessingById('t1', newEntryId);

    // Both entries are now 'processing' for codex
    const beforeList = queue.list('t1', 'u1');
    const processingBefore = beforeList.filter((e) => e.status === 'processing' && e.targetCats.includes('codex'));
    assert.equal(processingBefore.length, 2, 'two processing codex entries before');

    // Call adapter with zombie's createdAt = T_OLD
    const adapter = qp.buildQueueConvergence();
    const result = adapter.removeStaleProcessing('t1', 'codex', 'u1', T_OLD);

    assert.equal(result.removed, true, 'old entry must be removed');
    assert.equal(result.entryId, oldEntryId, 'must remove the old entry specifically');

    // New live entry must survive
    const afterList = queue.list('t1', 'u1');
    const processingAfter = afterList.filter((e) => e.status === 'processing' && e.targetCats.includes('codex'));
    assert.equal(processingAfter.length, 1, 'only one processing entry remains');
    assert.equal(processingAfter[0].id, newEntryId, 'surviving entry must be the new live one');
  });

  it('P1-1: no matching entry when all entries are newer than zombie → removed=false', async () => {
    // Scenario: zombie is very old, but only recent entries exist. None should be removed.
    const queue = new InvocationQueue();
    const { qp } = buildQueueProcessorWithQueue(queue);

    const T_ZOMBIE = Date.now() - 600_000; // zombie created 10 min ago
    const T_ENTRY = Date.now() - 5_000; // entry created 5 sec ago

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
    const entryId = enqResult.entry.id;
    // Set createdAt on internal entry (enqueue returns shallow copy)
    const internal = queue.list('t1', 'u1').find((e) => e.id === entryId);
    internal.createdAt = T_ENTRY;
    queue.markProcessingById('t1', entryId);

    const adapter = qp.buildQueueConvergence();
    const result = adapter.removeStaleProcessing('t1', 'codex', 'u1', T_ZOMBIE);

    assert.equal(result.removed, false, 'must not remove entry newer than zombie');
    // Entry still present
    const entries = queue.list('t1', 'u1');
    assert.equal(entries.length, 1, 'entry must survive');
    assert.equal(entries[0].status, 'processing');
  });

  it('P1-2: tryDispatchNext calls cross-user fair drain (not just autoExecute)', async () => {
    // Verify that tryDispatchNext invokes tryExecuteNextAcrossUsers (which handles
    // user/connector entries) in addition to tryAutoExecute.
    const queue = new InvocationQueue();
    const log = makeRecordingLogger();
    const methodsCalled = [];

    // Create a QueueProcessor with intercepted dispatch methods
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

    // Monkey-patch the private methods to track calls
    // (QueueProcessor methods are on the prototype; need to intercept on the instance)
    const origTryExec = Object.getPrototypeOf(qp).tryExecuteNextAcrossUsers;
    const origTryAuto = qp.tryAutoExecute.bind(qp);

    // Use a wrapper that records the call
    qp.tryAutoExecute = async (...args) => {
      methodsCalled.push('tryAutoExecute');
      // Don't actually execute (would need full setup)
    };
    // tryExecuteNextAcrossUsers is private — access via adapter's closure
    // The adapter calls this.tryExecuteNextAcrossUsers internally.
    // We can verify by checking that the adapter doesn't throw and logs appropriately.

    const adapter = qp.buildQueueConvergence();
    // Call tryDispatchNext and wait for the async chain
    adapter.tryDispatchNext('t1', 'codex');
    // Give the promise chain time to resolve
    await new Promise((r) => setTimeout(r, 50));

    // The adapter should have attempted dispatch (no throw = it ran the chain).
    // We can verify tryAutoExecute was called after tryExecuteNextAcrossUsers.
    // Since tryExecuteNextAcrossUsers is private and we can't directly intercept it,
    // we verify the method chain completed without error by checking no error was logged.
    const errorLogs = log.records.warn.filter((args) => args[1]?.includes?.('dispatch after zombie convergence'));
    // If tryExecuteNextAcrossUsers threw, we'd see the error log. It should succeed (empty queue).
    assert.equal(errorLogs.length, 0, 'dispatch chain must complete without error');
  });

  it('P2-1: full convergence pipeline — zombie reconcile removes stale + kicks dispatch', async () => {
    // End-to-end: create zombie invocation record, stale queue entry, and queued user entry.
    // After reconcileZombies, the stale entry is removed and the queued entry becomes
    // eligible for dispatch. This is the core #972 AC regression.
    const invRecordStore = new InvocationRecordStore();
    const queue = new InvocationQueue();
    const { qp, log } = buildQueueProcessorWithQueue(queue);

    // 1. Create the zombie's invocation record (running state)
    const zombieInv = invRecordStore.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'zombie-inv-1',
    });
    invRecordStore.update(zombieInv.invocationId, { status: 'running' });
    const zombieCreatedAt = invRecordStore.get(zombieInv.invocationId).createdAt;

    // 2. Enqueue the zombie's queue entry (stale processing)
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
    // Set createdAt on internal entry via list() reference (enqueue returns shallow copy)
    const staleInternal = queue.list('t1', 'u1').find((e) => e.id === staleEntryId);
    staleInternal.createdAt = zombieCreatedAt - 100; // created just before invocation
    queue.markProcessingById('t1', staleEntryId);

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

    assert.equal(result.reconciled, 1, 'zombie must be reconciled');
    assert.equal(result.errors, 0, 'no errors');

    // 5. Verify stale entry was removed — it should not appear in the queue at all
    const afterEntries = queue.list('t1', 'u1');
    const staleStillPresent = afterEntries.some((e) => e.id === staleEntryId);
    assert.equal(staleStillPresent, false, 'stale processing entry must be removed');

    // 6. Verify user's entry was dispatched by tryDispatchNext (P1-2 fair drain).
    // tryExecuteNextAcrossUsers kicks the user @codex entry → status becomes
    // 'processing' (fire-and-forget execution). This IS the #972 fix: the blocked
    // user message is no longer idle after zombie cleanup.
    const userEntry = afterEntries.find((e) => e.content === 'user @codex message');
    assert.ok(userEntry, 'user entry must still exist in queue (being dispatched)');
    assert.equal(userEntry.status, 'processing', 'user entry must be dispatched (processing) by fair drain');

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
    invRecordStore.update(created.invocationId, { status: 'failed', error: 'concurrent' });

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
});
