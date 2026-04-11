/**
 * F072: POST /api/threads/read/mark-all endpoint tests
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('POST /api/threads/read/mark-all', () => {
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
      url: '/api/threads/read/mark-all',
    });
    assert.equal(res.statusCode, 401);
  });

  it('acks all threads with messages to latest message', async () => {
    threadStore.create('alice', 'Thread A');
    threadStore.create('alice', 'Thread B');
    const threads = threadStore.list('alice');

    // Add messages to each thread
    for (const t of threads) {
      messageStore.append({
        userId: 'alice',
        catId: 'opus',
        content: `msg1 in ${t.id}`,
        mentions: [],
        timestamp: 1000,
        threadId: t.id,
      });
      messageStore.append({
        userId: 'alice',
        catId: 'opus',
        content: `msg2 in ${t.id}`,
        mentions: [],
        timestamp: 2000,
        threadId: t.id,
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/read/mark-all',
      headers: { 'x-cat-cafe-user': 'alice' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // Should have advanced cursors for threads that had messages
    assert.ok(body.advancedCount >= 2, `advancedCount=${body.advancedCount} should be >= 2`);
  });

  it('is idempotent — second call advances 0', async () => {
    const t = threadStore.create('alice', 'Thread X');
    messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: 1000,
      threadId: t.id,
    });

    // First call
    await app.inject({ method: 'POST', url: '/api/threads/read/mark-all', headers: { 'x-cat-cafe-user': 'alice' } });

    // Second call — should be no-op
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/read/mark-all',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.advancedCount, 0);
  });

  it('skips threads with no messages', async () => {
    threadStore.create('alice', 'Empty Thread');

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/read/mark-all',
      headers: { 'x-cat-cafe-user': 'alice' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.advancedCount, 0);
  });

  it('returns 501 when readStateStore is not available', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    const noReadApp = Fastify();
    await noReadApp.register(threadsRoutes, { threadStore: new ThreadStore() });
    await noReadApp.ready();

    const res = await noReadApp.inject({
      method: 'POST',
      url: '/api/threads/read/mark-all',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(res.statusCode, 501);
    await noReadApp.close();
  });
});
