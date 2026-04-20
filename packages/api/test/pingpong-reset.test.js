/**
 * F167 L1 AC-A3: streak reset triggers.
 *
 * (A) user message POST → resetStreak hook clears streakPair on active worklist.
 * (B) third-cat injection → pushToWorklist internal samePair check auto-resets
 *     (覆盖在 worklist-registry-streak.test.js，此处只做 sanity check).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { registerWorklist, unregisterWorklist, pushToWorklist, getWorklist } = await import(
  '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
);

function buildDeps(overrides = {}) {
  const invocationQueue = new InvocationQueue();
  return {
    registry: new InvocationRegistry(),
    messageStore: {
      append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
      getByThread: mock.fn(async () => []),
      getByThreadBefore: mock.fn(async () => []),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    router: {
      resolveTargetsAndIntent: mock.fn(async () => ({ targetCats: ['opus'], intent: { intent: 'execute' } })),
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
      route: mock.fn(async function* () {
        yield { type: 'done' };
      }),
    },
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      tryStartThread: mock.fn(() => new AbortController()),
      tryStartThreadAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
      cancel: mock.fn(() => ({ cancelled: true, catIds: ['opus'] })),
      isDeleting: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-stub' })),
      update: mock.fn(async () => {}),
    },
    invocationQueue,
    threadStore: {
      get: mock.fn(async () => ({ id: 'thread-pp-reset', title: 'Reset Thread', createdBy: 'user-1' })),
      updateTitle: mock.fn(async () => {}),
    },
    ...overrides,
  };
}

describe('F167 L1 AC-A3: ping-pong reset triggers', () => {
  let app;
  let deps;

  beforeEach(async () => {
    deps = buildDeps();
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('POST /api/messages → resetStreak fires on the active worklist', async () => {
    const threadId = 'thread-pp-reset';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      // Preload streak to warn level (2)
      pushToWorklist(threadId, ['codex'], 'opus');
      entry.executedIndex = 1;
      pushToWorklist(threadId, ['opus'], 'codex');
      assert.equal(entry.streakPair?.count, 2, 'precondition: streak=2 before user msg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
        payload: {
          content: '新的一轮，重新开始',
          threadId,
        },
      });
      assert.ok(res.statusCode < 500, `expected non-500, got ${res.statusCode}: ${res.body}`);

      const current = getWorklist(threadId);
      assert.ok(current, 'worklist must still exist after user msg');
      assert.ok(
        !current.streakPair || current.streakPair.count === 0,
        `streakPair must be cleared after user msg; got ${JSON.stringify(current.streakPair)}`,
      );
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  it('POST /api/messages → resetStreak clears parentInvocationId-keyed worklist (P1-2)', async () => {
    const threadId = 'thread-pp-reset-inv';
    const parentInvocationId = 'inv-reset-1';
    const entry = registerWorklist(threadId, ['opus'], 10, parentInvocationId);
    try {
      // Preload streak to warn level via parentInvocationId-keyed push
      pushToWorklist(threadId, ['codex'], 'opus', parentInvocationId);
      entry.executedIndex = 1;
      pushToWorklist(threadId, ['opus'], 'codex', parentInvocationId);
      assert.equal(entry.streakPair?.count, 2, 'precondition: streak=2 before user msg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
        payload: {
          content: '新的一轮（parentInvocationId 场景）',
          threadId,
        },
      });
      assert.ok(res.statusCode < 500, `expected non-500, got ${res.statusCode}: ${res.body}`);

      const current = getWorklist(threadId, parentInvocationId);
      assert.ok(current, 'parent-keyed worklist must still exist after user msg');
      assert.ok(
        !current.streakPair || current.streakPair.count === 0,
        `streakPair on parent-keyed worklist must be cleared; got ${JSON.stringify(current.streakPair)}`,
      );
    } finally {
      unregisterWorklist(threadId, entry, parentInvocationId);
    }
  });

  it('POST /api/messages to a thread without active worklist → no-op (no crash)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '没有 worklist 时发消息',
        threadId: 'thread-pp-reset',
      },
    });
    assert.ok(res.statusCode < 500, `expected non-500, got ${res.statusCode}: ${res.body}`);
  });

  it('third-cat injection via pushToWorklist auto-resets streak (sanity: no route-layer hook required)', () => {
    const threadId = 'thread-pp-third-cat';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      // Build up opus↔codex streak
      pushToWorklist(threadId, ['codex'], 'opus');
      entry.executedIndex = 1;
      pushToWorklist(threadId, ['opus'], 'codex');
      assert.equal(entry.streakPair?.count, 2);

      // Now gemini (third cat) pushes opus — different pair → streak resets to 1
      entry.list.push('gemini');
      entry.executedIndex = 3;
      const result = pushToWorklist(threadId, ['opus'], 'gemini');
      assert.ok(!result.warnPingPong, 'third-cat push must NOT carry warn');
      assert.equal(entry.streakPair?.count, 1, 'streak reset to 1 for new pair');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });
});
