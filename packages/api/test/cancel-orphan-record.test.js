/**
 * Thread 1 regression: cancel route orphan-record cleanup
 *
 * Bug (docs/bug-report/2026-05-29-invocation-stale-active-recovery §3.2):
 *   POST /api/threads/:threadId/cancel/:catId returns 404 when
 *   invocationTracker.has() is false — even if there's a running InvocationRecord.
 *   Orphan invocations (slot already cleared) can never be canceled → record
 *   stays 'running' → getThreadLiveInvocations detects it as zombie forever.
 *
 * Fix: when tracker has no slot, also check invocationRecordStore for a
 * running record scoped to this (threadId, userId, catId). If found, mark it
 * canceled and return { ok: true, cancelled: true } instead of 404.
 *
 * RED → GREEN after fix in packages/api/src/routes/queue.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { queueRoutes } = await import('../dist/routes/queue.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

const THREAD_ID = 'thread-cancel-orphan';
const USER_ID = 'user-1';
const CAT_ID = 'opus';

function makeTracker({ hasSlot = false } = {}) {
  const canceled = [];
  return {
    has: (tid, cid) => hasSlot && tid === THREAD_ID && (!cid || cid === CAT_ID),
    getUserId: () => USER_ID,
    cancel: (tid, cid, uid, reason) => {
      canceled.push({ tid, cid, uid, reason });
      return { cancelled: true, catIds: [cid] };
    },
    getActiveSlots: () => [],
    canceled,
  };
}

function makeRecordStore({ runningRecord = null } = {}) {
  const updates = [];
  const records = new Map();
  if (runningRecord) records.set(runningRecord.id, { ...runningRecord });

  return {
    get: async (id) => records.get(id) ?? null,
    create: () => ({ outcome: 'created', invocationId: 'inv-test' }),
    update: async (id, input) => {
      updates.push({ id, input });
      const rec = records.get(id);
      if (rec) {
        const updated = { ...rec, ...input, updatedAt: Date.now() };
        records.set(id, updated);
        return updated;
      }
      return null;
    },
    getByIdempotencyKey: () => null,
    listRunningByThread: (tid, uid) => {
      const out = [];
      for (const r of records.values()) {
        if (r.status === 'running' && r.threadId === tid && r.userId === uid) {
          out.push(r);
        }
      }
      return out;
    },
    updates,
  };
}

function makeSocketManager() {
  const broadcasts = [];
  return {
    broadcastToRoom: () => {},
    broadcastAgentMessage: (m, tid) => broadcasts.push({ m, tid }),
    getIO: () => ({}),
    emitToUser: () => {},
    broadcasts,
  };
}

function makeThreadStore() {
  return {
    get: async (id) => ({ id, createdBy: USER_ID }),
    addParticipants: async () => {},
    updateLastActive: async () => {},
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

async function buildApp(opts = {}) {
  const app = Fastify({ logger: false });

  const invocationQueue = new InvocationQueue();
  const tracker = opts.tracker ?? makeTracker();
  const recordStore = opts.recordStore ?? makeRecordStore();
  const socketManager = opts.socketManager ?? makeSocketManager();
  const queueProcessor = opts.queueProcessor ?? makeQueueProcessor();

  await app.register(queueRoutes, {
    threadStore: makeThreadStore(),
    invocationQueue,
    queueProcessor,
    invocationTracker: tracker,
    socketManager,
    invocationRecordStore: recordStore,
  });

  await app.ready();
  return { app, tracker, recordStore, socketManager, queueProcessor };
}

// ── Test 1: tracker has no slot, NO record → 404 (unchanged behavior) ──
describe('cancel route: no slot, no record → 404', () => {
  it('returns 404 when tracker has no slot and no running record exists', async () => {
    const { app } = await buildApp({
      tracker: makeTracker({ hasSlot: false }),
      recordStore: makeRecordStore({ runningRecord: null }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_ID}`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'CAT_NOT_ACTIVE');
  });
});

// ── Test 2 (RED): tracker has no slot, BUT running record exists → should cancel record ──
describe('cancel route: orphan record cleanup (Thread 1 regression)', () => {
  it('marks running InvocationRecord as canceled when tracker has no slot (orphan)', async () => {
    const runningRecord = {
      id: 'inv-orphan-001',
      threadId: THREAD_ID,
      userId: USER_ID,
      targetCats: [CAT_ID],
      status: 'running',
      idempotencyKey: 'idem-1',
      intent: 'execute',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    };

    const recordStore = makeRecordStore({ runningRecord });
    const queueProcessor = makeQueueProcessor();

    const { app, recordStore: store } = await buildApp({
      tracker: makeTracker({ hasSlot: false }),
      recordStore,
      queueProcessor,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_ID}`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    // Expect 200 (not 404) — orphan record was found and canceled
    assert.equal(res.statusCode, 200, `Expected 200 when orphan record exists, got ${res.statusCode}: ${res.body}`);

    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, 'ok should be true');
    assert.equal(body.cancelled, true, 'cancelled should be true for orphan record cleanup');

    // The record should have been marked as 'canceled'
    const cancelUpdate = store.updates.find((u) => u.id === 'inv-orphan-001' && u.input.status === 'canceled');
    assert.ok(
      cancelUpdate,
      `Expected InvocationRecord 'inv-orphan-001' to be marked canceled. Updates: ${JSON.stringify(store.updates)}`,
    );

    // P1 (cloud codex): releaseSlot must be called to clear processingSlots (secondary busy source)
    const releaseSlotAction = queueProcessor.actions.find(
      (a) => a.op === 'releaseSlot' && a.tid === THREAD_ID && a.cid === CAT_ID,
    );
    assert.ok(
      releaseSlotAction,
      `releaseSlot must be called for orphan cancel to clear processingSlots. Actions: ${JSON.stringify(queueProcessor.actions)}`,
    );
  });

  it('does NOT cancel records for a different catId', async () => {
    // Running record for 'codex', but cancel request is for 'opus'
    const runningRecord = {
      id: 'inv-other-cat',
      threadId: THREAD_ID,
      userId: USER_ID,
      targetCats: ['codex'],
      status: 'running',
      idempotencyKey: 'idem-2',
      intent: 'execute',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    };

    const recordStore = makeRecordStore({ runningRecord });

    const { app, recordStore: store } = await buildApp({
      tracker: makeTracker({ hasSlot: false }),
      recordStore,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_ID}`, // cancel 'opus' not 'codex'
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    // Should 404 — no running record for 'opus'
    assert.equal(res.statusCode, 404, `Expected 404 when no running opus record, got ${res.statusCode}`);
    assert.equal(store.updates.length, 0, 'should NOT cancel codex record when canceling opus');
  });

  it('broadcasts cancel messages immediately so frontend clears "正在回复中" state (P2-1)', async () => {
    // P2-1: orphan cancel should broadcast so frontend doesn't wait for the next liveness poll
    const runningRecord = {
      id: 'inv-orphan-p2',
      threadId: THREAD_ID,
      userId: USER_ID,
      targetCats: [CAT_ID],
      status: 'running',
      idempotencyKey: 'idem-p2',
      intent: 'execute',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    };

    const socketManager = makeSocketManager();
    const { app } = await buildApp({
      tracker: makeTracker({ hasSlot: false }),
      recordStore: makeRecordStore({ runningRecord }),
      socketManager,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_ID}`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200);

    // Cancel messages should have been broadcast (not just the record update)
    assert.ok(
      socketManager.broadcasts.length > 0,
      `Expected at least one broadcast after orphan cancel (for frontend "正在回复中" clear). Got ${socketManager.broadcasts.length} broadcasts`,
    );
    const cancelBroadcast = socketManager.broadcasts.find((b) => b.tid === THREAD_ID);
    assert.ok(cancelBroadcast, 'Broadcast should target the correct thread');
  });

  it('releases + broadcasts ALL targetCats when canceling an all-orphan multi-cat record (P2: codex 第4轮 a5e8eea2)', async () => {
    // Multi-cat orphan record [opus, codex], all tracker slots gone. Canceling opus marks the whole
    // record canceled — so release must fire for codex too, else codex stays stuck in the client +
    // its processingSlot leaks (and force-reset can't rediscover it: record is no longer running).
    const runningRecord = {
      id: 'inv-multicat-orphan',
      threadId: THREAD_ID,
      userId: USER_ID,
      targetCats: [CAT_ID, 'codex'],
      status: 'running',
      idempotencyKey: 'idem-multicat',
      intent: 'execute',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    };
    const socketManager = makeSocketManager();
    const queueProcessor = makeQueueProcessor();
    const { app } = await buildApp({
      tracker: makeTracker({ hasSlot: false }), // all slots gone → all-orphan
      recordStore: makeRecordStore({ runningRecord }),
      socketManager,
      queueProcessor,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_ID}`, // cancel opus
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    // releaseSlot must fire for BOTH opus and codex — the whole record was canceled.
    const released = queueProcessor.actions.filter((a) => a.op === 'releaseSlot').map((a) => a.cid);
    assert.ok(released.includes(CAT_ID), 'requested cat (opus) slot must be released');
    assert.ok(released.includes('codex'), 'sibling cat (codex) slot must ALSO be released when whole record canceled');
  });
});
