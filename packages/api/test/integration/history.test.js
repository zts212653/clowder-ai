/**
 * History endpoint integration test
 * POST → GET roundtrip, pagination, format matching frontend expectations
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('POST → GET /api/messages roundtrip', () => {
  let app;
  let messageStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { messagesRoutes } = await import('../../dist/routes/messages.js');
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

    messageStore = new MessageStore();
    const registry = new InvocationRegistry();
    const socketManager = { broadcastAgentMessage: () => {} };

    app = Fastify();
    await app.register(messagesRoutes, { registry, messageStore, socketManager });
    await app.register(callbacksRoutes, { registry, messageStore, socketManager });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('messages stored via append() are returned by GET', async () => {
    // Simulate what AgentRouter does: store user msg + cat reply
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'hello @opus',
      mentions: ['opus'],
      timestamp: 1000,
    });
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'hello human',
      mentions: [],
      timestamp: 2000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].type, 'user');
    assert.equal(body.messages[0].content, 'hello @opus');
    assert.equal(body.messages[1].type, 'assistant');
    assert.equal(body.messages[1].catId, 'opus');
    assert.equal(body.messages[1].content, 'hello human');
    assert.equal(body.hasMore, false);
  });

  it('cursor pagination returns correct pages', async () => {
    // Insert 5 messages
    for (let i = 0; i < 5; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `msg ${i}`,
        mentions: [],
        timestamp: 1000 + i * 100,
      });
    }

    // First page: latest 2
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=2',
    });
    const body1 = JSON.parse(page1.body);
    assert.equal(body1.messages.length, 2);
    assert.equal(body1.hasMore, true);

    // Second page: before the earliest message of page 1
    const cursor = body1.messages[0].timestamp;
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/messages?limit=2&before=${cursor}`,
    });
    const body2 = JSON.parse(page2.body);
    assert.equal(body2.messages.length, 2);

    // No overlap between pages
    const page1Ids = new Set(body1.messages.map((m) => m.id));
    const page2Ids = body2.messages.map((m) => m.id);
    for (const id of page2Ids) {
      assert.ok(!page1Ids.has(id), `Duplicate message ID ${id} across pages`);
    }
  });

  it('response format matches frontend ChatMessage interface', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'codex',
      content: 'review done',
      mentions: [],
      timestamp: 5000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    const msg = body.messages[0];

    // Frontend ChatMessage expects: id, type, catId?, content, timestamp
    assert.ok(typeof msg.id === 'string', 'id should be string');
    assert.ok(['user', 'assistant'].includes(msg.type), 'type should be user|assistant');
    assert.equal(msg.catId, 'codex');
    assert.equal(msg.content, 'review done');
    assert.ok(typeof msg.timestamp === 'number', 'timestamp should be number');
    assert.ok(typeof body.hasMore === 'boolean', 'hasMore should be boolean');
  });
});
