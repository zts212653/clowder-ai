/**
 * F194 Phase B AC-B3 / AC-B4 — paired-route consistency regression.
 *
 * Spec contract (`docs/features/F194-invocation-liveness-canonical-read-model.md:190-191`):
 *   AC-B3: under (record running + tracker missing + fresh draft), `/api/messages` and
 *          `/api/threads/:threadId/queue` MUST agree on liveness — the draft must surface
 *          on /messages AND the cat must surface in /queue.activeInvocations.
 *   AC-B4: under (record running + tracker missing + no fresh draft + age past zombie grace),
 *          BOTH endpoints MUST filter the invocation out (no draft, no active slot).
 *
 * 砚砚 R8 P1: queue-only regression cannot prove paired consistency. This file registers
 * messagesRoutes + queueRoutes against the SAME (recordStore, draftStore, tracker) fixture
 * and asserts both endpoints' liveness views agree.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { messagesRoutes } = await import('../dist/routes/messages.js');
const { queueRoutes } = await import('../dist/routes/queue.js');

const THREAD_ID = 'thread-1';
const USER_ID = 'user-1';

function makeStubRouter() {
  return {
    resolveTargetsAndIntent: async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute', promptTags: [], targets: ['opus'] },
    }),
    route: async function* () {},
    routeExecution: async function* () {},
    getStrategyDeps: () => ({}),
    ackCollectedCursors: async () => {},
  };
}

function makeStubRegistry() {
  return { getLatestId: () => null, register: () => {} };
}

function makeStubSocketManager() {
  return {
    broadcastToRoom: () => {},
    broadcastAgentMessage: () => {},
    getIO: () => ({}),
    emitToUser: () => {},
  };
}

function makeRecordStore(records = []) {
  const byId = new Map(records.map((r) => [r.id, r]));
  return {
    create: () => {
      throw new Error('not implemented');
    },
    get: async (id) => byId.get(id) ?? null,
    update: () => {
      throw new Error('not implemented');
    },
    getByIdempotencyKey: () => null,
    listRunningByThread: (tid, uid) => {
      const out = [];
      for (const r of byId.values()) {
        if (r.status === 'running' && r.threadId === tid && r.userId === uid) out.push(r);
      }
      return out;
    },
  };
}

function makeTracker({ activeSlotsByThread = {}, userIds = {} } = {}) {
  return {
    has: () => false,
    getUserId: (tid, cid) => userIds[`${tid}:${cid}`] ?? null,
    cancel: () => ({ cancelled: false, catIds: [] }),
    getActiveSlots: (tid) => activeSlotsByThread[tid] ?? [],
  };
}

function makeRecord({
  id,
  threadId = THREAD_ID,
  userId = USER_ID,
  status = 'running',
  updatedAt,
  targetCats = ['opus'],
}) {
  return {
    id,
    threadId,
    userId,
    userMessageId: null,
    targetCats,
    intent: 'execute',
    status,
    idempotencyKey: `key-${id}`,
    createdAt: updatedAt - 1_000,
    updatedAt,
  };
}

async function buildPairedApp({ recordStore, draftStore, tracker }) {
  const app = Fastify({ logger: false });
  const messageStore = new MessageStore();
  await app.register(messagesRoutes, {
    registry: makeStubRegistry(),
    messageStore,
    socketManager: makeStubSocketManager(),
    router: makeStubRouter(),
    draftStore,
    invocationRecordStore: recordStore,
    invocationTracker: tracker,
  });
  // Stub thread store: any thread is public (createdBy='system')
  const threadStore = {
    get: async (id) => ({ id, title: 'Test', createdBy: 'system' }),
  };
  await app.register(queueRoutes, {
    threadStore,
    invocationQueue: new InvocationQueue(),
    queueProcessor: {
      processNext: async () => ({ started: false }),
      isPaused: () => false,
      getPauseReason: () => undefined,
      clearPause: () => {},
      releaseSlot: () => {},
      releaseThread: () => {},
    },
    invocationTracker: tracker,
    socketManager: makeStubSocketManager(),
    invocationRecordStore: recordStore,
    draftStore,
  });
  await app.ready();
  return app;
}

async function injectMessages(app) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/messages?threadId=${THREAD_ID}`,
    headers: { 'x-cat-cafe-user': USER_ID },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

async function injectQueue(app) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/threads/${THREAD_ID}/queue`,
    headers: { 'x-cat-cafe-user': USER_ID },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('F194 Phase B — paired /messages + /queue canonical liveness consistency', () => {
  it('AC-B3: record running + tracker missing + fresh draft → BOTH endpoints surface the invocation', async () => {
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-running', updatedAt: now - 60_000 });
    const draftStore = new DraftStore();
    draftStore.upsert({
      userId: USER_ID,
      threadId: THREAD_ID,
      invocationId: 'inv-running',
      catId: 'opus',
      content: 'streaming...',
      createdAt: now - 50_000,
      updatedAt: now - 100,
    });
    const recordStore = makeRecordStore([record]);
    const tracker = makeTracker(); // empty — split-brain reproducer

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = await buildPairedApp({ recordStore, draftStore, tracker });
      const msgs = await injectMessages(app);
      const queue = await injectQueue(app);

      assert.equal(msgs.statusCode, 200);
      assert.equal(queue.statusCode, 200);

      // /messages: draft-{invocationId} must appear in chatItems
      const draftItem =
        msgs.body.find?.((m) => m.id === 'draft-inv-running') ??
        msgs.body.messages?.find?.((m) => m.id === 'draft-inv-running');
      assert.ok(draftItem, '/messages must surface the live draft (canonical record+draft)');
      assert.equal(draftItem.isDraft, true);
      assert.equal(draftItem.catId, 'opus');

      // /queue: activeInvocations must contain opus active slot
      assert.equal(queue.body.activeInvocations.length, 1, '/queue must surface invocation as active');
      assert.equal(queue.body.activeInvocations[0].catId, 'opus');

      // Hard consistency assertion: both endpoints agree the invocation is live
      const messagesLiveCats = new Set([draftItem].map((m) => m.catId));
      const queueLiveCats = new Set(queue.body.activeInvocations.map((s) => s.catId));
      assert.deepEqual(
        [...messagesLiveCats].sort(),
        [...queueLiveCats].sort(),
        'AC-B3: messages and queue must agree on which cats are live',
      );
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it('AC-B7~B10 (P1-2 fix): zombie detected by /queue → reconcileZombies fires, record converges to failed + TaskProgress cleared', async () => {
    // Verifies the production callsite for reconcileZombies. After hitting /queue with a zombie
    // fixture, the record must transition running → failed and TaskProgress must be cleared,
    // even though the helper itself is read-only — proves AC-B7~B10 is wired into prod path.
    const now = 10_000_000;
    const zombieRecord = makeRecord({
      id: 'inv-zombie-cleanup',
      updatedAt: now - 700_000,
    });
    const draftStore = new DraftStore();
    const recordStore = {
      ...makeRecordStore([zombieRecord]),
      // Real update mutates the underlying record (vs makeRecordStore's no-op stub)
      update: async (id, input) => {
        if (id !== zombieRecord.id) return null;
        if (input.expectedStatus && zombieRecord.status !== input.expectedStatus) return null;
        if (input.status) zombieRecord.status = input.status;
        if (input.error !== undefined) zombieRecord.error = input.error;
        zombieRecord.updatedAt = Date.now();
        return zombieRecord;
      },
    };
    const cleared = [];
    const taskProgressStore = {
      deleteSnapshot: async (threadId, catId) => {
        cleared.push({ threadId, catId });
      },
    };
    const tracker = makeTracker();

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = Fastify({ logger: false });
      await app.register(queueRoutes, {
        threadStore: { get: async (id) => ({ id, title: 'Test', createdBy: 'system' }) },
        invocationQueue: new InvocationQueue(),
        queueProcessor: {
          processNext: async () => ({ started: false }),
          isPaused: () => false,
          getPauseReason: () => undefined,
          clearPause: () => {},
          releaseSlot: () => {},
          releaseThread: () => {},
        },
        invocationTracker: tracker,
        socketManager: makeStubSocketManager(),
        invocationRecordStore: recordStore,
        draftStore,
        taskProgressStore,
      });
      await app.ready();

      assert.equal(zombieRecord.status, 'running', 'sanity: starts running');

      const queueRes = await injectQueue(app);
      assert.equal(queueRes.statusCode, 200);
      assert.equal(queueRes.body.activeInvocations.length, 0, 'zombie not surfaced as active');

      // Allow fire-and-forget reconcileZombies microtask to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(zombieRecord.status, 'failed', 'reconcileZombies must mark record failed');
      assert.equal(zombieRecord.error, 'zombie_record_detected');
      assert.deepEqual(cleared, [{ threadId: THREAD_ID, catId: 'opus' }], 'TaskProgress cleared');
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it('cloud R17 P1: /messages reconciles zombies even when draft list is empty', async () => {
    // Reproduces cloud Codex P1 (comment 3211853817): the activeDrafts.length>0 gate
    // meant /api/messages skipped getThreadLiveInvocations entirely when a thread
    // had no drafts. But zombies are PRECISELY the no-draft case (record running +
    // no fresh draft + age past grace). Without this fix, /messages never reconciles
    // them; only /queue would, and a thread that's read but not queue-checked stays
    // phantom forever.
    //
    // Verify: zombie record + EMPTY draft store + GET /messages → reconcileZombies
    // fires (record transitions running → failed, TaskProgress cleared).
    const now = 20_000_000;
    const zombieRecord = makeRecord({
      id: 'inv-zombie-no-drafts',
      updatedAt: now - 700_000, // past zombie grace
    });
    const draftStore = new DraftStore(); // EMPTY — no drafts in this thread
    const recordStore = {
      ...makeRecordStore([zombieRecord]),
      update: async (id, input) => {
        if (id !== zombieRecord.id) return null;
        if (input.expectedStatus && zombieRecord.status !== input.expectedStatus) return null;
        if (input.status) zombieRecord.status = input.status;
        if (input.error !== undefined) zombieRecord.error = input.error;
        zombieRecord.updatedAt = Date.now();
        return zombieRecord;
      },
    };
    const cleared = [];
    const taskProgressStore = {
      deleteSnapshot: async (threadId, catId) => {
        cleared.push({ threadId, catId });
      },
    };
    const tracker = makeTracker(); // empty

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = Fastify({ logger: false });
      await app.register(messagesRoutes, {
        registry: makeStubRegistry(),
        messageStore: new MessageStore(),
        socketManager: makeStubSocketManager(),
        router: makeStubRouter(),
        draftStore,
        invocationRecordStore: recordStore,
        invocationTracker: tracker,
        taskProgressStore,
      });
      await app.ready();

      assert.equal(zombieRecord.status, 'running', 'sanity: starts running');
      assert.equal(draftStore.getByThread(USER_ID, THREAD_ID).length, 0, 'sanity: no drafts');

      const res = await app.inject({
        method: 'GET',
        url: `/api/messages?threadId=${THREAD_ID}`,
        headers: { 'x-cat-cafe-user': USER_ID },
      });
      assert.equal(res.statusCode, 200);

      // Allow fire-and-forget reconcileZombies microtask to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(zombieRecord.status, 'failed', 'reconcileZombies must fire from /messages even without drafts');
      assert.equal(zombieRecord.error, 'zombie_record_detected');
      assert.deepEqual(cleared, [{ threadId: THREAD_ID, catId: 'opus' }], 'TaskProgress cleared via /messages path');
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it('AC-B4: record running + tracker missing + no fresh draft + age > zombie grace → BOTH endpoints filter', async () => {
    const now = 10_000_000;
    const zombieRecord = makeRecord({
      id: 'inv-zombie',
      updatedAt: now - 700_000, // > 600_000ms (2x DraftStore TTL = zombie grace)
    });
    const draftStore = new DraftStore(); // empty
    const recordStore = makeRecordStore([zombieRecord]);
    const tracker = makeTracker(); // empty

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = await buildPairedApp({ recordStore, draftStore, tracker });
      const msgs = await injectMessages(app);
      const queue = await injectQueue(app);

      assert.equal(msgs.statusCode, 200);
      assert.equal(queue.statusCode, 200);

      // /messages: no draft surfaces (no draft in store anyway, but also no orphan resurrection)
      const draftItems = (msgs.body.messages ?? msgs.body ?? []).filter?.((m) => m.id?.startsWith?.('draft-')) ?? [];
      assert.equal(draftItems.length, 0, '/messages must not surface zombie draft');

      // /queue: no active invocations (zombie record filtered)
      assert.equal(queue.body.activeInvocations.length, 0, '/queue must not surface zombie as active');

      // Hard consistency: both endpoints agree the invocation is NOT live
      assert.equal(draftItems.length, 0);
      assert.equal(queue.body.activeInvocations.length, 0);
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });
});
