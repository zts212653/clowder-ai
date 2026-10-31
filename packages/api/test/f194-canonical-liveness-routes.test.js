/**
 * F194 Phase B AC-B3 / AC-B4 → F117 KD-23 — paired /messages + /queue liveness.
 *
 * F117 KD-23: a member is processing only while someone verifiably runs its turn (this process's
 * tracker slot, a live CLI owner, or, while no complete owner snapshot can tell, a running child).
 * A streamed draft is not liveness. So:
 *   AC-B3: with only a draft, /messages still renders the turn's processing response R with the
 *          streamed body (F117: a draft is the body of that R, never a `draft-*` record), and
 *          /queue lists nobody as processing. The active-execution read-repair settles such a
 *          record once a complete owner snapshot shows no owner.
 *   AC-B4: with neither an owner nor a draft, neither endpoint shows the turn.
 * Reads never write lifecycle truth: only the owner reaper and read-repair end records.
 *
 * 砚砚 R8 P1: queue-only regression cannot prove paired behaviour. This file registers
 * messagesRoutes + queueRoutes against the SAME (recordStore, draftStore, tracker) fixture.
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

const THREAD_ID = 'thread-1';
const USER_ID = 'user-1';
const UNDECLARED_FRESHNESS_CARRIER_CAPABILITY = {
  provider: 'other',
  carrier: 'other',
  activeInvocationGuidance: 'undeclared',
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

function makeTracker({ activeSlotsByThread = {}, userIds = {}, executionIds = {} } = {}) {
  return {
    has: () => false,
    getUserId: (tid, cid) => userIds[`${tid}:${cid}`] ?? null,
    getExecutionId: (tid, cid) => executionIds[`${tid}:${cid}`],
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

/** F117: the durable processing response R a dispatched turn owns; its draft folds into R. */
function appendProcessingResponse(messageStore, { invocationId, catId, timestamp }) {
  return messageStore.append(
    canonicalTestMessageInput({
      userId: USER_ID,
      catId,
      content: '',
      mentions: [],
      timestamp,
      threadId: THREAD_ID,
      origin: 'stream',
      lifecycle: {
        kind: 'response',
        orderKey: `${timestamp}:${invocationId}`,
        invocationId,
        targetId: catId,
        inputEntryIds: [`entry-${invocationId}`],
        inputMessageIds: [`source-${invocationId}`],
        status: 'processing',
        startedAt: timestamp,
      },
    }),
  );
}

async function buildPairedApp({
  recordStore,
  draftStore,
  tracker,
  turnExecutionStore,
  registry = makeStubRegistry(),
  messageStore = new MessageStore(),
}) {
  const app = Fastify({ logger: false });
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
    listByProject: async (_userId, projectPath) => [{ id: THREAD_ID, title: 'Test', createdBy: 'system', projectPath }],
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
  it('AC-B3 (F117 KD-23): with only a draft, /messages renders the processing R and /queue lists nobody', async () => {
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
    const messageStore = new MessageStore();
    const response = appendProcessingResponse(messageStore, {
      invocationId: 'inv-running',
      catId: 'opus',
      timestamp: now - 50_000,
    });

    const origNow = Date.now;
    Date.now = () => now;
    let app;
    try {
      app = await buildPairedApp({ recordStore, draftStore, tracker, messageStore });
      const msgs = await injectMessages(app);
      const queue = await injectQueue(app);

      assert.equal(msgs.statusCode, 200);
      assert.equal(queue.statusCode, 200);

      // /messages: the live draft is the body of the turn's processing response, not a draft-* record
      const draftItem = msgs.body.messages.find((m) => m.id === response.id);
      assert.ok(draftItem, '/messages must render the processing R with its streamed body');
      assert.equal(draftItem.isDraft, true);
      assert.equal(draftItem.content, 'streaming...');
      assert.equal(draftItem.catId, 'opus');
      assert.equal(
        msgs.body.messages.some((m) => m.id.startsWith('draft-')),
        false,
      );

      // /queue: a streamed draft does not prove anyone still runs the turn
      assert.deepEqual(queue.body.activeInvocations, [], 'KD-23: nobody verifiably runs this turn');
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it('GET /queue has no terminal side effects on a running record nobody holds', async () => {
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
      assert.equal(queueRes.body.activeInvocations.length, 0, 'nobody holds it: not listed as active');

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(zombieRecord.status, 'running', 'read endpoints must not write lifecycle truth');
      assert.deepEqual(cleared, [], 'read endpoints must not clear owner projections');
      assert.deepEqual(terminalEvents, [], 'explicit owner reaper is the only terminal carrier');
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it('GET /messages stays side-effect free for a running record nobody holds', async () => {
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

  it('AC-B4 (F117 KD-23): a running record nobody holds and without a draft is on neither endpoint', async () => {
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
      const draftItems = msgs.body.messages.filter((m) => m.isDraft === true || m.id.startsWith('draft-'));
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

  it('a durable running child is never reconciled by a read on either route', async () => {
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
      const active = await app.inject({
        method: 'GET',
        url: '/api/executions/active?projectPath=%2Fproject%2Fcafe',
        headers: { 'x-cat-cafe-user': USER_ID },
      });
      assert.equal(active.statusCode, 200);
      assert.equal(active.json().executions[0]?.executionId, parentId);
      assert.equal(
        active.json().executions[0]?.turnInvocationId,
        childId,
        'F295 must retain the canonical child from F194',
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(updates.length, 0, '/queue must not reconcile a parent whose durable child is running');
      assert.equal(parent.status, 'running');
    } finally {
      Date.now = origNow;
      if (app) await app.close();
    }
  });

  it("the slot this process holds outranks an older parent's unverified child, and reads reconcile neither", async () => {
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
    // F117 KD-23: the new parent is the current owner because this process's tracker holds its slot.
    const activeRun = {
      threadId: THREAD_ID,
      targetId: 'fable5',
      invocationId: newChildId,
      responseMessageId: 'response-new-fable',
      inputEntryIds: [],
      inputMessageIds: [],
      privateInputEntryIds: [],
      startedAt: newChildCreatedAt,
    };
    const tracker = makeTracker({
      activeSlotsByThread: { [THREAD_ID]: [{ catId: 'fable5', startedAt: newChildCreatedAt, activeRun }] },
      userIds: { [`${THREAD_ID}:fable5`]: USER_ID },
      executionIds: { [`${THREAD_ID}:fable5`]: newParentId },
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
      app = await buildPairedApp({ recordStore, draftStore, tracker, turnExecutionStore });

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
          activeRun,
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
      assert.equal(messages.statusCode, 200, '/messages does not depend on the durable-child ledger');
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
