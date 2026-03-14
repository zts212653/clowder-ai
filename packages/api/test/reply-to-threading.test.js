/**
 * F066: replyTo threading regression tests
 * Covers:
 * 1. In-memory MessageStore persists replyTo via append + getById
 * 2. MessageStore without replyTo returns undefined
 * 3. GET /api/messages returns replyTo in response (Fastify plugin)
 * 4. POST /api/callbacks/post-message persists + broadcasts replyTo
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

function createMockSocketManager() {
  const broadcasts = [];
  return {
    broadcastAgentMessage(msg, threadId) {
      broadcasts.push({ msg, threadId });
    },
    getMessages() {
      return [];
    },
    broadcasts,
  };
}

describe('F066 replyTo threading', () => {
  let MessageStore;
  let InvocationRegistry;
  let messageStore;
  let registry;
  let socketManager;

  beforeEach(async () => {
    const msgMod = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    MessageStore = msgMod.MessageStore;
    const regMod = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
    InvocationRegistry = regMod.InvocationRegistry;
    messageStore = new MessageStore();
    registry = new InvocationRegistry();
    socketManager = createMockSocketManager();
  });

  test('1. MessageStore.append persists replyTo and getById returns it', () => {
    const parent = messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'parent message',
      mentions: [],
      timestamp: Date.now(),
    });

    const reply = messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'reply message',
      mentions: [],
      timestamp: Date.now(),
      replyTo: parent.id,
    });

    assert.equal(reply.replyTo, parent.id, 'replyTo should be persisted');
    const fetched = messageStore.getById(reply.id);
    assert.equal(fetched.replyTo, parent.id, 'getById should return replyTo');
  });

  test('2. MessageStore.append without replyTo has no replyTo field', () => {
    const msg = messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'no reply',
      mentions: [],
      timestamp: Date.now(),
    });
    assert.equal(msg.replyTo, undefined, 'replyTo should be undefined when not set');
  });

  test('3. GET /api/messages returns replyTo in response', async () => {
    const app = Fastify();
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    await app.register(messagesRoutes, { messageStore, socketManager });

    const parent = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'parent',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'test-thread',
    });
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'reply',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: 'test-thread',
      replyTo: parent.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=test-thread&limit=10',
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.payload);
    const replyMsg = data.messages.find((m) => m.content === 'reply');
    assert.ok(replyMsg, 'reply message should be in response');
    assert.equal(replyMsg.replyTo, parent.id, 'replyTo should be in API response');

    const parentMsg = data.messages.find((m) => m.content === 'parent');
    assert.equal(parentMsg.replyTo, undefined, 'parent should have no replyTo');
  });

  test('4. POST /api/callbacks/post-message persists + broadcasts replyTo', async () => {
    const app = Fastify();
    const catRegistry = new Map();
    catRegistry.set('opus', { id: 'opus', displayName: 'Opus' });

    const record = registry.create('user1', 'opus', 'test-thread');

    const parent = messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'trigger message',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'test-thread',
    });

    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      catRegistry,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId: record.invocationId,
        callbackToken: record.callbackToken,
        content: 'I am replying',
        replyTo: parent.id,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'ok');

    // Verify stored message has replyTo
    const stored = messageStore.getRecent(50, 'user1');
    const replyMsg = stored.find((m) => m.content === 'I am replying');
    assert.ok(replyMsg, 'reply should be stored');
    assert.equal(replyMsg.replyTo, parent.id, 'replyTo should be persisted via callback');

    // Verify broadcast included replyTo
    const broadcast = socketManager.broadcasts.find((b) => b.msg.content === 'I am replying');
    assert.ok(broadcast, 'broadcast should exist');
    assert.equal(broadcast.msg.replyTo, parent.id, 'broadcast should include replyTo');
  });
});
