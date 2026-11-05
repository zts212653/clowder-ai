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
    // The active execution list reads the viewer's threads of the project.
    listByProject: async () => [{ id: THREAD_ID, createdBy: USER_ID }],
    addParticipants: async () => {},
    updateLastActive: async () => {},
  };
}

function makeQueueProcessor({ canReleaseSlotForUser = true } = {}) {
  const actions = [];
  return {
    canReleaseSlotForUser: () => canReleaseSlotForUser,
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
    ...(opts.agentSessionMutex ? { agentSessionMutex: opts.agentSessionMutex } : {}),
    ...opts.routeOptions,
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

  it('does not turn stale-lock recovery into terminal cleanup after a foreign slot appears', async () => {
    const queueProcessor = makeQueueProcessor({ canReleaseSlotForUser: false });
    const socketManager = makeSocketManager();
    const { app } = await buildApp({
      tracker: makeTracker({ hasSlot: false }),
      recordStore: makeRecordStore({ runningRecord: null }),
      queueProcessor,
      socketManager,
      agentSessionMutex: {
        forceReleaseByScope() {
          return { releasedHolders: 1, rejectedWaiters: 0, catIds: [CAT_ID] };
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_ID}`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, cancelled: false });
    assert.equal(socketManager.broadcasts.length, 0);
    assert.equal(
      queueProcessor.actions.some((action) => action.op === 'releaseSlot'),
      false,
    );
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

  it('cancels the stale record without terminal-cleaning a foreign processing owner', async () => {
    const runningRecord = {
      id: 'inv-orphan-foreign-owner',
      threadId: THREAD_ID,
      userId: USER_ID,
      targetCats: [CAT_ID],
      status: 'running',
      idempotencyKey: 'idem-foreign-owner',
      intent: 'execute',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    };
    const queueProcessor = makeQueueProcessor({ canReleaseSlotForUser: false });
    const socketManager = makeSocketManager();
    const { app, recordStore } = await buildApp({
      tracker: makeTracker({ hasSlot: false }),
      recordStore: makeRecordStore({ runningRecord }),
      queueProcessor,
      socketManager,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_ID}`,
      headers: { 'x-cat-cafe-user': USER_ID },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, cancelled: true });
    assert.equal(
      recordStore.updates.some((update) => update.input.status === 'canceled'),
      true,
    );
    assert.equal(socketManager.broadcasts.length, 0);
    assert.equal(
      queueProcessor.actions.some((action) => action.op === 'releaseSlot'),
      false,
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
    const lockScopes = [];
    const { app } = await buildApp({
      tracker: makeTracker({ hasSlot: false }), // all slots gone → all-orphan
      recordStore: makeRecordStore({ runningRecord }),
      socketManager,
      queueProcessor,
      agentSessionMutex: {
        forceReleaseByScope(scope) {
          lockScopes.push(scope);
          return { releasedHolders: 1, rejectedWaiters: 0 };
        },
      },
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
    assert.deepEqual(lockScopes, [
      { threadId: THREAD_ID, userId: USER_ID, catId: CAT_ID },
      { threadId: THREAD_ID, userId: USER_ID, catId: 'codex' },
    ]);
  });

  it('marks the orphan record canceled before releasing its session locks', async () => {
    const runningRecord = {
      id: 'inv-orphan-ordering',
      threadId: THREAD_ID,
      userId: USER_ID,
      targetCats: [CAT_ID],
      status: 'running',
      idempotencyKey: 'idem-ordering',
      intent: 'execute',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    };
    const recordStore = makeRecordStore({ runningRecord });
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
      tracker: makeTracker({ hasSlot: false }),
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
      url: `/api/threads/${THREAD_ID}/cancel/${CAT_ID}`,
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
      'a promoted invocation must not observe the orphan record while it is still running',
    );
    assert.deepEqual(lockScopes, [{ threadId: THREAD_ID, userId: USER_ID, catId: CAT_ID }]);
  });
});

describe('#1838 cancel route: a dead API s started provider stops only with its job proof', async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { InMemoryTurnExecutionStore } = await import(
    '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
  );
  const { findWindowsLiveOwner, stopWithWindowsJobProof } = await import(
    '../dist/domains/cats/services/agents/invocation/WindowsJobStopRecovery.js'
  );
  const { recordWindowsJobExecutionLink } = await import('../dist/utils/windows-job-execution-links.js');
  const { resolveWindowsJobDirectory } = await import('../dist/utils/windows-job-owner.js');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
  const { lifecycleResponseIdempotencyKey } = await import(
    '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js'
  );
  const JOB = `Local${String.fromCharCode(92)}ClowderApiJob-cancel-test`;
  const verdict = (observed) => async () => ({ stdout: `${JSON.stringify(observed)}\r\n`, stderr: '' });
  const ROUTES = {
    cancel: () => ({ url: `/api/threads/${THREAD_ID}/cancel/${CAT_ID}` }),
    'force-reset': () => ({ url: `/api/threads/${THREAD_ID}/force-reset` }),
    // The active execution list's own Stop, on the candidate it still projects.
    live: (parent) => ({
      url: `/api/threads/${THREAD_ID}/executions/live/${parent}/cancel`,
      payload: { catId: CAT_ID },
    }),
  };

  async function stopAfterApiDied(
    t,
    execute,
    route = 'cancel',
    {
      settleFails = false,
      tracked = false,
      parentEnded = false,
      childFinished = false,
      siblingFinished = false,
      noLink = false,
    } = {},
  ) {
    const dataDir = mkdtempSync(join(tmpdir(), 'issue1838-cancel-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    mkdirSync(resolveWindowsJobDirectory(dataDir), { recursive: true });
    writeFileSync(
      join(resolveWindowsJobDirectory(dataDir), 'owner.json'),
      JSON.stringify({ v: 1, jobName: JOB, apiPid: 4321, helperPid: 4322, sessionId: 1, createdAt: 1 }),
    );
    const parent = 'inv-dead-api';
    const execution = { executionId: parent, invocationId: 'child-dead-api', threadId: THREAD_ID, catId: CAT_ID };
    const turns = new InMemoryTurnExecutionStore();
    turns.createRunning({
      ...execution,
      parentInvocationId: parent,
      userId: USER_ID,
      executionKind: 'ordinary',
      startedAt: 1,
      providerLifecycleTracked: true,
    });
    turns.markProviderStarted(execution.invocationId, 2);
    // A turn that finished on its own: terminal, its reply still owed on the KD-21 ledger.
    if (childFinished)
      turns.transitionTerminal(execution.invocationId, { status: 'succeeded', endedAt: 3, providerTeardownAt: 3 });
    // `noLink`: a started child no host job ever owned (no link at all).
    if (!noLink) recordWindowsJobExecutionLink({ dataDir, jobName: JOB, execution: { ...execution, userId: USER_ID } });
    // The turn's processing R and its streamed draft, keyed exactly as QueueProcessor writes them.
    const messageStore = new MessageStore();
    const draftStore = new DraftStore();
    // Another turn of the same parent and cat that finished on its own, its reply still owed.
    const sibling = siblingFinished ? 'child-finished' : undefined;
    if (sibling) {
      turns.createRunning({
        ...execution,
        invocationId: sibling,
        parentInvocationId: parent,
        userId: USER_ID,
        executionKind: 'ordinary',
        startedAt: 1,
        providerLifecycleTracked: true,
      });
      turns.markProviderStarted(sibling, 2);
      turns.transitionTerminal(sibling, { status: 'succeeded', endedAt: 3, providerTeardownAt: 3 });
    }
    const siblingResponse = sibling
      ? await messageStore.append({
          from: { kind: 'agent', catId: CAT_ID },
          userId: USER_ID,
          threadId: THREAD_ID,
          mentions: [],
          content: '',
          origin: 'stream',
          timestamp: 1,
          idempotencyKey: lifecycleResponseIdempotencyKey(sibling),
          lifecycle: {
            kind: 'response',
            orderKey: `1:${sibling}`,
            invocationId: sibling,
            targetId: CAT_ID,
            inputEntryIds: [],
            inputMessageIds: [],
            status: 'processing',
            startedAt: 1,
          },
        })
      : undefined;
    const response = await messageStore.append({
      from: { kind: 'agent', catId: CAT_ID },
      userId: USER_ID,
      threadId: THREAD_ID,
      mentions: [],
      content: '',
      origin: 'stream',
      timestamp: 1,
      idempotencyKey: lifecycleResponseIdempotencyKey(execution.invocationId),
      lifecycle: {
        kind: 'response',
        orderKey: `1:${execution.invocationId}`,
        invocationId: execution.invocationId,
        targetId: CAT_ID,
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: 1,
      },
    });
    draftStore.upsert({
      userId: USER_ID,
      threadId: THREAD_ID,
      invocationId: execution.invocationId,
      catId: CAT_ID,
      content: 'streamed body',
      updatedAt: 2,
    });
    // A failing response store that the test can heal, so a retry runs the real settlement path.
    let rejectCommit = settleFails;
    const responseStore = new Proxy(messageStore, {
      get: (target, property) =>
        property === 'commitLifecycleResponseTerminal' && rejectCommit
          ? () => {
              throw new Error('response terminal store unavailable');
            }
          : target[property],
    });
    const aborts = [];
    const tracker = makeTracker({ hasSlot: tracked });
    tracker.getExecutionId = () => parent;
    tracker.cancelAll = (_thread, _user, reason) => {
      aborts.push(reason);
      return { catIds: [CAT_ID], executionIds: [parent], executionIdByCatId: { [CAT_ID]: parent } };
    };
    const { app, recordStore, queueProcessor } = await buildApp({
      queueProcessor: {
        ...makeQueueProcessor(),
        retireThreadPrestartProcessingGroups: async () => ({ outcome: 'none', retiredCatIds: [] }),
        suppressAutoResume: () => {},
        hasProcessingSlotReservation: () => false,
      },
      tracker,
      recordStore: makeRecordStore({
        runningRecord: {
          id: parent,
          threadId: THREAD_ID,
          userId: USER_ID,
          targetCats: [CAT_ID],
          // An older cancel/reset ended the parent but left its started child running.
          status: parentEnded ? 'canceled' : 'running',
          idempotencyKey: 'idem-dead-api',
          intent: 'execute',
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 60_000,
        },
      }),
      routeOptions: {
        turnExecutionStore: turns,
        messageStore: responseStore,
        draftStore,
        cliExecutionOwnerService: { listLive: async () => ({ complete: true, owners: [] }) },
        // index.ts wires exactly this on Windows; only the native job query is fixed here.
        stopUnconfirmedProvider: (record) => stopWithWindowsJobProof({ store: turns, record, dataDir, execute }),
        findWindowsLiveOwner: (records) => findWindowsLiveOwner({ records, dataDir, execute }),
      },
    });
    const { url, payload } = ROUTES[route](parent);
    const res = await app.inject({
      method: 'POST',
      url,
      ...(payload ? { payload } : {}),
      headers: { 'x-cat-cafe-user': USER_ID },
    });
    t.after(() => app.close());
    return {
      res,
      // What the active execution list showed before the Stop.
      listed: () =>
        app
          .inject({
            method: 'GET',
            url: `/api/threads/${THREAD_ID}/executions/active`,
            headers: { 'x-cat-cafe-user': USER_ID },
          })
          .then((list) => JSON.parse(list.body).executions ?? []),
      child: turns.get(execution.invocationId),
      recordStore,
      queueProcessor,
      turns,
      aborts,
      response: await messageStore.getById(response.id),
      readResponse: () => messageStore.getById(response.id),
      readSibling: () => (siblingResponse ? messageStore.getById(siblingResponse.id) : undefined),
      draft: draftStore.getByThread(USER_ID, THREAD_ID)[0],
      readDraft: () => draftStore.getByThread(USER_ID, THREAD_ID)[0],
      // The same Stop again, after the response store recovers.
      retry: async () => {
        rejectCommit = false;
        const again = ROUTES[route](parent);
        return app.inject({
          method: 'POST',
          url: again.url,
          ...(again.payload ? { payload: again.payload } : {}),
          headers: { 'x-cat-cafe-user': USER_ID },
        });
      },
    };
  }

  it('keeps the execution and names the reason while its job still owns members', async (t) => {
    const { res, child, recordStore, queueProcessor } = await stopAfterApiDied(
      t,
      verdict({ state: 'present', activeProcesses: 2, sessionId: 1 }),
    );
    assert.equal(res.statusCode, 503, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PROVIDER_TEARDOWN_UNCONFIRMED');
    assert.match(body.error, /job_present:/, 'the user sees why the stop is not confirmed');
    assert.equal(child.status, 'running', 'no success is reported without proof');
    assert.equal(
      recordStore.updates.some((update) => update.input.status === 'canceled'),
      false,
      'the parent is not canceled while its provider may still run',
    );
    assert.equal(
      queueProcessor.actions.some((action) => action.op === 'releaseSlot'),
      false,
    );
  });

  it('cancels the execution with the proof once its job verifiably closed', async (t) => {
    const { res, child, recordStore } = await stopAfterApiDied(
      t,
      verdict({ state: 'absent', nativeError: 2, sessionId: 1 }),
    );
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([child.status, child.terminalReason], ['canceled', 'user_cancel']);
    assert.equal(typeof child.providerTeardownAt, 'number');
    assert.ok(recordStore.updates.some((update) => update.id === 'inv-dead-api' && update.input.status === 'canceled'));
  });

  // The same 1,250-line route also had a second Stop entry: force-reset canceled every running parent
  // directly, so a parent disappeared from the live list while its unconfirmed child kept blocking.
  it('force-reset keeps an unconfirmed child and its parent while the job is present', async (t) => {
    const { res, child, recordStore } = await stopAfterApiDied(
      t,
      verdict({ state: 'present', activeProcesses: 2, sessionId: 1 }),
      'force-reset',
    );
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(JSON.parse(res.body).code, 'PROVIDER_TEARDOWN_UNCONFIRMED');
    assert.equal(child.status, 'running', 'the blocking child stays visible');
    assert.equal(
      recordStore.updates.some((update) => update.input.status === 'canceled'),
      false,
      'the parent is not canceled while its child may still run',
    );
  });

  it('force-reset cancels the parent once the exact proof stops its child', async (t) => {
    const { res, child, recordStore } = await stopAfterApiDied(
      t,
      verdict({ state: 'absent', nativeError: 2, sessionId: 1 }),
      'force-reset',
    );
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(child.status, 'canceled');
    assert.ok(recordStore.updates.some((update) => update.id === 'inv-dead-api' && update.input.status === 'canceled'));
  });

  // A successful Stop must settle the reply it ended, not leave it streaming until the next startup.
  it('settles the stopped turn s processing response in this API lifetime', async (t) => {
    const { res, child, response, turns, draft } = await stopAfterApiDied(
      t,
      verdict({ state: 'absent', nativeError: 2, sessionId: 1 }),
    );
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(child.status, 'canceled');
    assert.equal(response.lifecycle.status, 'canceled', 'the old reply is terminal');
    assert.equal(response.content, 'streamed body', 'the streamed body is kept');
    assert.deepEqual(await turns.listResponsePending(), [], 'nothing is left for the next startup');
    assert.equal(draft, undefined, 'the settled draft is gone');
  });

  // force-reset must not refuse a reset this API can perform itself: a cat it still controls locally
  // is aborted through the normal cancelAll path, so the job proof is not what ends that execution.
  it('force-reset still aborts the provider this API controls locally', async (t) => {
    const { res, aborts } = await stopAfterApiDied(
      t,
      verdict({ state: 'present', activeProcesses: 2, sessionId: 1 }),
      'force-reset',
      { tracked: true },
    );
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(aborts, ['cancel_all'], 'the locally controlled provider gets its normal abort');
  });

  // The end of a Stop is not the provider proof alone: when the reply it ended cannot be committed,
  // reporting success would hide a still-streaming reply behind a green Stop.
  it('reports the unfinished reply instead of a Stop it did not complete', async (t) => {
    const { res, child, turns } = await stopAfterApiDied(
      t,
      verdict({ state: 'absent', nativeError: 2, sessionId: 1 }),
      'cancel',
      { settleFails: true },
    );
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(JSON.parse(res.body).code, 'EXECUTION_RESPONSE_SETTLEMENT_FAILED');
    assert.equal(child.status, 'canceled', 'the exact proof did end the child');
    assert.equal(
      (await turns.listResponsePending()).length,
      1,
      'the uncommitted reply stays on the pending ledger for the next startup',
    );
  });

  // The child above is already terminal, so a retry cannot find a running child to stop. It must
  // still finish the reply the failed attempt left owed instead of reporting a success.
  it('a retry settles the reply the failed Stop left owed', async (t) => {
    const { res, turns, readResponse, retry } = await stopAfterApiDied(
      t,
      verdict({ state: 'absent', nativeError: 2, sessionId: 1 }),
      'cancel',
      { settleFails: true },
    );
    assert.equal(res.statusCode, 503, res.body);
    assert.equal((await readResponse()).lifecycle.status, 'processing', 'the first attempt left R owed');

    const second = await retry();
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((await readResponse()).lifecycle.status, 'canceled', 'the retry settled the old reply');
    assert.deepEqual(await turns.listResponsePending(), [], 'nothing is left owed');
  });

  // The active execution list's Stop has its own route; it must report the actual refusal, not a
  // generic control-plane error that hides which job still owns the execution.
  it('the active execution Stop reports its actual Job refusal', async (t) => {
    const { res } = await stopAfterApiDied(t, verdict({ state: 'present', activeProcesses: 2, sessionId: 1 }), 'live');
    assert.equal(res.statusCode, 503, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PROVIDER_TEARDOWN_UNCONFIRMED');
    assert.match(body.error, /job_present:/);
  });

  // #1838 owner P1: an older cancel/reset ended the parent and left its started child running.
  // Admission still refuses the role on that child, so every Stop entry must reach it through its
  // exact parent: unknown/present keep it listed, a verified stop ends it and its reply.
  for (const route of ['live', 'cancel', 'force-reset']) {
    // A job still present is positive proof of a live owner: the Stop refuses and keeps the child.
    it(`ended parent: ${route} keeps the child listed while its job is present`, async (t) => {
      const { res, child, recordStore, listed } = await stopAfterApiDied(
        t,
        verdict({ state: 'present', activeProcesses: 2, sessionId: 1 }),
        route,
        { parentEnded: true },
      );
      assert.equal(res.statusCode, 503, res.body);
      assert.match(JSON.parse(res.body).code, /^PROVIDER_(TEARDOWN_UNCONFIRMED|LIVE_OWNER)$/);
      assert.equal(child.status, 'running');
      assert.deepEqual(
        (await listed()).map(({ executionId, catId }) => ({ executionId, catId })),
        [{ executionId: 'inv-dead-api', catId: CAT_ID }],
        'the blocking child stays visible under its exact parent',
      );
      assert.deepEqual(recordStore.updates, [], 'the ended parent is not touched');
    });
    for (const evidence of ['unknown', 'no-link']) {
      const modeOptions = evidence === 'no-link' ? { noLink: true } : {};
      // #1849: an unknown job, or no link at all, is no live owner. The Stop ends the child through its owner path with its
      // physical exit unknown: no teardown is written, and the ended parent is never reopened.
      it(`ended parent: ${route} ends the child without a teardown when its job is ${evidence}`, async (t) => {
        const { res, child, recordStore, listed } = await stopAfterApiDied(
          t,
          verdict({ state: 'unknown', nativeError: 5, sessionId: 1 }),
          route,
          { parentEnded: true, ...modeOptions },
        );
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(
          [child.status, child.terminalReason],
          ['canceled', 'user_cancel'],
          'the unknown no longer blocks its role',
        );
        assert.equal(child.providerTeardownAt, undefined, 'no proof, so no teardown is written');
        assert.deepEqual(await listed(), []);
        assert.deepEqual(recordStore.updates, [], 'the ended parent is not touched');
      });
      // The unknown case when the first Stop ended the child but could not commit its reply: the same
      // Stop again settles that reply, still without a teardown and without reopening the parent.
      it(`ended parent: a ${route} retry settles the reply of a child whose job is ${evidence}`, async (t) => {
        const { res, turns, readResponse, readDraft, retry, recordStore } = await stopAfterApiDied(
          t,
          verdict({ state: 'unknown', nativeError: 5, sessionId: 1 }),
          route,
          { parentEnded: true, settleFails: true, ...modeOptions },
        );
        assert.equal(res.statusCode, 503, res.body);
        const ended = await turns.get('child-dead-api');
        assert.deepEqual(
          [ended.status, ended.terminalReason],
          ['canceled', 'user_cancel'],
          'the first attempt already ended the child',
        );
        assert.equal(ended.providerTeardownAt, undefined);
        assert.equal((await readResponse()).lifecycle.status, 'processing', 'its reply is still owed');

        const second = await retry();
        assert.equal(second.statusCode, 200, second.body);
        assert.deepEqual(
          [(await readResponse()).lifecycle.status, (await readResponse()).content],
          ['canceled', 'streamed body'],
          'the retry settled the reply with what it streamed',
        );
        assert.deepEqual(await turns.listResponsePending(), [], 'nothing is left owed');
        assert.equal((await turns.get('child-dead-api')).providerTeardownAt, undefined, 'still no teardown');
        assert.equal(readDraft(), undefined, 'the settled draft is gone');
        assert.deepEqual(recordStore.updates, [], 'the ended parent is never reopened or rewritten');
      });
    }
    it(`ended parent: ${route} ends the child and its reply with the exact proof only`, async (t) => {
      const { res, child, response, turns, recordStore, listed } = await stopAfterApiDied(
        t,
        verdict({ state: 'absent', nativeError: 2, sessionId: 1 }),
        route,
        { parentEnded: true },
      );
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual([child.status, typeof child.providerTeardownAt], ['canceled', 'number']);
      assert.deepEqual([response.lifecycle.status, response.content], ['canceled', 'streamed body']);
      assert.deepEqual(await turns.listResponsePending(), [], 'nothing is left for the next startup');
      assert.deepEqual(await listed(), []);
      assert.deepEqual(recordStore.updates, [], 'the ended parent is never reopened or rewritten');
    });
    // The first Stop ended the child but could not commit its reply. The child is no longer running,
    // so the retry has to find it through the pending ledger and finish that same reply.
    it(`ended parent: a ${route} retry settles the reply a failed commit left owed`, async (t) => {
      const { res, child, turns, readResponse, retry, recordStore } = await stopAfterApiDied(
        t,
        verdict({ state: 'absent', nativeError: 2, sessionId: 1 }),
        route,
        { settleFails: true, parentEnded: true },
      );
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(JSON.parse(res.body).code, 'EXECUTION_RESPONSE_SETTLEMENT_FAILED');
      assert.equal(child.status, 'canceled', 'the exact proof did end the child');
      assert.equal((await readResponse()).lifecycle.status, 'processing', 'the first attempt left R owed');
      assert.equal((await turns.listResponsePending()).length, 1);

      const second = await retry();
      assert.equal(second.statusCode, 200, second.body);
      assert.equal((await readResponse()).lifecycle.status, 'canceled', 'the retry settled the old reply');
      assert.deepEqual(await turns.listResponsePending(), [], 'nothing is left owed');
      assert.deepEqual(recordStore.updates, [], 'the ended parent is never reopened or rewritten');
    });
  }
  // Only a turn a Stop ended is the Stop's to settle. A turn that finished on its own keeps its owed
  // reply for its own settlement, never relabeled canceled by a later cancel of its cat.
  it('ended parent: cancel leaves a turn that finished on its own to its own settlement', async (t) => {
    const { res, turns, readResponse, recordStore } = await stopAfterApiDied(
      t,
      verdict({ state: 'absent', nativeError: 2, sessionId: 1 }),
      'cancel',
      { parentEnded: true, childFinished: true },
    );
    assert.equal(res.statusCode, 404, res.body);
    assert.equal((await readResponse()).lifecycle.status, 'processing', 'the reply is not relabeled canceled');
    assert.equal((await turns.listResponsePending()).length, 1, 'its own settlement still owns the reply');
    assert.deepEqual(recordStore.updates, []);
  });
  // Maintainer P1 (34df): a Stop-ended turn and a turn that finished on its own, both owing their
  // reply, under the same parent and cat. The Stop settles only the turn it ended; the other keeps
  // its own settlement and is never relabeled canceled, on every Stop entry.
  for (const route of ['live', 'cancel', 'force-reset']) {
    it(`ended parent: ${route} settles only the turn it stopped when another owes its own reply`, async (t) => {
      const { res, child, turns, readResponse, readSibling } = await stopAfterApiDied(
        t,
        verdict({ state: 'absent', nativeError: 2, sessionId: 1 }),
        route,
        { parentEnded: true, siblingFinished: true },
      );
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(child.status, 'canceled');
      assert.equal((await readResponse()).lifecycle.status, 'canceled', 'the stopped turn s reply is settled');
      assert.equal((await readSibling()).lifecycle.status, 'processing', 'the finished turn s reply is not relabeled');
      assert.deepEqual(
        (await turns.listResponsePending()).map((record) => [record.invocationId, record.status]),
        [['child-finished', 'succeeded']],
        'the finished turn stays owed to its own settlement',
      );
    });
  }
});
