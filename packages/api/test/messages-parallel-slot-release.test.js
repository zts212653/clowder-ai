import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { queueRoutes } from '../dist/routes/queue.js';

function deferred() {
  /** @type {(value?: void | PromiseLike<void>) => void} */
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeSocketManager(events) {
  return {
    broadcastAgentMessage(message, threadId) {
      events.push({ threadId, message });
    },
    broadcastToRoom() {},
    emitToUser() {},
  };
}

function makeRegistry() {
  return {
    active() {
      return new Set();
    },
  };
}

function makeMessageStore() {
  return {
    append: async (msg) => ({ id: `msg-${Date.now()}`, ...msg }),
    updateStatus: async () => {},
  };
}

function makeInvocationRecordStore() {
  return {
    create: async () => ({ outcome: 'created', invocationId: 'inv-parallel-release' }),
    update: async () => {},
  };
}

function makeThreadStore() {
  return {
    get: async (id) => ({
      id,
      title: 'Parallel Slot Release',
      createdBy: 'system',
    }),
  };
}

function makeQueueProcessor() {
  return {
    processNext: async () => ({ started: false }),
    isPaused: () => false,
    getPauseReason: () => undefined,
    clearPause: () => {},
    releaseSlot: () => {},
    releaseThread: () => {},
  };
}

describe('POST /api/messages parallel slot release', () => {
  it('drops finished cats from InvocationTracker before the whole batch completes', async () => {
    const gate = deferred();
    const tracker = new InvocationTracker();
    const invocationQueue = new InvocationQueue();
    const broadcastEvents = [];
    const threadId = 'thread-parallel-slot-release';

    const router = {
      resolveTargetsAndIntent: async () => ({
        targetCats: ['opus', 'codex'],
        intent: { intent: 'ideate', explicit: true, promptTags: [] },
      }),
      routeExecution: async function* () {
        yield { type: 'text', catId: 'opus', content: 'first', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', isFinal: false, timestamp: Date.now() };
        await gate.promise;
        yield { type: 'text', catId: 'codex', content: 'second', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
      ackCollectedCursors: async () => {},
    };

    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: makeRegistry(),
      messageStore: makeMessageStore(),
      socketManager: makeSocketManager(broadcastEvents),
      router,
      invocationTracker: tracker,
      invocationRecordStore: makeInvocationRecordStore(),
    });
    await app.register(queueRoutes, {
      threadStore: makeThreadStore(),
      invocationQueue,
      queueProcessor: makeQueueProcessor(),
      invocationTracker: tracker,
      socketManager: makeSocketManager(broadcastEvents),
    });
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'parallel status repro',
        threadId,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const queueRes = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/queue`,
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(queueRes.statusCode, 200);
    assert.deepEqual(
      JSON.parse(queueRes.body)
        .activeInvocations.map((slot) => slot.catId)
        .sort(),
      ['codex'],
      'queue endpoint should already reflect only the still-running cat',
    );
    assert.ok(
      broadcastEvents.some(
        (event) => event.threadId === threadId && event.message.type === 'done' && event.message.catId === 'opus',
      ),
      'socket broadcast should emit the finished cat before the batch ends',
    );
    assert.deepEqual(
      tracker
        .getActiveSlots(threadId)
        .map((slot) => slot.catId)
        .sort(),
      ['codex'],
      'after opus done(non-final), only the still-running cat should remain active',
    );

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(tracker.has(threadId), false, 'all slots should clear once the last cat finishes');

    await app.close();
  });

  it('drops errored cats from InvocationTracker before the whole batch completes', async () => {
    const gate = deferred();
    const tracker = new InvocationTracker();
    const invocationQueue = new InvocationQueue();
    const broadcastEvents = [];
    const threadId = 'thread-parallel-slot-error-release';

    const router = {
      resolveTargetsAndIntent: async () => ({
        targetCats: ['opus', 'codex'],
        intent: { intent: 'ideate', explicit: true, promptTags: [] },
      }),
      routeExecution: async function* () {
        yield { type: 'text', catId: 'opus', content: 'first', timestamp: Date.now() };
        yield { type: 'error', catId: 'opus', error: 'tool failed', timestamp: Date.now() };
        await gate.promise;
        yield { type: 'text', catId: 'codex', content: 'second', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
      ackCollectedCursors: async () => {},
    };

    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: makeRegistry(),
      messageStore: makeMessageStore(),
      socketManager: makeSocketManager(broadcastEvents),
      router,
      invocationTracker: tracker,
      invocationRecordStore: makeInvocationRecordStore(),
    });
    await app.register(queueRoutes, {
      threadStore: makeThreadStore(),
      invocationQueue,
      queueProcessor: makeQueueProcessor(),
      invocationTracker: tracker,
      socketManager: makeSocketManager(broadcastEvents),
    });
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'parallel error status repro',
        threadId,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const queueRes = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/queue`,
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(queueRes.statusCode, 200);
    assert.deepEqual(
      JSON.parse(queueRes.body)
        .activeInvocations.map((slot) => slot.catId)
        .sort(),
      ['codex'],
      'queue endpoint should drop errored cats immediately too',
    );
    assert.ok(
      broadcastEvents.some(
        (event) => event.threadId === threadId && event.message.type === 'error' && event.message.catId === 'opus',
      ),
      'socket broadcast should emit the erroring cat before the batch ends',
    );
    assert.deepEqual(
      tracker
        .getActiveSlots(threadId)
        .map((slot) => slot.catId)
        .sort(),
      ['codex'],
      'after opus error, only the still-running cat should remain active',
    );

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(tracker.has(threadId), false, 'all slots should clear once the last cat finishes');

    await app.close();
  });
});
