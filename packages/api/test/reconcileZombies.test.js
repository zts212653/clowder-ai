/**
 * F194 Phase B (Bundle) — reconcileZombies cleanup pathway tests.
 *
 * Coverage (AC-B7~B10):
 * - AC-B7: marks zombie record `failed(error='zombie_record_detected')` + clears TaskProgress
 * - AC-B8: read-only: helper not invoked here; cleanup is independent of read path
 * - AC-B9: audit log emitted per zombie + summary at end
 * - AC-B10: idempotent — second call on same zombie is a no-op (state machine guard)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { reconcileZombies } = await import('../dist/domains/cats/services/agents/invocation/reconcileZombies.js');
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

function makeZombie({ invocationId, catId = 'opus', recordUpdatedAt = Date.now() - 700_000 }) {
  return {
    invocationId,
    catId,
    recordStatus: 'running',
    recordUpdatedAt,
    reason: 'no_tracker_no_fresh_draft_age_exceeded',
  };
}

function makeTaskProgressStore(initialOwners) {
  const cleared = [];
  const owners = initialOwners ? new Map(Object.entries(initialOwners)) : null;
  const keyFor = (threadId, catId) => `${threadId}:${catId}`;
  return {
    cleared,
    owners,
    deleteSnapshot: async (threadId, catId) => {
      cleared.push({ threadId, catId });
      owners?.delete(keyFor(threadId, catId));
    },
    deleteSnapshotIfOwner: async (threadId, catId, invocationId) => {
      const key = keyFor(threadId, catId);
      if (owners && owners.get(key) !== invocationId) return false;
      cleared.push({ threadId, catId });
      owners?.delete(key);
      return true;
    },
  };
}

function makeRecordingLogger() {
  const records = { info: [], warn: [] };
  return {
    records,
    info: (...args) => records.info.push(args),
    warn: (...args) => records.warn.push(args),
  };
}

describe('F194 reconcileZombies — cleanup pathway', () => {
  it('emits one exact terminal recovery event only when the running record transitions to failed', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 'thread-zombie',
      userId: 'u1',
      targetCats: ['codex-sol', 'opus'],
      intent: 'execute',
      idempotencyKey: 'terminal-recovery',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(created.invocationId, { status: 'running' });
    const terminalEvents = [];
    const deps = {
      invocationRecordStore: store,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      onReconciledZombie: async (event) => terminalEvents.push(event),
    };

    await reconcileZombies([makeZombie({ invocationId: created.invocationId, catId: 'codex-sol' })], deps);
    await reconcileZombies([makeZombie({ invocationId: created.invocationId, catId: 'codex-sol' })], deps);

    assert.deepEqual(terminalEvents, [
      {
        invocationId: created.invocationId,
        threadId: 'thread-zombie',
        catId: 'codex-sol',
        targetCats: ['codex-sol', 'opus'],
        status: 'failed',
      },
    ]);
  });

  it('clears TaskProgress for every durable target of the terminal parent', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 'thread-zombie',
      userId: 'u1',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      idempotencyKey: 'multi-cat-task-progress',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(created.invocationId, { status: 'running' });
    const taskProgressStore = makeTaskProgressStore();

    const result = await reconcileZombies([makeZombie({ invocationId: created.invocationId, catId: 'opus' })], {
      invocationRecordStore: store,
      taskProgressStore,
      log: makeRecordingLogger(),
    });

    assert.equal(result.taskProgressCleared, 2);
    assert.deepEqual(taskProgressStore.cleared, [
      { threadId: 'thread-zombie', catId: 'opus' },
      { threadId: 'thread-zombie', catId: 'codex' },
    ]);
  });

  it('preserves replacement TaskProgress while clearing only zombie-owned durable targets', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 'thread-owner-race',
      userId: 'u1',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      idempotencyKey: 'owner-race',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(created.invocationId, { status: 'running' });
    const taskProgressStore = makeTaskProgressStore({
      'thread-owner-race:opus': 'replacement-B',
      'thread-owner-race:codex': created.invocationId,
    });

    const result = await reconcileZombies([makeZombie({ invocationId: created.invocationId, catId: 'opus' })], {
      invocationRecordStore: store,
      taskProgressStore,
      log: makeRecordingLogger(),
    });

    assert.equal(result.taskProgressCleared, 1, 'only the snapshot still owned by the zombie is cleared');
    assert.equal(taskProgressStore.owners.get('thread-owner-race:opus'), 'replacement-B');
    assert.equal(taskProgressStore.owners.has('thread-owner-race:codex'), false);
    assert.deepEqual(taskProgressStore.cleared, [{ threadId: 'thread-owner-race', catId: 'codex' }]);
  });

  it('falls back to the detected zombie cat when durable targets are empty', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 'thread-zombie',
      userId: 'u1',
      targetCats: [],
      intent: 'execute',
      idempotencyKey: 'targetless-task-progress',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(created.invocationId, { status: 'running' });
    const taskProgressStore = makeTaskProgressStore();

    const result = await reconcileZombies([makeZombie({ invocationId: created.invocationId, catId: 'opus' })], {
      invocationRecordStore: store,
      taskProgressStore,
      log: makeRecordingLogger(),
    });

    assert.equal(result.taskProgressCleared, 1);
    assert.deepEqual(taskProgressStore.cleared, [{ threadId: 'thread-zombie', catId: 'opus' }]);
  });

  it('does not emit terminal recovery when CAS returns null for a still-running record', async () => {
    const terminalEvents = [];
    const stubStore = {
      get: async () => ({
        invocationId: 'inv-cas-drift',
        threadId: 'thread-zombie',
        userId: 'u1',
        targetCats: ['codex-sol'],
        status: 'running',
      }),
      update: async () => null,
    };

    await reconcileZombies([makeZombie({ invocationId: 'inv-cas-drift', catId: 'codex-sol' })], {
      invocationRecordStore: stubStore,
      log: makeRecordingLogger(),
      onReconciledZombie: async (event) => terminalEvents.push(event),
    });

    assert.deepEqual(terminalEvents, []);
  });

  it('AC-B7: marks zombie record failed + clears TaskProgress + emits audit log', async () => {
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k1',
      actionLeaseCarrier: { kind: 'none' },
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
      actionLeaseCarrier: { kind: 'none' },
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
    // Reproduces cloud Codex P1 (comment 3211783767, line 101): if update()
    // returns null because the record is already terminal (concurrent reconcile
    // won), and the WINNER's owner-bound delete failed transiently, the loser's path
    // would skip cleanup → phantom progress bar lingers forever (zombie sweep
    // only enumerates running records, won't pick it up again).
    //
    // Fix: on update() returning null, check current status. If terminal, still
    // attempt the owner-bound delete to provide redundancy across concurrent reconciles.
    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'r15-p1-key',
      actionLeaseCarrier: { kind: 'none' },
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
    // Fix: owner-bound deletion is still attempted for terminal records → cleanup happens
    assert.equal(result.taskProgressCleared, 1, 'TaskProgress cleared even when CAS fails on terminal record');
    assert.deepEqual(taskProgressStore.cleared, [{ threadId: 't1', catId: 'opus' }]);
  });

  it('cloud R17 P2: CAS update returns null but record still running → counted as transient error, not alreadyTerminal', async () => {
    // Reproduces cloud Codex P2 (comment 3211853819): the Redis store's update() can
    // return null after exhausting CAS-drift retries during concurrent reassignment.
    // In that case the record is STILL running (or queued) — mis-classifying as
    // alreadyTerminal silently drops a real zombie. Fix: distinguish missing/terminal/
    // still-alive paths and count still-alive as transient error.
    //
    // Construct a stub store: get() returns running, update() always returns null
    // (simulating CAS-drift retry exhaustion).
    const phantomZombieRecord = {
      id: 'inv-phantom',
      threadId: 't1',
      userId: 'u1',
      userMessageId: null,
      targetCats: ['opus'],
      intent: 'execute',
      status: 'running',
      idempotencyKey: 'k-phantom',
      actionLeaseCarrier: { kind: 'none' },
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

  it('cloud R15 P1: missing record → no owner-bound delete attempt (avoid spurious cleanup)', async () => {
    // Edge case: update() returns null because record never existed (deleted).
    // Don't attempt deletion — there's no canonical (threadId, catId, invocationId) owner to clean.
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
    assert.equal(result.taskProgressCleared, 0, 'no owner-bound delete for missing record');
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
      actionLeaseCarrier: { kind: 'none' },
    });
    const r2 = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['gpt52'],
      intent: 'execute',
      idempotencyKey: 'b',
      actionLeaseCarrier: { kind: 'none' },
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
    // concurrent reconciles where the winner's owner-bound delete might have failed transiently).
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
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(created.invocationId, { status: 'running' });
    const failingTaskStore = {
      deleteSnapshot: async () => {
        throw new Error('redis down');
      },
      deleteSnapshotIfOwner: async () => {
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

  // ---------------------------------------------------------------------------
  // F220 Phase 2a — clowder-ai#972 split-brain regression.
  //
  // Root cause: reconcileZombies converges ONLY InvocationRecord + TaskProgress.
  // The matching InvocationQueue entry stays `processing` forever, so a later user
  // @codex message queues behind a dead parent and never runs.
  //
  // Join note: QueueEntry has NO invocationId — the only link back to the zombie is
  // messageId (InvocationRecord.userMessageId <-> QueueEntry.messageId).
  // Convergence note: QueueEntry.status is only 'queued' | 'processing' (no terminal
  // state), so converging a dead entry means REMOVE it, not "mark failed".
  // ---------------------------------------------------------------------------
  it('#972: zombie parent must converge its stale `processing` queue entry so later user work unblocks', async () => {
    const store = new InvocationRecordStore();
    const queue = new InvocationQueue();

    // 1) Parent opus invocation, running, bound to its trigger message.
    const parent = store.create({
      threadId: 't1',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k-parent',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(parent.invocationId, { status: 'running', userMessageId: 'msg-parent' });

    // 2) Its queue entry is claimed -> `processing`. This is the entry that goes stale.
    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 't1',
      userId: 'u1',
      content: '@codex go',
      source: 'agent',
      targetCats: ['opus'],
      intent: 'execute',
      messageId: 'msg-parent',
    });
    const claimed = queue.markProcessing('t1', 'u1');
    assert.equal(claimed?.messageId, 'msg-parent', 'precondition: parent entry is processing');

    // 3) A later USER `@codex` message queues BEHIND the processing entry.
    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 't1',
      userId: 'u1',
      content: '@codex please',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
      messageId: 'msg-user',
    });

    // 4) Parent is judged a zombie and swept.
    const terminalEvents = [];
    const queueEvents = [];
    const result = await reconcileZombies([makeZombie({ invocationId: parent.invocationId })], {
      invocationRecordStore: store,
      invocationQueue: queue,
      taskProgressStore: makeTaskProgressStore(),
      log: makeRecordingLogger(),
      onReconciledZombie: async (event) => terminalEvents.push(event),
      onQueueConverged: (event) => queueEvents.push(event),
    });

    // Existing behavior (already green): the record is marked failed.
    assert.equal(store.get(parent.invocationId).status, 'failed');

    // #972: the stale `processing` entry must be converged, not left blocking the head.
    const remaining = queue.list('t1', 'u1');
    assert.equal(
      remaining.some((e) => e.messageId === 'msg-parent'),
      false,
      '#972: stale processing entry must be removed when its invocation is zombie-reaped',
    );
    assert.equal(
      remaining.some((e) => e.status === 'processing'),
      false,
      '#972: no processing entry may survive a zombie sweep',
    );
    assert.equal(result.queueConverged, 1, '#972: result must report queue convergence');
    assert.equal(terminalEvents.length, 1, '#2928 terminal recovery still fires exactly once for the CAS winner');
    assert.deepEqual(queueEvents, [{ threadId: 't1', userId: 'u1', removedEntryIds: [claimed.id] }]);

    // The actual user-facing symptom: the later user @codex work is now promotable.
    assert.equal(
      queue.peekNextQueued('t1', 'u1')?.messageId,
      'msg-user',
      '#972: later user @codex must unblock after the dead parent is swept',
    );
  });

  it('#972 race: replacement tombstone wins before exact-id removal without duplicate broadcast', async () => {
    const store = new InvocationRecordStore();
    const queue = new InvocationQueue();
    const parent = store.create({
      threadId: 't-race',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k-replacement-wins',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(parent.invocationId, { status: 'running', userMessageId: 'msg-parent' });
    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 't-race',
      userId: 'u1',
      content: '@codex go',
      source: 'agent',
      targetCats: ['opus'],
      intent: 'execute',
      messageId: 'msg-parent',
    });
    const claimed = queue.markProcessing('t-race', 'u1');
    assert.ok(claimed);

    const queueEvents = [];
    let terminalRecoveryCalls = 0;
    const racingQueue = {
      list: (threadId, userId) => queue.list(threadId, userId),
      removeProcessed: (threadId, userId, entryId) => {
        queue.removeProcessed(threadId, userId, entryId); // replacement path wins the race
        return queue.removeProcessed(threadId, userId, entryId); // sweep exact-id retry loses safely
      },
    };

    const result = await reconcileZombies([makeZombie({ invocationId: parent.invocationId })], {
      invocationRecordStore: store,
      invocationQueue: racingQueue,
      log: makeRecordingLogger(),
      onReconciledZombie: async () => {
        terminalRecoveryCalls += 1;
      },
      onQueueConverged: (event) => queueEvents.push(event),
    });

    assert.equal(result.queueConverged, 0, 'losing exact-id tombstone is an idempotent no-op');
    assert.deepEqual(queueEvents, [], 'no queue_updated broadcast when this sweep removed nothing');
    assert.equal(terminalRecoveryCalls, 1, '#2928 recovery remains owned by the CAS winner');
  });

  it('#972 race: already-terminal retry still converges the queue without replaying terminal recovery', async () => {
    const store = new InvocationRecordStore();
    const queue = new InvocationQueue();
    const parent = store.create({
      threadId: 't-terminal',
      userId: 'u1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'k-terminal-retry',
      actionLeaseCarrier: { kind: 'none' },
    });
    store.update(parent.invocationId, { status: 'running', userMessageId: 'msg-parent' });
    store.update(parent.invocationId, { status: 'failed', error: 'concurrent-zombie-detected' });
    queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 't-terminal',
      userId: 'u1',
      content: '@codex go',
      source: 'agent',
      targetCats: ['opus'],
      intent: 'execute',
      messageId: 'msg-parent',
    });
    const claimed = queue.markProcessing('t-terminal', 'u1');
    assert.ok(claimed);

    const queueEvents = [];
    let terminalRecoveryCalls = 0;
    const result = await reconcileZombies([makeZombie({ invocationId: parent.invocationId })], {
      invocationRecordStore: store,
      invocationQueue: queue,
      log: makeRecordingLogger(),
      onReconciledZombie: async () => {
        terminalRecoveryCalls += 1;
      },
      onQueueConverged: (event) => queueEvents.push(event),
    });

    assert.equal(result.alreadyTerminal, 1);
    assert.equal(result.queueConverged, 1, 'terminal retry closes a half-converged queue row');
    assert.equal(queue.list('t-terminal', 'u1').length, 0);
    assert.deepEqual(queueEvents, [{ threadId: 't-terminal', userId: 'u1', removedEntryIds: [claimed.id] }]);
    assert.equal(terminalRecoveryCalls, 0, '#2928 terminal callback remains CAS-winner-only');
  });
});
