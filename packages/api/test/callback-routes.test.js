/**
 * Callback Routes Tests
 * 测试 MCP 回传工具的 HTTP 端点
 *
 * Uses lightweight Fastify injection (no real HTTP server).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

// Mock SocketManager
function createMockSocketManager() {
  const messages = [];
  return {
    broadcastAgentMessage(msg) {
      messages.push(msg);
    },
    getMessages() {
      return messages;
    },
  };
}

describe('Callback Routes', () => {
  let registry;
  let messageStore;
  let socketManager;
  let evidenceStore;
  let reflectionService;
  let markerQueue;
  let threadStore;
  let taskStore;
  let backlogStore;
  let featIndexProvider;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    taskStore = new TaskStore();
    backlogStore = new BacklogStore();
    socketManager = createMockSocketManager();
    evidenceStore = {
      search: async () => [],
      health: async () => true,
      initialize: async () => {},
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
    };
    reflectionService = {
      reflect: async () => '',
    };
    markerQueue = {
      submit: async (marker) => ({ id: 'mk-1', createdAt: new Date().toISOString(), ...marker }),
      list: async () => [],
      transition: async () => {},
    };
    featIndexProvider = undefined;
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    const options = {
      registry,
      messageStore,
      socketManager,
      threadStore,
      evidenceStore,
      reflectionService,
      markerQueue,
    };
    if (backlogStore !== undefined) {
      options.backlogStore = backlogStore;
    }
    if (taskStore !== undefined) {
      options.taskStore = taskStore;
    }
    if (featIndexProvider) {
      options.featIndexProvider = featIndexProvider;
    }
    await app.register(callbacksRoutes, options);
    return app;
  }

  // ---- POST /api/callbacks/post-message ----

  test('POST post-message succeeds with valid credentials', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'Hello from cat!',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');

    // Should broadcast via Socket.io
    const broadcasted = socketManager.getMessages();
    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0].catId, 'opus');
    assert.equal(broadcasted[0].content, 'Hello from cat!');

    // Should store in MessageStore
    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].content, 'Hello from cat!');
  });

  test('POST post-message calls outboundHook.deliver when wired', async () => {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();

    let deliverCalled = false;
    let deliverArgs = null;
    const outboundHook = {
      async deliver(threadId, content, catId, richBlocks, threadMeta, origin) {
        deliverCalled = true;
        deliverArgs = { threadId, content, catId, richBlocks, threadMeta, origin };
      },
    };

    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      evidenceStore,
      reflectionService,
      markerQueue,
      outboundHook,
    });

    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'Outbound test message',
      },
    });

    assert.equal(response.statusCode, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(deliverCalled, 'outboundHook.deliver should have been called');
    assert.equal(deliverArgs.content, 'Outbound test message');
    assert.equal(deliverArgs.catId, 'opus');
    assert.equal(deliverArgs.richBlocks, undefined);
    assert.ok(deliverArgs.threadMeta, 'threadMeta should be passed to deliver');
    assert.ok(deliverArgs.threadMeta.threadShortId, 'threadMeta should have threadShortId');
    assert.ok(deliverArgs.threadMeta.deepLinkUrl, 'threadMeta should have deepLinkUrl');
    assert.equal(deliverArgs.origin, 'callback', 'origin should be callback for post-message');
  });

  test('POST post-message returns 401 for invalid token', async () => {
    const app = await createApp();
    const { invocationId } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken: 'wrong-token',
        content: 'Hello',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('POST post-message returns 401 for expired token', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    // Use very short TTL
    registry = new InvocationRegistry({ ttlMs: 1 });
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'Hello',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('POST post-message returns 400 for invalid body', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: { content: '' },
    });

    assert.equal(response.statusCode, 400);
  });

  test('POST post-message deduplicates by clientMessageId (at-least-once safe)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'idempotent message',
        clientMessageId: 'msg-001',
      },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(JSON.parse(first.body).status, 'ok');

    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'idempotent message',
        clientMessageId: 'msg-001',
      },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(JSON.parse(second.body).status, 'duplicate');

    // Only one persisted/broadcast message should exist.
    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].content, 'idempotent message');
    assert.equal(socketManager.getMessages().length, 1);
  });

  test('POST post-message supports cross-thread send with threadId', async () => {
    const app = await createApp();
    const threadA = await threadStore.create('user-1', 'thread-a');
    const threadB = await threadStore.create('user-1', 'thread-b');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', threadA.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        threadId: threadB.id,
        content: 'cross-thread hello',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.threadId, threadB.id);

    const threadAMessages = messageStore.getByThread(threadA.id, 20, 'user-1');
    const threadBMessages = messageStore.getByThread(threadB.id, 20, 'user-1');
    assert.equal(threadAMessages.length, 0);
    assert.equal(threadBMessages.length, 1);
    assert.equal(threadBMessages[0].content, 'cross-thread hello');
  });

  test('POST post-message routes cross-paragraph @mention (no keyword gate)', async () => {
    const app = await createApp();
    const threadA = await threadStore.create('user-1', 'thread-a');
    const threadB = await threadStore.create('user-1', 'thread-b');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', threadA.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        threadId: threadB.id,
        content: '@缅因猫\n\n请 review 这个改动',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.threadId, threadB.id);

    const threadBMessages = messageStore.getByThread(threadB.id, 20, 'user-1');
    assert.equal(threadBMessages.length, 1);
    assert.deepEqual(threadBMessages[0].mentions, ['codex']);
  });

  test('POST post-message stores targetCats in extra and uses as mentions (F098-C1)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'Review 结果通知',
        targetCats: ['codex', 'gpt52'],
      },
    });

    assert.equal(response.statusCode, 200);

    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    // targetCats should be used as mentions
    assert.deepEqual(recent[0].mentions, ['codex', 'gpt52']);
    // targetCats should be stored in extra for frontend direction rendering
    assert.deepEqual(recent[0].extra?.targetCats, ['codex', 'gpt52']);
  });

  test('POST post-message broadcasts targetCats in real-time socket event (cloud P2)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'Direction test',
        targetCats: ['codex', 'gpt52'],
      },
    });

    const broadcasted = socketManager.getMessages();
    assert.equal(broadcasted.length, 1);
    assert.deepEqual(
      broadcasted[0].extra?.targetCats,
      ['codex', 'gpt52'],
      'real-time broadcast must include extra.targetCats for immediate direction pill rendering',
    );
  });

  test('POST post-message single content @mention ignores extra explicit targetCats (A2A fail-closed)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'FYI\n@codex',
        targetCats: ['gpt52'],
      },
    });

    assert.equal(response.statusCode, 200);

    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    // Single content mention should win; extras from explicit targetCats are pruned.
    const mentions = recent[0].mentions;
    assert.ok(mentions.includes('codex'), 'content @mention should be included');
    assert.equal(mentions.includes('gpt52'), false, 'extra explicit targetCats should be pruned');
    assert.deepEqual(recent[0].extra?.targetCats, ['gpt52']);
  });

  test('POST post-message keeps merged targets when content has multiple @mentions', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: '同步一下\n@codex\n@gpt52',
        targetCats: ['gemini'],
      },
    });

    assert.equal(response.statusCode, 200);
    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    const mentions = recent[0].mentions;
    assert.ok(mentions.includes('codex'));
    assert.ok(mentions.includes('gpt52'));
    assert.ok(mentions.includes('gemini'), 'multi-mention content should still merge explicit targetCats');
  });

  test('POST post-message rejects cross-thread send to another user thread', async () => {
    const app = await createApp();
    const threadA = await threadStore.create('user-1', 'thread-a');
    const foreignThread = await threadStore.create('user-2', 'thread-foreign');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', threadA.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        threadId: foreignThread.id,
        content: 'should fail',
      },
    });

    assert.equal(response.statusCode, 403);
  });

  // ---- GET /api/callbacks/pending-mentions ----

  test('GET pending-mentions returns mentions for the cat', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    // Add some messages with mentions
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@opus help me',
      mentions: ['opus'],
      timestamp: Date.now(),
    });
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@codex review',
      mentions: ['codex'],
      timestamp: Date.now(),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/pending-mentions?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.mentions.length, 1);
    assert.equal(body.mentions[0].message, '@opus help me');
  });

  test('GET pending-mentions returns empty array when no mentions', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/pending-mentions?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.mentions.length, 0);
  });

  // ---- GET /api/callbacks/thread-context ----

  test('GET thread-context returns recent messages', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Message 1',
      mentions: [],
      timestamp: 1,
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Reply 1',
      mentions: [],
      timestamp: 2,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].content, 'Message 1');
    assert.equal(body.messages[1].content, 'Reply 1');
  });

  test('GET thread-context respects limit parameter', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    for (let i = 0; i < 10; i++) {
      messageStore.append({
        userId: 'user-1',
        catId: null,
        content: `Message ${i}`,
        mentions: [],
        timestamp: i,
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&limit=3`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 3);
  });

  test('GET thread-context supports catId filter (cat + user)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'human message',
      mentions: [],
      timestamp: 1,
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'opus reply',
      mentions: [],
      timestamp: 2,
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'codex reply',
      mentions: [],
      timestamp: 3,
    });

    const catResponse = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&catId=codex`,
    });
    assert.equal(catResponse.statusCode, 200);
    const catBody = JSON.parse(catResponse.body);
    assert.equal(catBody.messages.length, 1);
    assert.equal(catBody.messages[0].content, 'codex reply');

    const userResponse = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&catId=user`,
    });
    assert.equal(userResponse.statusCode, 200);
    const userBody = JSON.parse(userResponse.body);
    assert.equal(userBody.messages.length, 1);
    assert.equal(userBody.messages[0].content, 'human message');
  });

  test('GET thread-context supports keyword filter (case-insensitive)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Discuss Redis lock strategy',
      mentions: [],
      timestamp: 1,
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'No database updates here',
      mentions: [],
      timestamp: 2,
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'redis retry and timeout',
      mentions: [],
      timestamp: 3,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&keyword=ReDiS`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].content, 'Discuss Redis lock strategy');
    assert.equal(body.messages[1].content, 'redis retry and timeout');
  });

  test('GET thread-context combines catId + keyword filters', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'redis findings',
      mentions: [],
      timestamp: 1,
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'other topic',
      mentions: [],
      timestamp: 2,
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'redis but different cat',
      mentions: [],
      timestamp: 3,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&catId=codex&keyword=redis`,
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'redis findings');
  });

  test('GET thread-context rejects unknown catId filter', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&catId=unknown-cat`,
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.match(body.error, /Unknown catId filter/);
  });

  // ---- Cross-user isolation (P1 regression) ----

  test('GET thread-context only returns messages from the same user', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    // user-1's message
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'User 1 msg',
      mentions: [],
      timestamp: 1,
    });
    // user-2's message (should NOT be visible to user-1's invocation)
    messageStore.append({
      userId: 'user-2',
      catId: null,
      content: 'User 2 msg',
      mentions: [],
      timestamp: 2,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'User 1 msg');
  });

  test('GET thread-context includes contentBlocks (image attachments)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Check this screenshot',
      contentBlocks: [
        { type: 'text', text: 'Check this screenshot' },
        { type: 'image', url: '/uploads/1234567890-abc.png' },
      ],
      mentions: [],
      timestamp: 1,
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'I see the image',
      mentions: [],
      timestamp: 2,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 2);
    // Message with image should include contentBlocks
    assert.ok(body.messages[0].contentBlocks, 'contentBlocks should be present');
    assert.equal(body.messages[0].contentBlocks.length, 2);
    assert.equal(body.messages[0].contentBlocks[1].type, 'image');
    assert.equal(body.messages[0].contentBlocks[1].url, '/uploads/1234567890-abc.png');
    // Message without contentBlocks should not have the field
    assert.equal(body.messages[1].contentBlocks, undefined);
  });

  // ---- F-Swarm-6: Cross-thread context read ----

  test('GET thread-context with threadId reads a different thread', async () => {
    const app = await createApp();
    // Invocation scoped to thread-A
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-A');

    // Messages in thread-A (own thread)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'thread-A msg',
      mentions: [],
      timestamp: 1,
      threadId: 'thread-A',
    });
    // Messages in thread-B (cross-thread target)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'thread-B msg 1',
      mentions: [],
      timestamp: 2,
      threadId: 'thread-B',
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'thread-B msg 2',
      mentions: [],
      timestamp: 3,
      threadId: 'thread-B',
    });

    // Query thread-B from an invocation in thread-A
    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&threadId=thread-B`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].content, 'thread-B msg 1');
    assert.equal(body.messages[1].content, 'thread-B msg 2');
  });

  test('GET thread-context without threadId reads own thread (default)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-A');

    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'thread-A msg',
      mentions: [],
      timestamp: 1,
      threadId: 'thread-A',
    });
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'thread-B msg',
      mentions: [],
      timestamp: 2,
      threadId: 'thread-B',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'thread-A msg');
  });

  test('GET thread-context cross-thread respects limit', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-A');

    // 5 messages in thread-B
    for (let i = 0; i < 5; i++) {
      messageStore.append({
        userId: 'user-1',
        catId: null,
        content: `thread-B msg ${i}`,
        mentions: [],
        timestamp: i + 1,
        threadId: 'thread-B',
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&threadId=thread-B&limit=2`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 2);
    // Should return the 2 most recent
    assert.equal(body.messages[0].content, 'thread-B msg 3');
    assert.equal(body.messages[1].content, 'thread-B msg 4');
  });

  // ---- GET /api/callbacks/list-threads ----

  test('GET list-threads returns user-scoped threads sorted by lastActiveAt desc', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const oldThread = await threadStore.create('user-1', 'Old thread');
    const newThread = await threadStore.create('user-1', 'New thread');
    const otherUserThread = await threadStore.create('user-2', 'Other user thread');

    const oldThreadRecord = await threadStore.get(oldThread.id);
    const newThreadRecord = await threadStore.get(newThread.id);
    const otherThreadRecord = await threadStore.get(otherUserThread.id);
    oldThreadRecord.lastActiveAt = 1000;
    newThreadRecord.lastActiveAt = 2000;
    otherThreadRecord.lastActiveAt = 3000;

    await threadStore.addParticipants(newThread.id, ['opus', 'codex']);
    await threadStore.addParticipants(oldThread.id, ['opus']);
    await threadStore.addParticipants(otherUserThread.id, ['gpt52']);

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/list-threads?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);

    assert.equal(body.threads.length, 2);
    assert.deepEqual(
      body.threads.map((item) => item.threadId),
      [newThread.id, oldThread.id],
    );
    assert.deepEqual(body.threads[0], {
      threadId: newThread.id,
      title: 'New thread',
      lastActiveAt: 2000,
      pinned: false,
      messageCount: null,
      participants: ['opus', 'codex'],
    });
    assert.deepEqual(body.threads[1], {
      threadId: oldThread.id,
      title: 'Old thread',
      lastActiveAt: 1000,
      pinned: false,
      messageCount: null,
      participants: ['opus'],
    });
  });

  test('GET list-threads supports activeSince + limit', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const t1 = await threadStore.create('user-1', 't1');
    const t2 = await threadStore.create('user-1', 't2');
    const t3 = await threadStore.create('user-1', 't3');

    const r1 = await threadStore.get(t1.id);
    const r2 = await threadStore.get(t2.id);
    const r3 = await threadStore.get(t3.id);
    r1.lastActiveAt = 100;
    r2.lastActiveAt = 200;
    r3.lastActiveAt = 300;

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/list-threads?invocationId=${invocationId}&callbackToken=${callbackToken}&activeSince=150&limit=1`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.threads.length, 1);
    assert.equal(body.threads[0].threadId, t3.id);
    assert.equal(body.threads[0].lastActiveAt, 300);
  });

  test('GET list-threads filters by keyword (title + threadId)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    await threadStore.create('user-1', 'Clowder AI Design');
    await threadStore.create('user-1', 'Redis Debugging');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/list-threads?invocationId=${invocationId}&callbackToken=${callbackToken}&keyword=design`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.threads.length, 1);
    assert.equal(body.threads[0].title, 'Clowder AI Design');
  });

  test('GET list-threads validates query params', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/list-threads?invocationId=${invocationId}&callbackToken=${callbackToken}&limit=0&activeSince=-1`,
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.match(body.error, /Missing invocationId or callbackToken|Invalid request query/);
  });

  test('GET list-threads returns 503 when threadStore is not configured', async () => {
    threadStore = undefined;
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/list-threads?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 503);
    const body = JSON.parse(response.body);
    assert.match(body.error, /Thread store not configured/);
  });

  test('GET list-tasks returns user-scoped tasks and supports filters', async () => {
    const app = await createApp();
    const threadA = await threadStore.create('user-1', 'thread-a');
    const threadB = await threadStore.create('user-1', 'thread-b');
    const threadOther = await threadStore.create('user-2', 'thread-other');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', threadA.id);

    const taskA1 = await taskStore.create({
      threadId: threadA.id,
      title: 'task-a1',
      why: 'a1',
      createdBy: 'user',
      ownerCatId: 'codex',
    });
    const taskA2 = await taskStore.create({
      threadId: threadA.id,
      title: 'task-a2',
      why: 'a2',
      createdBy: 'user',
      ownerCatId: 'opus',
    });
    await taskStore.update(taskA2.id, { status: 'doing' });
    const taskB1 = await taskStore.create({
      threadId: threadB.id,
      title: 'task-b1',
      why: 'b1',
      createdBy: 'user',
      ownerCatId: 'codex',
    });
    await taskStore.update(taskB1.id, { status: 'blocked' });
    await taskStore.create({
      threadId: threadOther.id,
      title: 'task-other',
      why: 'other',
      createdBy: 'user',
      ownerCatId: 'codex',
    });

    const allRes = await app.inject({
      method: 'GET',
      url: `/api/callbacks/list-tasks?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });
    assert.equal(allRes.statusCode, 200);
    const allBody = JSON.parse(allRes.body);
    assert.deepEqual(allBody.tasks.map((task) => task.id).sort(), [taskA1.id, taskA2.id, taskB1.id].sort());

    const filteredRes = await app.inject({
      method: 'GET',
      url: `/api/callbacks/list-tasks?invocationId=${invocationId}&callbackToken=${callbackToken}&catId=codex&status=blocked`,
    });
    assert.equal(filteredRes.statusCode, 200);
    const filteredBody = JSON.parse(filteredRes.body);
    assert.equal(filteredBody.tasks.length, 1);
    assert.equal(filteredBody.tasks[0].id, taskB1.id);
  });

  test('GET list-tasks rejects cross-user thread filter', async () => {
    const app = await createApp();
    const threadA = await threadStore.create('user-1', 'thread-a');
    const foreignThread = await threadStore.create('user-2', 'thread-foreign');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', threadA.id);

    const response = await app.inject({
      method: 'GET',
      url:
        `/api/callbacks/list-tasks?invocationId=${invocationId}` +
        `&callbackToken=${callbackToken}&threadId=${foreignThread.id}`,
    });

    assert.equal(response.statusCode, 403);
  });

  // ---- GET /api/callbacks/feat-index ----

  test('GET feat-index returns entries with default limit and phase-A threadIds', async () => {
    featIndexProvider = async () => [
      { featId: 'F042', name: 'Prompt Engineering Audit', status: 'done' },
      { featId: 'F043', name: 'MCP Unification', status: 'spec', keyDecisions: ['A', 'B'] },
    ];
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/feat-index?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.items[0], {
      featId: 'F042',
      name: 'Prompt Engineering Audit',
      status: 'done',
      threadIds: [],
    });
    assert.deepEqual(body.items[1], {
      featId: 'F043',
      name: 'MCP Unification',
      status: 'spec',
      keyDecisions: ['A', 'B'],
      threadIds: [],
    });
  });

  test('GET feat-index enriches threadIds from backlog feature tags via thread backlogItemId mapping', async () => {
    featIndexProvider = async () => [
      { featId: 'F040', name: 'Backlog Reorganization', status: 'in-progress' },
      { featId: 'F043', name: 'MCP Unification', status: 'spec' },
    ];

    const backlogF040 = await backlogStore.create({
      userId: 'user-1',
      title: '[F040] Backlog Reorganization',
      summary: 'feature f040',
      priority: 'p1',
      tags: ['feature:f040', 'status:in-progress'],
      createdBy: 'user',
    });
    const backlogF043 = await backlogStore.create({
      userId: 'user-1',
      title: '[F043] MCP Unification',
      summary: 'feature f043',
      priority: 'p2',
      tags: ['feature:f043', 'status:spec'],
      createdBy: 'user',
    });
    const backlogOtherUser = await backlogStore.create({
      userId: 'user-2',
      title: '[F040] Other user feature',
      summary: 'feature f040 from another user',
      priority: 'p2',
      tags: ['feature:f040', 'status:spec'],
      createdBy: 'user',
    });

    const threadA = threadStore.create('user-1', 'F040 discussion');
    const threadB = threadStore.create('user-1', 'F043 discussion');
    const threadOtherUser = threadStore.create('user-2', 'F040 other user');
    threadStore.linkBacklogItem(threadA.id, backlogF040.id);
    threadStore.linkBacklogItem(threadB.id, backlogF043.id);
    threadStore.linkBacklogItem(threadOtherUser.id, backlogOtherUser.id);

    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');
    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/feat-index?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    const f040 = body.items.find((item) => item.featId === 'F040');
    const f043 = body.items.find((item) => item.featId === 'F043');

    assert.ok(f040);
    assert.ok(f043);
    assert.deepEqual(f040.threadIds, [threadA.id]);
    assert.deepEqual(f043.threadIds, [threadB.id]);
  });

  test('GET feat-index degrades gracefully when threadStore enrichment fails', async () => {
    featIndexProvider = async () => [{ featId: 'F043', name: 'MCP Unification', status: 'spec' }];
    threadStore = {
      list: async () => {
        throw new Error('boom');
      },
    };
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/feat-index?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.items[0].threadIds, []);
  });

  test('GET feat-index supports exact featId match (case-insensitive)', async () => {
    featIndexProvider = async () => [
      { featId: 'F039', name: 'Mission Hub', status: 'in-progress' },
      { featId: 'F043', name: 'MCP Unification', status: 'spec' },
    ];
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const hit = await app.inject({
      method: 'GET',
      url: `/api/callbacks/feat-index?invocationId=${invocationId}&callbackToken=${callbackToken}&featId=f043`,
    });
    assert.equal(hit.statusCode, 200);
    const hitBody = JSON.parse(hit.body);
    assert.equal(hitBody.items.length, 1);
    assert.equal(hitBody.items[0].featId, 'F043');

    const miss = await app.inject({
      method: 'GET',
      url: `/api/callbacks/feat-index?invocationId=${invocationId}&callbackToken=${callbackToken}&featId=F04`,
    });
    assert.equal(miss.statusCode, 200);
    const missBody = JSON.parse(miss.body);
    assert.equal(missBody.items.length, 0);
  });

  test('GET feat-index supports query fuzzy match over featId/name/status', async () => {
    featIndexProvider = async () => [
      { featId: 'F043', name: 'MCP Unification', status: 'spec' },
      { featId: 'F046', name: 'Anti-Drift Protocol', status: 'in-progress' },
      { featId: 'F049', name: 'Mission Hub', status: 'done' },
    ];
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const byFeatId = await app.inject({
      method: 'GET',
      url: `/api/callbacks/feat-index?invocationId=${invocationId}&callbackToken=${callbackToken}&query=F04`,
    });
    assert.equal(byFeatId.statusCode, 200);
    const byFeatIdBody = JSON.parse(byFeatId.body);
    assert.equal(byFeatIdBody.items.length, 3);

    const byStatus = await app.inject({
      method: 'GET',
      url: `/api/callbacks/feat-index?invocationId=${invocationId}&callbackToken=${callbackToken}&query=PROGRESS`,
    });
    assert.equal(byStatus.statusCode, 200);
    const byStatusBody = JSON.parse(byStatus.body);
    assert.equal(byStatusBody.items.length, 1);
    assert.equal(byStatusBody.items[0].featId, 'F046');
  });

  test('GET feat-index validates limit max=100', async () => {
    featIndexProvider = async () => [{ featId: 'F043', name: 'MCP Unification', status: 'spec' }];
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/feat-index?invocationId=${invocationId}&callbackToken=${callbackToken}&limit=101`,
    });
    assert.equal(response.statusCode, 400);
  });

  test('GET feat-index returns 401 for invalid callback credentials', async () => {
    featIndexProvider = async () => [{ featId: 'F043', name: 'MCP Unification', status: 'spec' }];
    const app = await createApp();
    const { invocationId } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/feat-index?invocationId=${invocationId}&callbackToken=bad-token`,
    });
    assert.equal(response.statusCode, 401);
  });

  test('GET pending-mentions only returns mentions from the same user', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    // user-1 mentions opus
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@opus from user-1',
      mentions: ['opus'],
      timestamp: 1,
    });
    // user-2 also mentions opus (should NOT be visible)
    messageStore.append({
      userId: 'user-2',
      catId: null,
      content: '@opus from user-2',
      mentions: ['opus'],
      timestamp: 2,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/pending-mentions?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.mentions.length, 1);
    assert.equal(body.mentions[0].message, '@opus from user-1');
  });

  test('GET pending-mentions only returns mentions from the same thread (#75)', async () => {
    const app = await createApp();
    // Create invocation scoped to thread-A
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-A');

    // @opus in thread-A (should be visible)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@opus in thread-A',
      mentions: ['opus'],
      timestamp: 1,
      threadId: 'thread-A',
    });
    // @opus in thread-B (should NOT be visible — cross-thread leak)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@opus in thread-B',
      mentions: ['opus'],
      timestamp: 2,
      threadId: 'thread-B',
    });
    // @opus in thread-A again
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@opus in thread-A again',
      mentions: ['opus'],
      timestamp: 3,
      threadId: 'thread-A',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/pending-mentions?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.mentions.length, 2);
    assert.equal(body.mentions[0].message, '@opus in thread-A');
    assert.equal(body.mentions[1].message, '@opus in thread-A again');
  });

  test('GET pending-mentions returns 400 without credentials', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/pending-mentions',
    });

    assert.equal(response.statusCode, 400);
  });

  // ---- SQLite memory service callbacks (F102 Phase D1) ----

  test('GET search-evidence returns results from evidence store', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex');
    evidenceStore.search = async () => [
      {
        anchor: 'docs/decisions/005-hindsight-integration-decisions.md',
        kind: 'decision',
        status: 'active',
        title: 'ADR-005',
        summary: 'ADR-005 decided single shared bank',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/search-evidence?invocationId=${invocationId}&callbackToken=${callbackToken}&q=single%20bank&limit=1`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(Array.isArray(body.results), true);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].anchor, 'docs/decisions/005-hindsight-integration-decisions.md');
    assert.equal(body.results[0].sourceType, 'decision');
    assert.equal(body.degraded, false);
  });

  test('GET search-evidence passes query and limit to evidence store', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex');
    let capturedArgs;
    evidenceStore.search = async (query, opts) => {
      capturedArgs = { query, opts };
      return [];
    };

    await app.inject({
      method: 'GET',
      url: `/api/callbacks/search-evidence?invocationId=${invocationId}&callbackToken=${callbackToken}&q=bank-policy&limit=3`,
    });

    assert.equal(capturedArgs.query, 'bank-policy');
    assert.equal(capturedArgs.opts.limit, 3);
  });

  test('GET search-evidence defaults limit to 5', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex');
    let capturedOpts;
    evidenceStore.search = async (_q, opts) => {
      capturedOpts = opts;
      return [];
    };

    await app.inject({
      method: 'GET',
      url: `/api/callbacks/search-evidence?invocationId=${invocationId}&callbackToken=${callbackToken}&q=test`,
    });

    assert.equal(capturedOpts.limit, 5);
  });

  test('GET search-evidence degrades when evidence store throws', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex');
    evidenceStore.search = async () => {
      throw new Error('SQLite error');
    };

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/search-evidence?invocationId=${invocationId}&callbackToken=${callbackToken}&q=bank-policy`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'evidence_store_error');
    assert.deepEqual(body.results, []);
  });

  test('GET search-evidence returns 401 for invalid credentials', async () => {
    const app = await createApp();
    const { invocationId } = registry.create('user-1', 'codex');

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/search-evidence?invocationId=${invocationId}&callbackToken=wrong&q=test`,
    });

    assert.equal(response.statusCode, 401);
  });

  test('POST reflect returns reflection text', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex');
    let capturedQuery;
    reflectionService.reflect = async (query) => {
      capturedQuery = query;
      return 'Phase 5 focused on evidence-first governance.';
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/reflect',
      payload: {
        invocationId,
        callbackToken,
        query: 'What changed in phase 5?',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.reflection, 'Phase 5 focused on evidence-first governance.');
    assert.equal(body.degraded, false);
    assert.equal(capturedQuery, 'What changed in phase 5?');
  });

  test('POST reflect degrades when reflection service throws', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex');
    reflectionService.reflect = async () => {
      throw new Error('reflection failure');
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/reflect',
      payload: {
        invocationId,
        callbackToken,
        query: 'What changed in phase 5?',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.degraded, true);
    assert.equal(body.degradeReason, 'reflection_service_error');
    assert.equal(body.reflection, '');
  });

  test('POST reflect returns 401 for invalid credentials', async () => {
    const app = await createApp();
    const { invocationId } = registry.create('user-1', 'codex');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/reflect',
      payload: {
        invocationId,
        callbackToken: 'wrong',
        query: 'test',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('POST retain-memory submits to marker queue', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex');
    const submitCalls = [];
    markerQueue.submit = async (marker) => {
      submitCalls.push(marker);
      return { id: 'mk-1', createdAt: new Date().toISOString(), ...marker };
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/retain-memory',
      payload: {
        invocationId,
        callbackToken,
        content: 'When storage is unavailable, fail-closed and surface explicit errors.',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');
    assert.equal(submitCalls.length, 1);
    assert.equal(submitCalls[0].content, 'When storage is unavailable, fail-closed and surface explicit errors.');
    assert.equal(submitCalls[0].status, 'captured');
    assert.ok(submitCalls[0].source.includes('codex'));
    assert.ok(submitCalls[0].source.includes(invocationId));
  });

  test('POST retain-memory returns 401 for invalid callback token', async () => {
    const app = await createApp();
    const { invocationId } = registry.create('user-1', 'codex');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/retain-memory',
      payload: {
        invocationId,
        callbackToken: 'invalid-token',
        content: 'memory',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('POST retain-memory degrades when marker queue throws', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex');
    markerQueue.submit = async () => {
      throw new Error('queue error');
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/retain-memory',
      payload: {
        invocationId,
        callbackToken,
        content: 'memory item',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'degraded');
    assert.equal(body.degradeReason, 'marker_queue_error');
  });

  // --- Stale callback freshness guard (cloud Codex P1 + 缅因猫 R3) ---

  test('POST post-message returns stale_ignored for superseded invocation', async () => {
    const app = await createApp();

    // Old invocation for opus on thread-1
    const old = registry.create('user-1', 'opus', 'thread-1');
    // New invocation supersedes — same thread+cat
    registry.create('user-1', 'opus', 'thread-1');

    // Old invocation's callback should be rejected (stale)
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId: old.invocationId,
        callbackToken: old.callbackToken,
        content: 'Stale message from old invocation',
      },
    });

    assert.equal(response.statusCode, 200, 'should return 200 (not 401) to avoid retry storms');
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'stale_ignored');

    // Message should NOT be stored
    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 0, 'stale callback should not store a message');
  });

  test('POST post-message allows latest invocation after stale is rejected', async () => {
    const app = await createApp();

    // Old invocation
    registry.create('user-1', 'opus', 'thread-1');
    // New invocation supersedes
    const latest = registry.create('user-1', 'opus', 'thread-1');

    // Latest invocation's callback should succeed
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId: latest.invocationId,
        callbackToken: latest.callbackToken,
        content: 'Fresh message from latest invocation',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');

    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].content, 'Fresh message from latest invocation');
  });

  // ---- #83: Rich block extraction in post-message ----

  test('POST post-message extracts cc_rich blocks and stores them in extra.rich', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-rb');

    const richPayload = JSON.stringify({
      v: 1,
      blocks: [{ id: 'card-1', kind: 'card', v: 1, title: 'Test Card', tone: 'info' }],
    });
    const content = `Here is a card:\n\`\`\`cc_rich\n${richPayload}\n\`\`\`\nDone!`;

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: { invocationId, callbackToken, content },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).status, 'ok');

    // Stored message should have clean text (cc_rich stripped) + rich blocks
    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].content, 'Here is a card:\n\nDone!');
    assert.ok(recent[0].extra?.rich, 'extra.rich should be present');
    assert.equal(recent[0].extra.rich.v, 1);
    assert.equal(recent[0].extra.rich.blocks.length, 1);
    assert.equal(recent[0].extra.rich.blocks[0].kind, 'card');
    assert.equal(recent[0].extra.rich.blocks[0].title, 'Test Card');
  });

  test('POST post-message broadcasts rich_block SSE events for extracted blocks', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-rb2');

    const richPayload = JSON.stringify({
      v: 1,
      blocks: [{ id: 'diff-1', kind: 'diff', v: 1, filePath: 'src/foo.ts', diff: '- old\n+ new' }],
    });
    const content = `Check this:\n\`\`\`cc_rich\n${richPayload}\n\`\`\``;

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: { invocationId, callbackToken, content },
    });

    // Should have 2 broadcasts: 1 text + 1 rich_block system_info
    const msgs = socketManager.getMessages();
    const textMsg = msgs.find((m) => m.type === 'text');
    assert.ok(textMsg, 'text broadcast should exist');
    assert.equal(textMsg.content, 'Check this:');
    // P2: text broadcast must include messageId for rich_block correlation
    assert.ok(textMsg.messageId, 'text broadcast should include messageId');
    assert.equal(typeof textMsg.messageId, 'string');

    const richMsg = msgs.find((m) => m.type === 'system_info');
    assert.ok(richMsg, 'rich_block system_info broadcast should exist');
    const parsed = JSON.parse(richMsg.content);
    assert.equal(parsed.type, 'rich_block');
    assert.equal(parsed.block.kind, 'diff');
    assert.equal(parsed.block.filePath, 'src/foo.ts');
    // P2 cloud-review: rich_block SSE events must include messageId for frontend correlation
    assert.ok(parsed.messageId, 'rich_block event should include messageId');
    assert.equal(typeof parsed.messageId, 'string');
  });

  test('POST post-message without cc_rich blocks stores content as-is (no extra.rich)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-rb3');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: { invocationId, callbackToken, content: 'Plain message, no blocks' },
    });

    assert.equal(response.statusCode, 200);
    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].content, 'Plain message, no blocks');
    assert.equal(recent[0].extra, undefined);
  });

  // ---- #85 T7: Route A create-rich-block normalizes type→kind ----

  test('POST create-rich-block normalizes type→kind and auto-fills v:1', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-norm');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-rich-block',
      payload: {
        invocationId,
        callbackToken,
        // Intentionally uses "type" instead of "kind", missing v
        block: { id: 'b1', type: 'card', title: 'Normalized', bodyMarkdown: '**bold**' },
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');

    // Verify the broadcast block was normalized
    const msgs = socketManager.getMessages();
    assert.equal(msgs.length, 1);
    const parsed = JSON.parse(msgs[0].content);
    assert.equal(parsed.block.kind, 'card');
    assert.equal(parsed.block.type, undefined);
  });

  // ---- Play mode pagination backfill (砚砚 R5 regression) ----

  test('GET thread-context play mode returns full limit even when stream messages dominate', async () => {
    // Regression (砚砚 R5+R6): play mode filters other cats' origin:'stream'.
    // Real failure timing: visible messages are OLDER, hidden stream is NEWER.
    // Pagination must wade through all hidden stream to reach visible messages.
    const thread = threadStore.create('user-1', 'Play backfill test');
    const actualThreadId = thread.id;
    threadStore.updateThinkingMode(actualThreadId, 'play');

    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', actualThreadId);

    // 10 visible messages first (OLDER timestamps: 1000-1018)
    for (let i = 0; i < 5; i++) {
      messageStore.append({
        userId: 'user-1',
        catId: null,
        content: `user msg ${i}`,
        mentions: [],
        timestamp: 1000 + i * 2,
        threadId: actualThreadId,
      });
      messageStore.append({
        userId: 'user-1',
        catId: 'codex',
        content: `codex callback ${i}`,
        mentions: [],
        origin: 'callback',
        timestamp: 1001 + i * 2,
        threadId: actualThreadId,
      });
    }

    // 500 hidden stream messages from codex (NEWER timestamps: 2000-2499)
    // These bury the visible messages — pagination must go through all 500.
    for (let i = 0; i < 500; i++) {
      messageStore.append({
        userId: 'user-1',
        catId: 'codex',
        content: `codex stream ${i}`,
        mentions: [],
        origin: 'stream',
        timestamp: 2000 + i,
        threadId: actualThreadId,
      });
    }

    // Request limit=10 — all 10 visible messages are buried under 500 hidden
    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&limit=10`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.messages.length, 10, 'play mode must return full requestedLimit visible messages');

    // All returned messages should be visible (no codex stream)
    for (const msg of body.messages) {
      assert.ok(
        !msg.content.startsWith('codex stream'),
        `should not contain codex stream messages, got: ${msg.content}`,
      );
    }

    // Verify ordering: oldest visible first
    assert.equal(body.messages[0].content, 'user msg 0');
    assert.equal(body.messages[9].content, 'codex callback 4');
  });

  // ---- Legacy thread backward compatibility (cloud P1 regression) ----

  test('GET thread-context play mode shows legacy untagged cat messages', async () => {
    // Regression: origin field was added later. Legacy threads have no origin
    // on cat messages. Play mode must NOT hide these — they are historical
    // callback speech, not stream thinking.
    const thread = threadStore.create('user-1', 'Legacy compat test');
    const tid = thread.id;
    threadStore.updateThinkingMode(tid, 'play');

    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', tid);

    // 3 legacy messages from codex (no origin — pre-feature data)
    for (let i = 0; i < 3; i++) {
      messageStore.append({
        userId: 'user-1',
        catId: 'codex',
        content: `legacy codex msg ${i}`,
        mentions: [],
        timestamp: 1000 + i,
        threadId: tid,
      });
    }
    // 2 user messages
    for (let i = 0; i < 2; i++) {
      messageStore.append({
        userId: 'user-1',
        catId: null,
        content: `user msg ${i}`,
        mentions: [],
        timestamp: 2000 + i,
        threadId: tid,
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&limit=10`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    // All 5 messages should be visible (3 legacy codex + 2 user)
    assert.equal(body.messages.length, 5, 'legacy untagged cat messages must be visible in play mode');
    assert.equal(body.messages[0].content, 'legacy codex msg 0');
    assert.equal(body.messages[4].content, 'user msg 1');
  });

  test('GET thread-context play mode hides tagged stream but shows legacy in same thread', async () => {
    // Mixed thread: some legacy untagged + some new tagged stream.
    // Legacy visible, tagged stream hidden.
    const thread = threadStore.create('user-1', 'Mixed legacy test');
    const tid = thread.id;
    threadStore.updateThinkingMode(tid, 'play');

    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', tid);

    // 2 legacy untagged from codex (visible)
    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'legacy reply',
      mentions: [],
      timestamp: 1000,
      threadId: tid,
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'legacy reply 2',
      mentions: [],
      timestamp: 1001,
      threadId: tid,
    });
    // 1 tagged stream from codex (hidden)
    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'thinking output',
      mentions: [],
      origin: 'stream',
      timestamp: 2000,
      threadId: tid,
    });
    // 1 tagged callback from codex (visible)
    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'callback speech',
      mentions: [],
      origin: 'callback',
      timestamp: 3000,
      threadId: tid,
    });
    // 1 user message (visible)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'user question',
      mentions: [],
      timestamp: 4000,
      threadId: tid,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&limit=10`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    // 4 visible: 2 legacy + 1 callback + 1 user. Stream hidden.
    assert.equal(body.messages.length, 4, 'tagged stream hidden, legacy + callback + user visible');
    const contents = body.messages.map((m) => m.content);
    assert.ok(!contents.includes('thinking output'), 'stream must be hidden');
    assert.ok(contents.includes('legacy reply'), 'legacy must be visible');
    assert.ok(contents.includes('callback speech'), 'callback must be visible');
  });

  // ---- TD091: threadId echo in thread-context ----

  test('GET thread-context response includes threadId field', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-xyz');

    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'hi',
      mentions: [],
      timestamp: 1,
      threadId: 'thread-xyz',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.threadId, 'thread-xyz', 'response must echo the invocation threadId');
    assert.ok(Array.isArray(body.messages));
  });

  test('GET thread-context cross-thread echoes requested threadId', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-home');

    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'msg-A',
      mentions: [],
      timestamp: 1,
      threadId: 'thread-other',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?invocationId=${invocationId}&callbackToken=${callbackToken}&threadId=thread-other`,
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.threadId, 'thread-other', 'cross-thread read must echo the requested threadId');
  });

  // ---- TD091: POST /api/callbacks/register-pr-tracking ----

  test('POST register-pr-tracking succeeds with valid input', async () => {
    const { MemoryPrTrackingStore } = await import('../dist/infrastructure/email/PrTrackingStore.js');
    const prTrackingStore = new MemoryPrTrackingStore();

    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
      prTrackingStore,
    });

    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-pr');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      payload: {
        invocationId,
        callbackToken,
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 99,
        catId: 'opus',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.threadId, 'thread-pr', 'server must resolve threadId from invocation');
    assert.equal(body.entry.repoFullName, 'zts212653/cat-cafe');
    assert.equal(body.entry.prNumber, 99);
    assert.equal(body.entry.catId, 'opus');
    assert.equal(body.entry.threadId, 'thread-pr');
    assert.ok(body.entry.registeredAt > 0);

    // Verify stored in prTrackingStore
    const found = prTrackingStore.get('zts212653/cat-cafe', 99);
    assert.ok(found, 'entry must be stored');
    assert.equal(found.threadId, 'thread-pr');
  });

  test('POST register-pr-tracking rejects invalid credentials', async () => {
    const { MemoryPrTrackingStore } = await import('../dist/infrastructure/email/PrTrackingStore.js');
    const prTrackingStore = new MemoryPrTrackingStore();

    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
      prTrackingStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      payload: {
        invocationId: 'bogus',
        callbackToken: 'bogus',
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 1,
        catId: 'opus',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('POST register-pr-tracking ignores payload catId, uses invocation identity', async () => {
    const { MemoryPrTrackingStore } = await import('../dist/infrastructure/email/PrTrackingStore.js');
    const prTrackingStore = new MemoryPrTrackingStore();

    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
      prTrackingStore,
    });

    // Invocation is opus, payload sends bogus catId — server must ignore payload
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      payload: {
        invocationId,
        callbackToken,
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 1,
        catId: 'nonexistent-cat', // bogus — should be ignored
      },
    });

    assert.equal(response.statusCode, 200, 'payload catId is ignored, so bogus value must not cause 400');
    const body = JSON.parse(response.body);
    assert.equal(body.entry.catId, 'opus', 'must use invocation catId, not payload');
  });

  test('POST register-pr-tracking rejects overwrite from different user (P1-2 ownership)', async () => {
    const { MemoryPrTrackingStore } = await import('../dist/infrastructure/email/PrTrackingStore.js');
    const prTrackingStore = new MemoryPrTrackingStore();

    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
      prTrackingStore,
    });

    // User A registers PR #42
    const userA = registry.create('user-A', 'opus', 'thread-A');
    const regA = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      payload: {
        invocationId: userA.invocationId,
        callbackToken: userA.callbackToken,
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
      },
    });
    assert.equal(regA.statusCode, 200);

    // User B tries to overwrite PR #42
    const userB = registry.create('user-B', 'codex', 'thread-B');
    const regB = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      payload: {
        invocationId: userB.invocationId,
        callbackToken: userB.callbackToken,
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'codex',
      },
    });
    assert.equal(regB.statusCode, 409, 'must reject overwrite from different user');

    // Original entry should be unchanged
    const entry = prTrackingStore.get('zts212653/cat-cafe', 42);
    assert.equal(entry.userId, 'user-A', 'original owner must be preserved');
    assert.equal(entry.threadId, 'thread-A');
  });

  test('POST register-pr-tracking allows re-register from same user (update thread)', async () => {
    const { MemoryPrTrackingStore } = await import('../dist/infrastructure/email/PrTrackingStore.js');
    const prTrackingStore = new MemoryPrTrackingStore();

    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
      prTrackingStore,
    });

    // User A registers PR #42 from thread-1
    const inv1 = registry.create('user-A', 'opus', 'thread-1');
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      payload: {
        invocationId: inv1.invocationId,
        callbackToken: inv1.callbackToken,
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
      },
    });

    // Same user re-registers from thread-2 (should succeed — update)
    const inv2 = registry.create('user-A', 'opus', 'thread-2');
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      payload: {
        invocationId: inv2.invocationId,
        callbackToken: inv2.callbackToken,
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
      },
    });
    assert.equal(res.statusCode, 200);

    const entry = prTrackingStore.get('zts212653/cat-cafe', 42);
    assert.equal(entry.threadId, 'thread-2', 'same user can update their own registration');
  });

  test('POST register-pr-tracking returns 503 when store not configured', async () => {
    // Default createApp() has no prTrackingStore
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      payload: {
        invocationId,
        callbackToken,
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 1,
        catId: 'opus',
      },
    });

    assert.equal(response.statusCode, 503);
    const body = JSON.parse(response.body);
    assert.ok(body.error.includes('not configured'));
  });

  test('POST register-pr-tracking uses invocation catId, not payload catId (authority bug)', async () => {
    const { MemoryPrTrackingStore } = await import('../dist/infrastructure/email/PrTrackingStore.js');
    const prTrackingStore = new MemoryPrTrackingStore();

    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
      prTrackingStore,
    });

    // Invocation is for opencode, but payload says opus
    const { invocationId, callbackToken } = registry.create('user-1', 'opencode', 'thread-opencode');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      payload: {
        invocationId,
        callbackToken,
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 832,
        catId: 'opus', // ← LLM passed wrong catId
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);

    // Server must use the authoritative catId from invocation record, not the payload
    assert.equal(body.entry.catId, 'opencode', 'must use invocation catId, not payload catId');

    const stored = prTrackingStore.get('zts212653/cat-cafe', 832);
    assert.equal(stored.catId, 'opencode', 'stored entry must have authoritative catId');
  });

  // ---- F052: cross-thread identity isolation ----

  test('F052: cross-thread post stores extra.crossPost metadata', async () => {
    const app = await createApp();
    const sourceThread = await threadStore.create('user-1', 'Source Thread');
    const targetThread = await threadStore.create('user-1', 'Target Thread');

    const { invocationId, callbackToken } = registry.create('user-1', 'codex', sourceThread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'Hello from source thread',
        threadId: targetThread.id,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.threadId, targetThread.id);

    const msgs = messageStore.getByThread(targetThread.id, 10, 'user-1');
    const crossMsg = msgs.find((m) => m.content === 'Hello from source thread');
    assert.ok(crossMsg, 'cross-thread message should be stored');
    assert.ok(crossMsg.extra?.crossPost, 'should have crossPost metadata');
    assert.strictEqual(crossMsg.extra.crossPost.sourceThreadId, sourceThread.id);
    assert.strictEqual(crossMsg.extra.crossPost.sourceInvocationId, invocationId);
  });

  test('F052: same-thread post does NOT add crossPost metadata', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'Same Thread');

    const { invocationId, callbackToken } = registry.create('user-1', 'codex', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId,
        callbackToken,
        content: 'Hello same thread',
        threadId: thread.id,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const msgs = messageStore.getByThread(thread.id, 10, 'user-1');
    const msg = msgs.find((m) => m.content === 'Hello same thread');
    assert.ok(msg);
    assert.strictEqual(msg.extra?.crossPost, undefined, 'same-thread should NOT have crossPost');
  });
});
