/**
 * Queue gate thread-level regression test
 *
 * Bug: messages.ts used invocationTracker.has(threadId, primaryCat) which only
 * checks the target cat's slot. When cat B is active in the thread but user
 * sends to cat A, the message bypasses the queue and executes immediately,
 * causing two cats to talk simultaneously.
 *
 * Fix: Use has(threadId) (no catId) to check if ANY cat is active in the thread.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');

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
      resolveTargetsAndIntent: mock.fn(async () => ({
        targetCats: ['opus'],
        intent: { intent: 'execute' },
      })),
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
      tryStartThread: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      // Realistic slot-aware mock: only gemini slot is active
      has: mock.fn((threadId, catId) => {
        if (catId === undefined) {
          // Thread-level check: any slot active?
          return threadId === 'thread-1';
        }
        // Slot-level check: only gemini is active
        return threadId === 'thread-1' && catId === 'gemini';
      }),
      cancel: mock.fn(() => ({ cancelled: true, catIds: ['opus'] })),
      isDeleting: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
      update: mock.fn(async () => {}),
    },
    invocationQueue,
    threadStore: {
      get: mock.fn(async () => ({
        id: 'thread-1',
        title: 'Test Thread',
        createdBy: 'test-user',
      })),
      updateTitle: mock.fn(async () => {}),
    },
    ...overrides,
  };
}

describe('Queue gate: thread-level enqueue (regression)', () => {
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

  it('cat B active in thread → message to cat A should be queued, not immediate', async () => {
    // Setup: gemini is active in thread-1, user sends message targeting opus
    // has('thread-1', 'opus') → false (opus slot not active)
    // has('thread-1') → true (thread has active invocation)
    // Bug: old code called has(threadId, primaryCat) → false → immediate
    // Fix: code should call has(threadId) → true → queue

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus 你好', threadId: 'thread-1' },
    });

    // Should be queued (202), NOT immediate (200)
    assert.equal(res.statusCode, 202, 'message should be queued when another cat is active in thread');
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued');

    // Should NOT have created InvocationRecord (queued, not executing)
    assert.equal(
      deps.invocationRecordStore.create.mock.calls.length,
      0,
      'should not start immediate execution when thread has active invocation',
    );
  });

  it('no cat active in thread → message executes immediately', async () => {
    // Override: no activity in thread-2
    deps.invocationTracker.has.mock.mockImplementation((_threadId, _catId) => false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus 你好', threadId: 'thread-2' },
    });

    assert.equal(res.statusCode, 200, 'message should execute immediately when no cat is active');
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'processing');
  });

  it('explicit deliveryMode=queue + different cat active → must enqueue', async () => {
    // User explicitly requests queue mode; gemini is active but target is opus
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus 排队发', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    assert.equal(res.statusCode, 202, 'explicit queue mode should enqueue when thread has activity');
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued');
  });
});
