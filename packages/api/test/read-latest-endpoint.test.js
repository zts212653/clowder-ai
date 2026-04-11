/**
 * F069-R5: POST /api/threads/:id/read/latest endpoint tests
 * Backend acks to the latest real message in a thread — no frontend ID needed.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('POST /api/threads/:id/read/latest', () => {
  let app;
  let threadStore;
  let messageStore;
  let readStateStore;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    messageStore = new MessageStore();

    // Minimal in-memory read state store
    const cursors = new Map();
    readStateStore = {
      ack: async (userId, threadId, messageId) => {
        const key = `${userId}:${threadId}`;
        const current = cursors.get(key);
        if (current && current >= messageId) return false;
        cursors.set(key, messageId);
        return true;
      },
      get: async (userId, threadId) => {
        const key = `${userId}:${threadId}`;
        const id = cursors.get(key);
        return id ? { userId, threadId, lastReadMessageId: id, updatedAt: Date.now() } : null;
      },
      getUnreadSummaries: async () => [],
      deleteByThread: async () => {},
    };

    app = Fastify();
    await app.register(threadsRoutes, { threadStore, messageStore, readStateStore });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 401 without userId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/some-id/read/latest',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 for non-existent thread', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/nonexistent/read/latest',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns advanced=false when thread has no messages', async () => {
    const thread = threadStore.create('alice', 'Empty Thread');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.advanced, false);
    assert.equal(body.reason, 'no messages');
  });

  it('acks to the latest message in thread', async () => {
    const thread = threadStore.create('alice', 'Thread with messages');

    messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'first',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
    });
    const msg2 = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'second (latest)',
      mentions: [],
      timestamp: 2000,
      threadId: thread.id,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.advanced, true);
    assert.equal(body.messageId, msg2.id);
  });

  it('is idempotent — second call returns advanced=false', async () => {
    const thread = threadStore.create('alice', 'Thread');
    messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
    });

    // First call
    const res1 = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(JSON.parse(res1.body).advanced, true);

    // Second call — cursor already at latest
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(JSON.parse(res2.body).advanced, false);
  });

  it('returns 501 when readStateStore is not available', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    const noReadApp = Fastify();
    const ts = new ThreadStore();
    await noReadApp.register(threadsRoutes, { threadStore: ts, messageStore: new MessageStore() });
    await noReadApp.ready();

    const thread = ts.create('alice', 'Thread');

    const res = await noReadApp.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(res.statusCode, 501);
    await noReadApp.close();
  });

  it('returns 501 when messageStore is not available', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    const noMsgApp = Fastify();
    const ts = new ThreadStore();
    await noMsgApp.register(threadsRoutes, { threadStore: ts, readStateStore });
    await noMsgApp.ready();

    const thread = ts.create('alice', 'Thread');

    const res = await noMsgApp.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(res.statusCode, 501);
    await noMsgApp.close();
  });
});
