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
const UNDECLARED_FRESHNESS_CARRIER_CAPABILITY = {
  provider: 'other',
  carrier: 'other',
  deliverySemantics: 'undeclared',
};

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

function makeStubRegistry({ turns = {}, latestByCat = {} } = {}) {
  return {
    getRecord: async (id) => turns[id] ?? null,
    getLatestId: (threadId, catId) => latestByCat[`${threadId}:${catId}`] ?? null,
    register: () => {},
  };
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

async function buildPairedApp({ recordStore, draftStore, tracker, turnExecutionStore, registry = makeStubRegistry() }) {
  const app = Fastify({ logger: false });
  const messageStore = new MessageStore();
  await app.register(messagesRoutes, {
    registry,
    messageStore,
    socketManager: makeStubSocketManager(),
    router: makeStubRouter(),
    draftStore,
    invocationRecordStore: recordStore,
    invocationTracker: tracker,
    ...(turnExecutionStore ? { turnExecutionStore } : {}),
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
    invocationRegistry: registry,
    ...(turnExecutionStore ? { turnExecutionStore } : {}),
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

  it('GET /queue reports a zombie diagnostically without terminal side effects', async () => {
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
      deleteSnapshotIfOwner: async (threadId, catId) => {
        cleared.push({ threadId, catId });
        return true;
      },
    };
    const tracker = makeTracker();
    const terminalEvents = [];

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
        onReconciledZombie: async (event) => terminalEvents.push(event),
      });
      await app.ready();

      assert.equal(zombieRecord.status, 'running', 'sanity: starts running');

      const queueRes = await injectQueue(app);
      assert.equal(queueRes.statusCode, 200);
      assert.equal(queueRes.body.activeInvocations.length, 0, 'zombie not surfaced as active');

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(zombieRecord.status, 'running', 'read endpoints must not write lifecycle truth');
      assert.deepEqual(cleared, [], 'read endpoints must not clear owner projections');
      assert.deepEqual(terminalEvents, [], 'explicit owner reaper is the only terminal carrier');
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it('GET /messages stays side-effect free when a zombie has no draft', async () => {
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
      deleteSnapshotIfOwner: async (threadId, catId) => {
        cleared.push({ threadId, catId });
        return true;
      },
    };
    const tracker = makeTracker(); // empty
    const terminalEvents = [];

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
        onReconciledZombie: async (event) => terminalEvents.push(event),
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

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(zombieRecord.status, 'running', 'GET /messages must not write lifecycle truth');
      assert.deepEqual(cleared, []);
      assert.deepEqual(terminalEvents, []);
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

  it('durable running child prevents read-triggered zombie reconciliation on both routes', async () => {
    const now = 30_000_000;
    const parentId = 'parent-handoff-gap';
    const childId = 'child-handoff-fable';
    const parent = makeRecord({
      id: parentId,
      updatedAt: now - 700_000,
      targetCats: ['codex-sol'],
    });
    const updates = [];
    const recordStore = {
      ...makeRecordStore([parent]),
      update: async (id, input) => {
        updates.push({ id, input });
        return null;
      },
    };
    const turnExecutionStore = {
      listByParent: async (requestedParentId) =>
        requestedParentId === parentId
          ? [
              {
                invocationId: childId,
                parentInvocationId: parentId,
                threadId: THREAD_ID,
                userId: USER_ID,
                catId: 'fable5',
                executionKind: 'ordinary',
                startedAt: now - 5_000,
                status: 'running',
              },
            ]
          : [],
    };
    const draftStore = new DraftStore();
    const tracker = makeTracker();

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = await buildPairedApp({ recordStore, draftStore, tracker, turnExecutionStore });

      const messages = await injectMessages(app);
      assert.equal(messages.statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(updates.length, 0, '/messages must not reconcile a parent whose durable child is running');

      const queue = await injectQueue(app);
      assert.equal(queue.statusCode, 200);
      assert.deepEqual(queue.body.activeInvocations, [
        {
          catId: 'fable5',
          startedAt: now - 5_000,
          executionId: parentId,
          turnInvocationId: childId,
          freshnessCarrierCapability: UNDECLARED_FRESHNESS_CARRIER_CAPABILITY,
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(updates.length, 0, '/queue must not reconcile a parent whose durable child is running');
      assert.equal(parent.status, 'running');
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it('running durable child prevents cross-parent same-cat UI dedup from reconciling its parent', async () => {
    const now = 35_000_000;
    const oldParentId = 'parent-preempted-finalizing';
    const newParentId = 'parent-current-slot-owner';
    const oldChildId = 'child-old-fable-running';
    const newChildId = 'child-new-fable-draft';
    const newChildCreatedAt = now - 4_000;
    const oldParent = makeRecord({
      id: oldParentId,
      updatedAt: now - 700_000,
      targetCats: ['codex-sol'],
    });
    const newParent = makeRecord({
      id: newParentId,
      updatedAt: now - 20_000,
      targetCats: ['fable5'],
    });
    const updates = [];
    const recordStore = {
      ...makeRecordStore([oldParent, newParent]),
      update: async (id, input) => {
        updates.push({ id, input });
        return null;
      },
    };
    const draftStore = new DraftStore();
    draftStore.upsert({
      userId: USER_ID,
      threadId: THREAD_ID,
      invocationId: newChildId,
      catId: 'fable5',
      content: 'new owner streaming',
      createdAt: newChildCreatedAt,
      updatedAt: now - 100,
    });
    const registry = makeStubRegistry({
      turns: {
        [newChildId]: {
          parentInvocationId: newParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'fable5',
          createdAt: newChildCreatedAt,
        },
      },
      latestByCat: { [`${THREAD_ID}:fable5`]: newChildId },
    });
    const turnExecutionStore = {
      listByParent: async (parentId) =>
        parentId === oldParentId
          ? [
              {
                invocationId: oldChildId,
                parentInvocationId: oldParentId,
                threadId: THREAD_ID,
                userId: USER_ID,
                catId: 'fable5',
                executionKind: 'ordinary',
                startedAt: now - 8_000,
                status: 'running',
              },
            ]
          : [],
    };

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = await buildPairedApp({
        recordStore,
        draftStore,
        tracker: makeTracker(),
        turnExecutionStore,
        registry,
      });

      const messages = await injectMessages(app);
      assert.equal(messages.statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(updates.length, 0, '/messages must not reconcile a parent with a durable running child');

      const queue = await injectQueue(app);
      assert.equal(queue.statusCode, 200);
      assert.deepEqual(queue.body.activeInvocations, [
        {
          catId: 'fable5',
          startedAt: newChildCreatedAt,
          executionId: newParentId,
          turnInvocationId: newChildId,
          freshnessCarrierCapability: UNDECLARED_FRESHNESS_CARRIER_CAPABILITY,
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(updates.length, 0, '/queue must not reconcile a parent with a durable running child');
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it('durable child store failure keeps both routes fail-open and never reconciles an unknown parent', async () => {
    const now = 40_000_000;
    const parent = makeRecord({
      id: 'parent-ledger-unavailable',
      updatedAt: now - 700_000,
    });
    const updates = [];
    const recordStore = {
      ...makeRecordStore([parent]),
      update: async (id, input) => {
        updates.push({ id, input });
        return null;
      },
    };
    const turnExecutionStore = {
      listByParent: async () => {
        throw new Error('ledger unavailable');
      },
    };
    const draftStore = new DraftStore();
    const tracker = makeTracker();

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = await buildPairedApp({ recordStore, draftStore, tracker, turnExecutionStore });

      const messages = await injectMessages(app);
      const queue = await injectQueue(app);
      assert.equal(messages.statusCode, 200, '/messages uses its existing fail-open path');
      assert.equal(queue.statusCode, 200, '/queue uses its existing tracker-only fallback');
      assert.deepEqual(queue.body.activeInvocations, []);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(updates.length, 0, 'unknown durable-child state must not produce a terminal write');
      assert.equal(parent.status, 'running');
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });
});
