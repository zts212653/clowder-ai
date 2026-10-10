/**
 * F194 Phase Z4 → F117 KD-23 — routes integration for the runtime split symptom.
 *
 * Runtime state from thread_moxnb78ckc36xhga (2026-05-09 03:35): a multi-cat chain whose parent
 * record had been running for ~4 minutes while the member now answering had just started. /queue
 * showed the member's timer at 4 minutes although its content was fresh.
 *
 * F117 KD-23 keeps the fix without drafts or the registry namespace bridge: the member is live
 * because this process's tracker holds its slot, and its start is the run the slot has bound
 * (activeRun.startedAt), not the chain's start. /messages still folds the member's draft into its
 * processing response by lifecycle.invocationId, never as a `draft-*` record.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

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

function makeTracker({ activeSlotsByThread = {}, userIds = {}, executionIds = {} } = {}) {
  return {
    has: () => false,
    getUserId: (tid, cid) => userIds[`${tid}:${cid}`] ?? null,
    getExecutionId: (tid, cid) => executionIds[`${tid}:${cid}`],
    cancel: () => ({ cancelled: false, catIds: [] }),
    getActiveSlots: (tid) => activeSlotsByThread[tid] ?? [],
  };
}

function boundRun({ invocationId, startedAt }) {
  return {
    threadId: THREAD_ID,
    targetId: 'opus',
    invocationId,
    responseMessageId: `response-${invocationId}`,
    inputEntryIds: [],
    inputMessageIds: [],
    privateInputEntryIds: [],
    startedAt,
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

async function buildPairedApp({ recordStore, draftStore, tracker, registry, messageStore = new MessageStore() }) {
  const app = Fastify({ logger: false });
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
  it('runtime symptom: a later member of a 4-minute chain shows its own turn start on /queue, and /messages keeps its draft', async () => {
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

    // The chain's slot was taken when the chain started; the member's own turn is the run it bound.
    const tracker = makeTracker({
      activeSlotsByThread: {
        [THREAD_ID]: [
          {
            catId: 'opus',
            startedAt: parentUpdatedAt,
            activeRun: boundRun({ invocationId: childId, startedAt: childCreatedAt }),
          },
        ],
      },
      userIds: { [`${THREAD_ID}:opus`]: USER_ID },
      executionIds: { [`${THREAD_ID}:opus`]: parentId },
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

    // F117: the child turn's durable processing response, keyed by the child id.
    const messageStore = new MessageStore();
    const response = messageStore.append(
      canonicalTestMessageInput({
        userId: USER_ID,
        catId: 'opus',
        content: '',
        mentions: [],
        timestamp: childCreatedAt,
        threadId: THREAD_ID,
        origin: 'stream',
        extra: { stream: { invocationId: parentId, turnInvocationId: childId } },
        lifecycle: {
          kind: 'response',
          orderKey: `${childCreatedAt}:${childId}`,
          invocationId: childId,
          targetId: 'opus',
          inputEntryIds: ['entry-runtime'],
          inputMessageIds: ['source-runtime'],
          status: 'processing',
          startedAt: childCreatedAt,
        },
      }),
    );

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = await buildPairedApp({ recordStore, draftStore, tracker, registry, messageStore });

      const queue = await injectQueue(app);
      assert.equal(queue.statusCode, 200);
      assert.equal(queue.body.activeInvocations.length, 1, 'must collapse parent+child to 1 cat slot');
      assert.equal(queue.body.activeInvocations[0].catId, 'opus');
      assert.equal(
        queue.body.activeInvocations[0].startedAt,
        childCreatedAt,
        '/queue.startedAt MUST be the member turn start — the runtime symptom showed the chain start 4 minutes ago',
      );
      assert.notEqual(
        queue.body.activeInvocations[0].startedAt,
        parentUpdatedAt,
        'must NOT regress to parent.updatedAt (the broken Phase B behavior)',
      );

      const msgs = await injectMessages(app);
      assert.equal(msgs.statusCode, 200);
      // Draft for child surfaces as the body of the child's processing response
      const draftItem = msgs.body.messages.find((m) => m.id === response.id);
      assert.ok(draftItem, 'child draft must surface in /messages (folded by child id namespace)');
      assert.equal(draftItem.catId, 'opus');
      assert.equal(draftItem.isDraft, true);
      assert.equal(draftItem.content, 'streaming current turn...');
      assert.equal(
        msgs.body.messages.some((m) => m.id.startsWith('draft-')),
        false,
      );

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

  it('a cat slot the new parent holds: /queue lists the new chain, and the old parent nobody holds is not listed', async () => {
    const now = 20_000_000;
    const oldParentId = 'old-parent';
    const newParentId = 'new-parent';
    const newChildId = 'new-child';
    const newChildCreatedAt = now - 5_000;
    const oldParent = makeRecord({ id: oldParentId, updatedAt: now - 100_000 });
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
      activeSlotsByThread: {
        [THREAD_ID]: [
          {
            catId: 'opus',
            startedAt: now - 6_000,
            activeRun: boundRun({ invocationId: newChildId, startedAt: newChildCreatedAt }),
          },
        ],
      },
      userIds: { [`${THREAD_ID}:opus`]: USER_ID },
      executionIds: { [`${THREAD_ID}:opus`]: newParentId },
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
      // The new parent holds the slot; the old parent has no owner and no running child.
      assert.equal(queue.body.activeInvocations.length, 1, 'only the chain this process runs is listed');
      assert.equal(queue.body.activeInvocations[0].catId, 'opus');
      assert.equal(queue.body.activeInvocations[0].startedAt, newChildCreatedAt);
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });
});
