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

function makeQueueProcessor() {
  const actions = [];
  return {
    clearPause: (tid, cid) => actions.push({ op: 'clearPause', tid, cid }),
    releaseSlot: (tid, cid) => actions.push({ op: 'releaseSlot', tid, cid }),
    releaseThread: (tid) => actions.push({ op: 'releaseThread', tid }),
    hasActiveExecution: () => false,
    isCatBusy: () => false,
    actions,
  };
}

function makeTracker({ cancelAllReturn = [] } = {}) {
  const cancelAllCalls = [];
  return {
    has: () => false,
    getUserId: () => USER_ID,
    cancel: () => ({ cancelled: false, catIds: [] }),
    getActiveSlots: () => [],
    cancelAll: (tid, uid, reason) => {
      cancelAllCalls.push({ tid, uid, reason });
      return cancelAllReturn;
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
  });

  await app.ready();
  return { app, queueProcessor: qp, recordStore: rs, tracker, broadcasts };
}

// ── RED tests ──

describe('force-reset: releases all stuck state for a thread (escape hatch)', () => {
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
    const tracker = makeTracker({ cancelAllReturn: ['opus', 'codex'] });
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
