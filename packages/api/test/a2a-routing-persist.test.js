/**
 * Regression tests for A2A routing message persistence (#648).
 *
 * Covers:
 * 1. persistA2ARoutingMessage helper stores system message and returns messageId
 * 2. safeParseExtra preserves systemKind through Redis-style round-trip
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { safeParseExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');

describe('A2A routing message persistence (#648)', () => {
  describe('safeParseExtra preserves systemKind through round-trip', () => {
    it('preserves systemKind: a2a_routing', () => {
      const raw = JSON.stringify({ systemKind: 'a2a_routing' });
      const parsed = safeParseExtra(raw);
      assert.equal(parsed?.systemKind, 'a2a_routing');
    });

    it('drops unknown systemKind values', () => {
      const raw = JSON.stringify({ systemKind: 'unknown_kind' });
      const parsed = safeParseExtra(raw);
      assert.equal(parsed, undefined);
    });

    it('preserves systemKind alongside other extra fields', () => {
      const raw = JSON.stringify({
        systemKind: 'a2a_routing',
        stream: { invocationId: 'inv-123' },
      });
      const parsed = safeParseExtra(raw);
      assert.equal(parsed?.systemKind, 'a2a_routing');
      assert.equal(parsed?.stream?.invocationId, 'inv-123');
    });

    it('survives JSON serialize → parse cycle (simulates Redis storage)', () => {
      const original = { systemKind: 'a2a_routing' };
      const serialized = JSON.stringify(original);
      const deserialized = safeParseExtra(serialized);
      assert.equal(deserialized?.systemKind, 'a2a_routing');
    });
  });

  describe('A2A handoff message storage contract', () => {
    it('persists a2a_handoff as system message with correct shape', () => {
      const store = new MessageStore();
      const result = store.append({
        userId: 'system',
        catId: null,
        content: '布偶猫 → 缅因猫',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread-1',
        extra: { systemKind: 'a2a_routing' },
      });

      assert.ok(result.id, 'stored message should have an id');

      const messages = store.getByThread('thread-1');
      const stored = messages.find((m) => m.id === result.id);
      assert.ok(stored, 'message should be retrievable from store');
      assert.equal(stored.userId, 'system');
      assert.equal(stored.catId, null);
      assert.equal(stored.content, '布偶猫 → 缅因猫');
      assert.deepEqual(stored.extra, { systemKind: 'a2a_routing' });
    });

    it('stored messageId can be attached to broadcast payload', () => {
      const store = new MessageStore();
      const result = store.append({
        userId: 'system',
        catId: null,
        content: '布偶猫 → 缅因猫',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread-1',
        extra: { systemKind: 'a2a_routing' },
      });

      const broadcastPayload = {
        type: 'a2a_handoff',
        content: '布偶猫 → 缅因猫',
        messageId: result.id,
      };

      assert.ok(broadcastPayload.messageId, 'broadcast payload should carry stored messageId');
      assert.equal(typeof broadcastPayload.messageId, 'string');
    });
  });
});

/**
 * Integration tests: drive the real streaming route with a2a_handoff events
 * and verify both persistence and broadcast carry the stored messageId.
 *
 * Pattern mirrors messages-delivery-mode.test.js (buildDeps + Fastify inject).
 */

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
        yield { type: 'a2a_handoff', catId: 'opus', content: '布偶猫 → 缅因猫', timestamp: Date.now() };
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
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-a2a-test',
      })),
      update: mock.fn(async () => {}),
    },
    invocationQueue,
    queueProcessor: {
      clearPause: mock.fn(),
      onInvocationComplete: mock.fn(async () => {}),
      enqueueContinuation: mock.fn(() => ({ outcome: 'enqueued' })),
    },
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

describe('Integration: a2a_handoff persistence through streaming route (#648)', () => {
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

  it('persists a2a_handoff as system message and attaches messageId to broadcast', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'test routing', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);

    // Wait for background coroutine to finish processing the generator
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 1. messageStore.append stores system message with extra.systemKind = 'a2a_routing'
    const appendCalls = deps.messageStore.append.mock.calls;
    const a2aAppend = appendCalls.find(
      (c) => c.arguments[0]?.userId === 'system' && c.arguments[0]?.extra?.systemKind === 'a2a_routing',
    );
    assert.ok(a2aAppend, 'messageStore.append should be called with systemKind: a2a_routing');
    assert.equal(a2aAppend.arguments[0].catId, null);
    assert.equal(a2aAppend.arguments[0].content, '布偶猫 → 缅因猫');
    assert.equal(a2aAppend.arguments[0].threadId, 'thread-1');

    // 2. broadcastAgentMessage receives the a2a_handoff event with stored messageId
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    const a2aBroadcast = broadcastCalls.find((c) => c.arguments[0]?.type === 'a2a_handoff');
    assert.ok(a2aBroadcast, 'should broadcast a2a_handoff event');
    assert.ok(a2aBroadcast.arguments[0].messageId, 'broadcast payload should carry stored messageId');
    assert.equal(typeof a2aBroadcast.arguments[0].messageId, 'string');
    assert.equal(a2aBroadcast.arguments[0].invocationId, 'inv-a2a-test');
  });

  it('skips persistence when a2a_handoff has no content', async () => {
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield { type: 'a2a_handoff', catId: 'opus', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'test no content', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No system message should be appended (only user message)
    const appendCalls = deps.messageStore.append.mock.calls;
    const a2aAppend = appendCalls.find(
      (c) => c.arguments[0]?.userId === 'system' && c.arguments[0]?.extra?.systemKind === 'a2a_routing',
    );
    assert.equal(a2aAppend, undefined, 'should not persist a2a_handoff without content');

    // Broadcast still happens, but without messageId
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    const a2aBroadcast = broadcastCalls.find((c) => c.arguments[0]?.type === 'a2a_handoff');
    assert.ok(a2aBroadcast, 'should still broadcast a2a_handoff event');
    assert.equal(a2aBroadcast.arguments[0].messageId, undefined, 'no messageId when content is empty');
  });
});
