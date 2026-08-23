/**
 * Thread 1+2 escape hatch: POST /api/threads/:threadId/force-reset
 *
 * Bug context (docs/bug-report/2026-05-29-invocation-stale-active-recovery):
 *   Both threads ended up with stuck active state that:
 *   - cancel route couldn't clear (Thread 1: 404 short-circuit)
 *   - processingSlots stuck in QueueProcessor memory
 *   - running InvocationRecords persisted in Redis
 *
 * This endpoint provides a last-resort escape hatch:
 *   - Releases ALL in-memory processingSlots for the thread (via queueProcessor.releaseThread)
 *   - Marks ALL running InvocationRecords for (threadId, userId) as canceled
 *   - Returns { ok: true, canceledRecords: N }
 *
 * RED → GREEN after adding route in packages/api/src/routes/queue.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { queueRoutes } = await import('../dist/routes/queue.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { SessionMutex } = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js');
const { mergeStreams } = await import('../dist/domains/cats/services/agents/invocation/stream-merge.js');

const THREAD_ID = 'thread-force-reset';
const USER_ID = 'user-1';

function makeRecordStore(runningRecords = []) {
  const records = new Map(runningRecords.map((r) => [r.id, { ...r }]));
  const updates = [];
  return {
    get: async (id) => records.get(id) ?? null,
    create: () => ({ outcome: 'created', invocationId: 'inv-test' }),
    update: async (id, input) => {
      updates.push({ id, input });
      const rec = records.get(id);
      if (!rec) return null;
      const updated = { ...rec, ...input, updatedAt: Date.now() };
      records.set(id, updated);
      return updated;
    },
    getByIdempotencyKey: () => null,
    listRunningByThread: (tid, uid) =>
      [...records.values()].filter((r) => r.status === 'running' && r.threadId === tid && r.userId === uid),
    updates,
  };
}

function makeQueueProcessor({ canReleaseSlotForUser = true } = {}) {
  const actions = [];
  return {
    canReleaseSlotForUser: () => canReleaseSlotForUser,
    suppressAutoResume: (tid, cid, executionIds = []) =>
      actions.push({ op: 'suppressAutoResume', tid, cid, executionIds }),
    clearPause: (tid, cid) => actions.push({ op: 'clearPause', tid, cid }),
    releaseSlot: (tid, cid) => actions.push({ op: 'releaseSlot', tid, cid }),
    releaseThread: (tid) => actions.push({ op: 'releaseThread', tid }),
    retireThreadPrestartProcessingGroups: async () => ({ outcome: 'none', retiredCatIds: [] }),
    hasActiveExecution: () => false,
    isCatBusy: () => false,
    actions,
  };
}

function makeTracker({
  cancelAllReturn = [],
  cancelAllExecutionIds = [],
  slotOwnerUserId = USER_ID,
  hasActiveSlot = false,
} = {}) {
  const cancelAllCalls = [];
  return {
    has: () => hasActiveSlot,
    getUserId: () => slotOwnerUserId,
    cancel: () => ({ cancelled: false, catIds: [] }),
    getActiveSlots: () => [],
    cancelAll: (tid, uid, reason) => {
      cancelAllCalls.push({ tid, uid, reason });
      return {
        catIds: cancelAllReturn,
        executionIds: cancelAllExecutionIds,
        executionIdByCatId: Object.fromEntries(
          cancelAllReturn.flatMap((catId, index) => {
            const executionId = cancelAllExecutionIds[index];
            return executionId ? [[catId, executionId]] : [];
          }),
        ),
      };
    },
    cancelAllCalls,
  };
}

async function buildApp(opts = {}) {
  const app = Fastify({ logger: false });
  const invocationQueue = new InvocationQueue();
  const qp = opts.queueProcessor ?? makeQueueProcessor();
  const rs = opts.recordStore ?? makeRecordStore([]);
  const tracker = opts.tracker ?? makeTracker();
  const broadcasts = [];

  await app.register(queueRoutes, {
    threadStore: {
      get: async (id) => ({ id, createdBy: USER_ID }),
      addParticipants: async () => {},
      updateLastActive: async () => {},
    },
    invocationQueue,
    queueProcessor: qp,
    invocationTracker: tracker,
    socketManager: {
      broadcastToRoom: () => {},
      broadcastAgentMessage: (m, tid) => broadcasts.push({ m, tid }),
      getIO: () => ({}),
      emitToUser: () => {},
    },
    invocationRecordStore: rs,
    ...(opts.messageStore ? { messageStore: opts.messageStore } : {}),
    ...(opts.queueCustodyCoordinator ? { queueCustodyCoordinator: opts.queueCustodyCoordinator } : {}),
    ...(opts.getManagedCommandWakeRecovery
      ? { getManagedCommandWakeRecovery: opts.getManagedCommandWakeRecovery }
      : {}),
    ...(opts.agentSessionMutex ? { agentSessionMutex: opts.agentSessionMutex } : {}),
  });

  await app.ready();
  return { app, invocationQueue, queueProcessor: qp, recordStore: rs, tracker, broadcasts };
}

// ── RED tests ──

describe('force-reset: releases all stuck state for a thread (escape hatch)', () => {
  it('dogfood: force-reset aborts the child but keeps its session lock until the runner exits', async () => {
    const batch = new AbortController();
    const tracker = makeTracker({ cancelAllReturn: ['codex-sol'], cancelAllExecutionIds: ['inv-stuck'] });
    const originalCancelAll = tracker.cancelAll;
    tracker.cancelAll = (...args) => {
      batch.abort('cancel_all');
      return originalCancelAll(...args);
    };
    const mutex = new SessionMutex();
    const staleRelease = await mutex.acquire({
      key: 'cli-session-1',
      invocationId: 'child-stuck',
      executionId: 'inv-stuck',
      threadId: THREAD_ID,
      catId: 'codex-sol',
      userId: USER_ID,
      acquiredAt: Date.now(),
    });
    let closeCalls = 0;
    const stuckChild = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        return new Promise(() => {});
      },
      async return() {
        closeCalls++;
        return { done: true, value: undefined };
      },
    };
    const mergedNext = mergeStreams([stuckChild], undefined, { signal: batch.signal })[Symbol.asyncIterator]().next();
    const { app } = await buildApp({ tracker, agentSessionMutex: mutex });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    const terminal = await Promise.race([
      mergedNext,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);
    let reinvokeAcquired = false;
    const reinvoke = mutex
      .acquire({
        key: 'cli-session-1',
        invocationId: 'child-reinvoke',
        executionId: 'inv-reinvoke',
        threadId: THREAD_ID,
        catId: 'codex-sol',
        userId: USER_ID,
        acquiredAt: Date.now(),
      })
      .then((release) => {
        reinvokeAcquired = true;
        return release;
      });

    assert.equal(res.statusCode, 200);
    assert.notEqual(terminal, 'timeout', 'force-reset must terminate the stuck merge');
    assert.equal(terminal.done, true);
    assert.equal(closeCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reinvokeAcquired, false, 'replacement must not overlap the cancelled session runner');
    staleRelease();
    const reinvokeRelease = await reinvoke;
    reinvokeRelease();
  });

  it('single-cat cancel recovers a lock-only orphan even when tracker and records are empty', async () => {
    const lockScopes = [];
    const { app, broadcasts, queueProcessor } = await buildApp({
      agentSessionMutex: {
        forceReleaseByScope(scope) {
          lockScopes.push(scope);
          return { releasedHolders: 1, rejectedWaiters: 0 };
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/codex-sol`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, cancelled: true });
    assert.deepEqual(lockScopes, [{ threadId: THREAD_ID, userId: USER_ID, catId: 'codex-sol' }]);
    assert.ok(broadcasts.some(({ m }) => m.type === 'done' && m.catId === 'codex-sol'));
    assert.ok(queueProcessor.actions.some((action) => action.op === 'releaseSlot' && action.cid === 'codex-sol'));
  });

  it('force-reset cleans terminal state for cats recovered only from session locks', async () => {
    const queueProcessor = makeQueueProcessor();
    const { app, broadcasts } = await buildApp({
      queueProcessor,
      agentSessionMutex: {
        forceReleaseByScope() {
          return { releasedHolders: 1, rejectedWaiters: 0, catIds: ['codex-sol'] };
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(broadcasts.some(({ m }) => m.type === 'done' && m.catId === 'codex-sol'));
    assert.ok(queueProcessor.actions.some((action) => action.op === 'clearPause' && action.cid === 'codex-sol'));
    assert.ok(queueProcessor.actions.some((action) => action.op === 'releaseSlot' && action.cid === 'codex-sol'));
  });

  it('force-reset retires active managed producers and withdraws their exact Queue carriers', async () => {
    const events = [];
    const managedCommandWakeRecovery = {
      async retireThread(threadId, userId, reason) {
        events.push(`retire:${threadId}:${userId}:${reason}`);
        return { retired: 1, messageIds: ['message-managed-force-reset'] };
      },
      async retireCarrier() {
        throw new Error('force-reset must use the thread-wide producer fence');
      },
    };
    const queueCustodyCoordinator = {
      async withdrawEntry(entry) {
        events.push(`withdraw:${entry.id}`);
        return true;
      },
    };
    const { app, invocationQueue } = await buildApp({
      getManagedCommandWakeRecovery: () => managedCommandWakeRecovery,
      queueCustodyCoordinator,
    });
    const { entry } = invocationQueue.enqueue({
      threadId: THREAD_ID,
      userId: USER_ID,
      ownerAuthProvenance: 'strict',
      content: 'managed wake result',
      messageId: 'message-managed-force-reset',
      source: 'agent',
      sourceCategory: 'scheduled',
      targetCats: ['codex-sol'],
      intent: 'execute',
      autoExecute: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(events, [`retire:${THREAD_ID}:${USER_ID}:force_reset`, `withdraw:${entry.id}`]);
    assert.equal(invocationQueue.list(THREAD_ID, USER_ID).length, 0);
  });

  it('does not release a foreign pre-start processing slot when the tracker is absent', async () => {
    const queueProcessor = makeQueueProcessor({ canReleaseSlotForUser: false });
    const { app, broadcasts } = await buildApp({
      queueProcessor,
      tracker: makeTracker({ hasActiveSlot: false }),
      agentSessionMutex: {
        forceReleaseByScope() {
          return { releasedHolders: 1, rejectedWaiters: 0, catIds: ['codex-sol'] };
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(
      broadcasts.some(({ m }) => m.type === 'done' && m.catId === 'codex-sol'),
      false,
    );
    assert.equal(
      queueProcessor.actions.some((action) => action.op === 'releaseSlot'),
      false,
    );
  });

  it('does not let a stale user lock release a foreign active tracker slot', async () => {
    const queueProcessor = makeQueueProcessor({ canReleaseSlotForUser: false });
    const tracker = makeTracker({ slotOwnerUserId: 'user-2', hasActiveSlot: true });
    const staleRecord = {
      id: 'inv-user-1-stale',
      threadId: THREAD_ID,
      userId: USER_ID,
      targetCats: ['codex-sol'],
      status: 'running',
      idempotencyKey: 'idem-user-1-stale',
      intent: 'execute',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    };
    const { app, broadcasts, recordStore } = await buildApp({
      queueProcessor,
      tracker,
      recordStore: makeRecordStore([staleRecord]),
      agentSessionMutex: {
        forceReleaseByScope() {
          return { releasedHolders: 1, rejectedWaiters: 0, catIds: ['codex-sol'] };
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).canceledRecords, 1);
    assert.equal(recordStore.updates.filter((update) => update.input.status === 'canceled').length, 1);
    assert.equal(
      broadcasts.some(({ m }) => m.type === 'done' && m.catId === 'codex-sol'),
      false,
    );
    assert.equal(
      queueProcessor.actions.some((action) => action.op === 'clearPause' && action.cid === 'codex-sol'),
      false,
    );
    assert.equal(
      queueProcessor.actions.some((action) => action.op === 'releaseSlot' && action.cid === 'codex-sol'),
      false,
    );
  });

  it('aborts tracker controllers before releasing user-scoped agent session locks', async () => {
    const lifecycle = [];
    const tracker = makeTracker({ cancelAllReturn: ['opus'] });
    const originalCancelAll = tracker.cancelAll;
    tracker.cancelAll = (...args) => {
      lifecycle.push('abort');
      return originalCancelAll(...args);
    };
    const lockScopes = [];
    const agentSessionMutex = {
      forceReleaseByScope(scope) {
        lifecycle.push('release-lock');
        lockScopes.push(scope);
        return { releasedHolders: 1, rejectedWaiters: 0 };
      },
    };
    const { app } = await buildApp({ tracker, agentSessionMutex });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(lifecycle.slice(0, 2), ['abort', 'release-lock']);
    assert.deepEqual(lockScopes, [{ threadId: THREAD_ID, userId: USER_ID }]);
  });

  it('marks running records canceled before releasing user-scoped agent session locks', async () => {
    const runningRecord = {
      id: 'inv-reset-ordering',
      threadId: THREAD_ID,
      userId: USER_ID,
      targetCats: ['opus'],
      status: 'running',
      idempotencyKey: 'idem-reset-ordering',
      intent: 'execute',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    };
    const recordStore = makeRecordStore([runningRecord]);
    const originalUpdate = recordStore.update;
    let allowUpdate;
    const updateGate = new Promise((resolve) => {
      allowUpdate = resolve;
    });
    let updateStarted = false;
    recordStore.update = async (...args) => {
      updateStarted = true;
      await updateGate;
      return originalUpdate(...args);
    };
    const lockScopes = [];
    const { app } = await buildApp({
      recordStore,
      agentSessionMutex: {
        forceReleaseByScope(scope) {
          lockScopes.push(scope);
          return { releasedHolders: 1, rejectedWaiters: 0 };
        },
      },
    });

    const responsePromise = app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    while (!updateStarted) await new Promise((resolve) => setImmediate(resolve));
    const releasedBeforeRecordCleanup = lockScopes.length > 0;
    allowUpdate();
    const res = await responsePromise;

    assert.equal(res.statusCode, 200);
    assert.equal(
      releasedBeforeRecordCleanup,
      false,
      'force-reset must not promote waiting work while a prior record is still running',
    );
    assert.deepEqual(lockScopes, [{ threadId: THREAD_ID, userId: USER_ID }]);
  });

  it('returns 200 with canceledRecords count after force-resetting stuck thread', async () => {
    const runningRecords = [
      {
        id: 'inv-stuck-1',
        threadId: THREAD_ID,
        userId: USER_ID,
        targetCats: ['opus'],
        status: 'running',
        idempotencyKey: 'idem-1',
        intent: 'execute',
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 120_000,
      },
      {
        id: 'inv-stuck-2',
        threadId: THREAD_ID,
        userId: USER_ID,
        targetCats: ['codex'],
        status: 'running',
        idempotencyKey: 'idem-2',
        intent: 'execute',
        createdAt: Date.now() - 90_000,
        updatedAt: Date.now() - 90_000,
      },
    ];

    const qp = makeQueueProcessor();
    // Simulate tracker with 2 active slots (both get aborted by cancelAll)
    const tracker = makeTracker({
      cancelAllReturn: ['opus', 'codex'],
      cancelAllExecutionIds: ['inv-stuck-1', 'inv-stuck-2'],
    });
    const { app, recordStore } = await buildApp({
      recordStore: makeRecordStore(runningRecords),
      queueProcessor: qp,
      tracker,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.canceledRecords, 2, 'should have canceled 2 running records');

    // All running records should be marked canceled
    const canceledUpdates = recordStore.updates.filter((u) => u.input.status === 'canceled');
    assert.equal(canceledUpdates.length, 2, 'should update all 2 records to canceled');

    // cancelAll (P1-1 fix) should have been called — primary busy source
    const cancelAllCall = tracker.cancelAllCalls.find((c) => c.tid === THREAD_ID);
    assert.ok(cancelAllCall, 'invocationTracker.cancelAll must be called to abort active controllers');
    // P2 (codex 第5轮 34e07c79): force-reset must abort with 'cancel_all' so QueueProcessor
    // suppresses auto-resume (stop everything) instead of pause+auto-recover re-busying the thread.
    assert.equal(cancelAllCall.reason, 'cancel_all', "force-reset must use 'cancel_all' abort reason");

    const suppressOps = qp.actions.filter((a) => a.op === 'suppressAutoResume' && a.tid === THREAD_ID);
    assert.deepEqual(
      suppressOps.map((a) => a.cid).sort(),
      ['codex', 'opus'],
      'force-reset must fence every owned terminal cat before delayed cleanup can auto-resume it',
    );
    assert.deepEqual(
      Object.fromEntries(suppressOps.map((op) => [op.cid, [...op.executionIds].sort()])),
      {
        opus: ['inv-stuck-1'],
        codex: ['inv-stuck-2'],
      },
      'force-reset suppression must bind each slot only to records that target that cat',
    );

    // Per-cat releaseSlot must be called for each slot from cancelAll (NOT releaseThread — cross-user scope risk)
    // cancelAllReturn=['opus','codex'] → two releaseSlot calls expected
    const releaseSlotOps = qp.actions.filter((a) => a.op === 'releaseSlot' && a.tid === THREAD_ID);
    assert.equal(releaseSlotOps.length, 2, 'releaseSlot should be called once per cancelledCatId (not releaseThread)');
    assert.equal(
      qp.actions.find((a) => a.op === 'releaseThread'),
      undefined,
      'releaseThread must NOT be called',
    );
  });

  it('returns 200 with canceledRecords=0 when thread has no stuck records', async () => {
    const { app } = await buildApp({ recordStore: makeRecordStore([]) });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.canceledRecords, 0);
  });

  it('releases stale processingSlots via running records even when cancelAll returns [] (P1: codex 6949db49)', async () => {
    // Stale case codex flagged: tracker slot already gone (cancelAll → []), but a running record +
    // its processingSlot persist. Pre-fix, slot release keyed only off cancelledCatIds → the orphan
    // processingSlot stayed pinning hasActiveExecution until TTL. Fix: also release slots for the
    // running records' targetCats (user-scoped via listRunningByThread).
    const staleRecord = {
      id: 'inv-stale',
      threadId: THREAD_ID,
      userId: USER_ID,
      targetCats: ['codex'],
      status: 'running',
      idempotencyKey: 'idem-stale',
      intent: 'execute',
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 120_000,
    };
    const qp = makeQueueProcessor();
    const tracker = makeTracker({ cancelAllReturn: [] }); // tracker slot already gone (stale)
    const { app, recordStore, broadcasts } = await buildApp({
      recordStore: makeRecordStore([staleRecord]),
      queueProcessor: qp,
      tracker,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal(JSON.parse(res.body).canceledRecords, 1);

    // P1: even though cancelAll returned [], the stale record's targetCat must still get its
    // processingSlot released — otherwise hasActiveExecution stays true until the slot TTL.
    const releaseSlotOps = qp.actions.filter((a) => a.op === 'releaseSlot' && a.cid === 'codex');
    assert.equal(releaseSlotOps.length, 1, 'stale record targetCat slot must be released even when cancelAll=[]');
    assert.equal(recordStore.updates.filter((u) => u.input.status === 'canceled').length, 1);

    // P2 (opus-4.6 cross-cat review): the stale cat must ALSO get a cancel broadcast + clearPause —
    // else the frontend "正在回复中" never clears after force-reset (cancelAll=[] so the cat isn't in
    // cancelledCatIds). All three (broadcast/clearPause/releaseSlot) must fire over slotsToRelease.
    assert.ok(broadcasts.length > 0, 'stale record cat must get a cancel broadcast so frontend clears');
    assert.ok(
      qp.actions.some((a) => a.op === 'clearPause' && a.cid === 'codex'),
      'clearPause must fire for the stale cat (aligned with orphan/normal cancel paths)',
    );
    const suppressStale = qp.actions.find((a) => a.op === 'suppressAutoResume' && a.cid === 'codex');
    assert.ok(suppressStale, 'stale record targetCat must also be fenced from delayed auto-resume');
    assert.deepEqual(
      suppressStale.executionIds,
      ['inv-stale'],
      'stale-record recovery must bind the fence to the record force-reset canceled',
    );
  });

  it('returns 404 when thread does not exist', async () => {
    const app = Fastify({ logger: false });
    const invocationQueue = new InvocationQueue();

    await app.register(queueRoutes, {
      threadStore: {
        get: async () => null, // no thread
        addParticipants: async () => {},
        updateLastActive: async () => {},
      },
      invocationQueue,
      queueProcessor: makeQueueProcessor(),
      invocationTracker: makeTracker(),
      socketManager: {
        broadcastToRoom: () => {},
        broadcastAgentMessage: () => {},
        getIO: () => ({}),
        emitToUser: () => {},
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/nonexistent-thread/force-reset`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 404);
  });
});
