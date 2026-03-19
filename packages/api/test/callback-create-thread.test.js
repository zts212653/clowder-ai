/**
 * F128: Callback create-thread route tests
 * POST /api/callbacks/create-thread
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

function createMockSocketManager() {
  const messages = [];
  const userEmits = [];
  return {
    broadcastAgentMessage(msg) {
      messages.push(msg);
    },
    emitToUser(userId, event, data) {
      userEmits.push({ userId, event, data });
    },
    getMessages() {
      return messages;
    },
    getUserEmits() {
      return userEmits;
    },
  };
}

describe('POST /api/callbacks/create-thread (F128)', () => {
  let registry;
  let messageStore;
  let socketManager;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    socketManager = createMockSocketManager();
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
    });
    return app;
  }

  test('creates thread with title and returns threadId', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-thread',
      payload: {
        invocationId,
        callbackToken,
        title: 'Investigate issue #79',
      },
    });

    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);
    assert.ok(body.threadId, 'response must include threadId');
    assert.equal(typeof body.threadId, 'string');

    // Thread should exist in the store
    const thread = await threadStore.get(body.threadId);
    assert.ok(thread, 'thread should be persisted');
    assert.equal(thread.title, 'Investigate issue #79');

    // F128: Should emit thread_created websocket event to user
    const emits = socketManager.getUserEmits();
    assert.equal(emits.length, 1, 'should emit one thread_created event');
    assert.equal(emits[0].userId, 'user-1');
    assert.equal(emits[0].event, 'thread_created');
    assert.equal(emits[0].data.id, body.threadId);
  });

  test('creates thread with preferredCats', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-thread',
      payload: {
        invocationId,
        callbackToken,
        title: 'Design discussion',
        preferredCats: ['codex', 'gemini'],
      },
    });

    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);
    const thread = await threadStore.get(body.threadId);
    assert.ok(thread);
    // preferredCats should be set on the thread
    assert.deepEqual(thread.preferredCats, ['codex', 'gemini']);
  });

  test('returns 401 for invalid credentials', async () => {
    const app = await createApp();
    const { invocationId } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-thread',
      payload: {
        invocationId,
        callbackToken: 'wrong-token',
        title: 'Should fail',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('returns 400 when title is missing', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-thread',
      payload: {
        invocationId,
        callbackToken,
      },
    });

    assert.equal(response.statusCode, 400);
  });

  // F128: parentThreadId tracking for orchestration
  test('stores parentThreadId when provided', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-thread',
      payload: {
        invocationId,
        callbackToken,
        title: 'Sub-task thread',
        parentThreadId: 'main-thread-123',
      },
    });

    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);
    assert.equal(body.parentThreadId, 'main-thread-123', 'response should echo parentThreadId');

    const thread = await threadStore.get(body.threadId);
    assert.ok(thread);
    assert.equal(thread.parentThreadId, 'main-thread-123', 'thread should store parentThreadId');
  });

  // P2 fix: whitespace-only title should be rejected after trim
  test('returns 400 for whitespace-only title', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-thread',
      payload: {
        invocationId,
        callbackToken,
        title: '   ',
      },
    });

    assert.equal(response.statusCode, 400, 'whitespace-only title should fail validation');
  });

  // P2 fix: inherits projectPath from invoking thread
  test('inherits projectPath from source thread', async () => {
    const app = await createApp();
    // Create a source thread with a specific projectPath
    const sourceThread = await threadStore.create('user-1', 'Source thread', '/Users/dev/my-project');
    // Create invocation bound to that thread
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', sourceThread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-thread',
      payload: {
        invocationId,
        callbackToken,
        title: 'Child thread',
      },
    });

    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);
    const newThread = await threadStore.get(body.threadId);
    assert.ok(newThread);
    assert.equal(newThread.projectPath, '/Users/dev/my-project', 'new thread should inherit projectPath');
  });

  // F128: parent thread can discover its children
  test('getChildThreads returns sub-threads', async () => {
    const app = await createApp();
    const mainThread = await threadStore.create('user-1', 'Main orchestration thread');

    // Create two child threads via API
    for (const title of ['Sub-task A', 'Sub-task B']) {
      const { invocationId, callbackToken } = registry.create('user-1', 'opus', mainThread.id);
      await app.inject({
        method: 'POST',
        url: '/api/callbacks/create-thread',
        payload: { invocationId, callbackToken, title, parentThreadId: mainThread.id },
      });
    }

    const children = await threadStore.getChildThreads(mainThread.id);
    assert.equal(children.length, 2, 'main thread should have 2 children');
    assert.equal(children[0].title, 'Sub-task A');
    assert.equal(children[1].title, 'Sub-task B');
    assert.equal(children[0].parentThreadId, mainThread.id);
    assert.equal(children[1].parentThreadId, mainThread.id);
  });

  // P2 fix: stale invocation guard
  test('returns stale_ignored for superseded invocation', async () => {
    const app = await createApp();
    // Create first invocation
    const first = registry.create('user-1', 'opus', 'thread-1');
    // Create second invocation for same thread+cat — supersedes first
    registry.create('user-1', 'opus', 'thread-1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-thread',
      payload: {
        invocationId: first.invocationId,
        callbackToken: first.callbackToken,
        title: 'Ghost thread',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'stale_ignored', 'stale invocation should be rejected');
  });
});
