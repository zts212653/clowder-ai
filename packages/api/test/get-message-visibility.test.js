/**
 * #699 P1-1: get-message route must enforce visibility/permission checks
 * RED → GREEN: tests that the target message returned by GET /api/callbacks/get-message
 * is filtered by canViewMessage, userId scope, and delivery status.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    getMessages() {
      return [];
    },
  };
}

describe('GET /api/callbacks/get-message visibility', () => {
  let registry;
  let messageStore;
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
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: createMockSocketManager(),
      threadStore,
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: {
        submit: async (m) => ({ id: 'mk-1', createdAt: new Date().toISOString(), ...m }),
        list: async () => [],
        transition: async () => {},
      },
    });
    return app;
  }

  test('returns 404 for whisper message not visible to calling cat (play mode)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // Play mode thread — whisper filtering enforced for cats
    const thread = threadStore.create('user-1', 'whisper test');
    threadStore.updateThinkingMode(thread.id, 'play');

    // Create a whisper visible only to 'codex', not 'opus'
    const whisperMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'secret whisper',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      visibility: 'whisper',
      whisperTo: ['codex'],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${whisperMsg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 404, 'whisper not addressed to caller should be 404 in play mode');
  });

  test('returns whisper in debug mode (full transparency)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // Debug mode (default) — cats see everything like the user
    const whisperMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'whisper for codex',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-debug',
      visibility: 'whisper',
      whisperTo: ['codex'],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${whisperMsg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 200, 'whisper should be visible in debug mode (full transparency)');
  });

  test('returns 404 for message belonging to different userId', async () => {
    const app = await createApp();
    // Invocation for user-1
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // Message belongs to user-2
    const otherUserMsg = messageStore.append({
      userId: 'user-2',
      catId: null,
      content: 'other user message',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-other',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${otherUserMsg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 404, 'message from different user scope should be 404');
  });

  test('returns message when caller has permission', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    const msg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'hello opus',
      mentions: ['opus'],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${msg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.message.id, msg.id);
    assert.equal(body.message.content, 'hello opus');
  });

  test('returns whisper when caller is in whisperTo', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    const whisperMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'whisper for opus',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${whisperMsg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.message.id, whisperMsg.id);
  });

  test('context excludes whispers not visible to calling cat (play mode)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // Play mode thread — whisper filtering enforced
    const thread = threadStore.create('user-1', 'ctx whisper test');
    threadStore.updateThinkingMode(thread.id, 'play');

    // Public message (the target)
    const target = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'public target',
      mentions: [],
      timestamp: 2000,
      threadId: thread.id,
    });

    // Whisper before target — addressed to codex, NOT opus
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'secret for codex only',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      visibility: 'whisper',
      whisperTo: ['codex'],
    });

    // Public message after target — should appear in context
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'public after',
      mentions: [],
      timestamp: 3000,
      threadId: thread.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${target.id}&contextCount=5`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.context, 'context should be present');
    const contextContents = body.context.map((m) => m.content);
    assert.ok(!contextContents.includes('secret for codex only'), 'whisper for other cat must not appear in context');
    assert.ok(contextContents.includes('public after'), 'public messages should appear in context');
  });

  test('returns 404 for other cat stream message in play-mode thread', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // Create a play-mode thread
    const thread = threadStore.create('user-1', 'play thread');
    threadStore.updateThinkingMode(thread.id, 'play');

    // codex's stream message in that thread
    const streamMsg = messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'codex stream thinking',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      origin: 'stream',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${streamMsg.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 404, 'other cat stream message in play mode should be 404');
  });

  test('returns own stream message in play-mode thread', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    const thread = threadStore.create('user-1', 'play thread');
    threadStore.updateThinkingMode(thread.id, 'play');

    // opus's own stream message
    const ownStream = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'opus stream thinking',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      origin: 'stream',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${ownStream.id}`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 200, 'own stream message should be visible');
  });

  test('context excludes other cat stream messages in play-mode thread', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    const thread = threadStore.create('user-1', 'play thread');
    threadStore.updateThinkingMode(thread.id, 'play');

    // Target: user message (visible)
    const target = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'user question',
      mentions: [],
      timestamp: 2000,
      threadId: thread.id,
    });

    // codex stream in same thread — should be hidden from opus
    messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'codex secret stream',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      origin: 'stream',
    });

    // opus's own stream — should be visible
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'opus own stream',
      mentions: [],
      timestamp: 3000,
      threadId: thread.id,
      origin: 'stream',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${target.id}&contextCount=5`,
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.context, 'context should be present');
    const contextContents = body.context.map((m) => m.content);
    assert.ok(!contextContents.includes('codex secret stream'), 'other cat stream must be hidden in play mode');
    assert.ok(contextContents.includes('opus own stream'), 'own stream should be visible');
  });
});
