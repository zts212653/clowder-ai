/**
 * F194 Phase Z4 — Routes integration test reproducing runtime split symptom.
 *
 * Reproduces the exact runtime state from thread_moxnb78ckc36xhga (2026-05-09 03:35):
 *   - parent recordStore invocation P1 status=running for ~4 minutes
 *   - child registry invocation C1 with parentInvocationId=P1, fresh draft for opus-47
 *   - tracker slot for opus-47 present
 *   - formal message persisted with extra.stream.invocationId=P1 (multi-cat chain mid-flight)
 *
 * Pre-Phase-Z observed bug:
 *   - /messages.helper.active had {invocationId=P1, source=record-only} + {invocationId=C1, source=tracker+draft no-record}
 *     → 2 ghost identities for what's actually 1 in-flight chain
 *   - /queue.activeInvocations dedup kept earliest startedAt = P1.updatedAt (4 min ago)
 *   - User-facing: bubble timer chip stale (4 min) but content fresh (a58a8757 streaming)
 *
 * Post-Phase-Z expected:
 *   - helper.active = 1 entry per cat, source='parent+child+tracker', startedAt=child createdAt
 *   - /queue.activeInvocations[].startedAt = child createdAt (NOT parent.updatedAt)
 *   - /messages: child draft surfaces (orphan filter respects child id namespace)
 *   - Both endpoints agree on namespace identity
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { messagesRoutes } = await import('../dist/routes/messages.js');
const { queueRoutes } = await import('../dist/routes/queue.js');

const THREAD_ID = 'thread-z-runtime';
const USER_ID = 'user-z';

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

function makeStubSocketManager() {
  return {
    broadcastToRoom: () => {},
    broadcastAgentMessage: () => {},
    getIO: () => ({}),
    emitToUser: () => {},
  };
}

/** Minimal namespace-aware InvocationRegistry stub: returns parent/createdAt/catId for child ids */
function makeNamespaceRegistry({ turnRecords = {}, latestByCat = {} } = {}) {
  return {
    getRecord: async (id) => turnRecords[id] ?? null,
    getLatestId: async (tid, cat) => latestByCat[`${tid}:${cat}`] ?? undefined,
    register: () => {},
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

async function buildPairedApp({ recordStore, draftStore, tracker, registry }) {
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
  });
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

describe('F194 Phase Z4 — runtime split symptom reproduction (paired /messages + /queue)', () => {
  it('runtime symptom: parent record running 4min + child fresh draft + tracker present → /queue startedAt = child (NOT parent.updatedAt), /messages keeps child draft, both agree', async () => {
    const now = 10_000_000;
    const parentId = 'parent-runtime';
    const childId = 'child-runtime';
    const parentUpdatedAt = now - 240_000; // 4 minutes ago — was the runtime symptom
    const childCreatedAt = now - 30_000; // current streaming turn

    const parent = makeRecord({ id: parentId, updatedAt: parentUpdatedAt });
    const recordStore = makeRecordStore([parent]);

    const draftStore = new DraftStore();
    draftStore.upsert({
      userId: USER_ID,
      threadId: THREAD_ID,
      invocationId: childId, // child registry id (different from parent.id)
      catId: 'opus',
      content: 'streaming current turn...',
      createdAt: childCreatedAt,
      updatedAt: now - 100,
    });

    const tracker = makeTracker({
      activeSlotsByThread: { [THREAD_ID]: [{ catId: 'opus', startedAt: childCreatedAt }] },
      userIds: { [`${THREAD_ID}:opus`]: USER_ID },
    });

    const registry = makeNamespaceRegistry({
      turnRecords: {
        [childId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: childCreatedAt,
        },
      },
      latestByCat: { [`${THREAD_ID}:opus`]: childId },
    });

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = await buildPairedApp({ recordStore, draftStore, tracker, registry });

      const queue = await injectQueue(app);
      assert.equal(queue.statusCode, 200);
      assert.equal(queue.body.activeInvocations.length, 1, 'must collapse parent+child to 1 cat slot');
      assert.equal(queue.body.activeInvocations[0].catId, 'opus');
      assert.equal(
        queue.body.activeInvocations[0].startedAt,
        childCreatedAt,
        '/queue.startedAt MUST be child createdAt — was the runtime split symptom (showed parent.updatedAt 4min ago)',
      );
      assert.notEqual(
        queue.body.activeInvocations[0].startedAt,
        parentUpdatedAt,
        'must NOT regress to parent.updatedAt (the broken Phase B behavior)',
      );

      const msgs = await injectMessages(app);
      assert.equal(msgs.statusCode, 200);
      // Draft for child should surface (not orphan-filtered)
      const draftItem = (msgs.body.messages ?? msgs.body ?? []).find?.((m) => m.id === `draft-${childId}`);
      assert.ok(draftItem, 'child draft must surface in /messages (orphan filter respects child id namespace)');
      assert.equal(draftItem.catId, 'opus');
      assert.equal(draftItem.isDraft, true);

      // Cross-endpoint consistency: same cat live on both sides
      const queueLiveCats = new Set(queue.body.activeInvocations.map((s) => s.catId));
      const messagesLiveCats = new Set([draftItem].map((m) => m.catId));
      assert.deepEqual(
        [...queueLiveCats].sort(),
        [...messagesLiveCats].sort(),
        '/queue and /messages MUST agree on which cats are live (canonical view)',
      );
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it("cat-slot reuse zombie: old parent record + no own child draft + cat slot held by NEW parent's child draft → old parent suppressed from active (new-parent live surfaces)", async () => {
    const now = 20_000_000;
    const oldParentId = 'old-parent';
    const newParentId = 'new-parent';
    const newChildId = 'new-child';
    const newChildCreatedAt = now - 5_000;
    const oldParent = makeRecord({ id: oldParentId, updatedAt: now - 100_000 });
    // Cloud R2 P1: new-parent must also be a running record + have fresh draft, not just registry pointer.
    const newParent = makeRecord({ id: newParentId, updatedAt: now - 6_000, targetCats: ['opus'] });
    const recordStore = makeRecordStore([oldParent, newParent]);

    const draftStore = new DraftStore();
    draftStore.upsert({
      userId: USER_ID,
      threadId: THREAD_ID,
      invocationId: newChildId,
      catId: 'opus',
      content: 'new chain streaming...',
      createdAt: newChildCreatedAt,
      updatedAt: now - 100,
    });

    const tracker = makeTracker({
      activeSlotsByThread: { [THREAD_ID]: [{ catId: 'opus', startedAt: now - 5_000 }] },
      userIds: { [`${THREAD_ID}:opus`]: USER_ID },
    });

    const registry = makeNamespaceRegistry({
      turnRecords: {
        [newChildId]: {
          parentInvocationId: newParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: newChildCreatedAt,
        },
      },
      latestByCat: { [`${THREAD_ID}:opus`]: newChildId },
    });

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = await buildPairedApp({ recordStore, draftStore, tracker, registry });
      const queue = await injectQueue(app);
      assert.equal(queue.statusCode, 200);
      // new-parent's chain is live (not 0); old-parent suppressed from active and zombied.
      assert.equal(queue.body.activeInvocations.length, 1, 'new-parent live chain surfaces (old-parent suppressed)');
      assert.equal(queue.body.activeInvocations[0].catId, 'opus');
      assert.equal(queue.body.activeInvocations[0].startedAt, newChildCreatedAt);
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });
});
