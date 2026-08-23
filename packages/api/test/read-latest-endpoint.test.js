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
  let cursors;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    cursors = new Map();
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
    assert.equal(body.caughtUp, true);
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
    assert.equal(body.caughtUp, true);
    assert.equal(body.messageId, msg2.id);
  });

  it("does not advance a foreign viewer through another owner's terminal managed hold", async () => {
    const thread = threadStore.create('system', 'Shared managed-hold thread');
    const anchor = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'alice-visible anchor',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
    });
    const custody = {
      version: 1,
      entryId: 'entry-foreign-managed-hold',
      revision: 1,
      ownerUserId: 'bob',
      intent: 'managed command wake',
      status: 'queued',
      allTargetCats: ['opus5'],
      pendingTargetCats: ['opus5'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: 2000,
      updatedAt: 2000,
    };
    const terminal = messageStore.append({
      userId: 'scheduler',
      catId: null,
      content: 'bob command result',
      mentions: [],
      timestamp: 2000,
      threadId: thread.id,
      deliveryStatus: 'queued',
      queueCustody: custody,
      source: {
        connector: 'hold-ball',
        label: '持球结果',
        icon: '🏓',
        meta: { taskId: 'task-foreign', threadId: thread.id, catId: 'opus5', wakeWhen: true },
      },
    });
    messageStore.transitionQueueCustody(terminal.id, {
      expectedRevision: 1,
      next: {
        ...custody,
        revision: 2,
        status: 'terminal',
        pendingTargetCats: [],
        failedByCatIds: ['opus5'],
        updatedAt: 2100,
      },
      deliveredAt: 2100,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).messageId, anchor.id);
  });

  it('acks a queued cat-authored message already published to the timeline', async () => {
    const thread = threadStore.create('alice', 'Thread with source-cat seed');
    const seed = messageStore.append({
      userId: 'alice',
      catId: 'codex-sol',
      content: 'published source-cat seed',
      mentions: ['opus'],
      timestamp: 1000,
      threadId: thread.id,
      deliveryStatus: 'queued',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });

    assert.equal(res.statusCode, 200);
    // #1200/#1269: timeline-published queued cat speech now gets visibilitySeq
    // at append time, so getLatestVisibleCursor returns a v2 cursor.
    const body = JSON.parse(res.body);
    assert.equal(body.advanced, true);
    assert.equal(body.messageId, seed.id);
    assert.ok(body.cursor.startsWith('v2:'), 'cursor must be v2 (visibilitySeq assigned at append)');
  });

  // #1200 P1 mixed-thread regression: ordinary A + queued cat Q in same thread.
  // getLatestVisibleCursor must return Q (later visibilitySeq), not A.
  it('mixed thread: queued cat speech Q after ordinary A — acks Q as latest', async () => {
    const thread = threadStore.create('alice', 'Mixed: ordinary + queued');
    const a = messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'ordinary message A',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
    });
    const q = messageStore.append({
      userId: 'alice',
      catId: 'codex-sol',
      content: 'queued cat speech Q',
      mentions: ['opus'],
      timestamp: 2000,
      threadId: thread.id,
      deliveryStatus: 'queued',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.advanced, true);
    // Q must be latest (higher visibilitySeq), not A
    assert.equal(body.messageId, q.id, 'latest must be Q, not A');
    assert.ok(body.cursor.startsWith('v2:'), 'cursor must be v2');
  });

  it('does not durably ack a mutable stream until its final delivery transition', async () => {
    const thread = threadStore.create('alice', 'Mutable stream read boundary');
    const earlier = messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'earlier durable speech',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
    });
    const stream = messageStore.append({
      userId: 'alice',
      catId: 'codex-sol',
      content: 'partial stream',
      mentions: [],
      timestamp: 2000,
      threadId: thread.id,
      deliveryStatus: 'queued',
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-d4', turnInvocationId: 'turn-d4' } },
    });

    const partialAck = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(partialAck.statusCode, 200);
    assert.equal(JSON.parse(partialAck.body).messageId, earlier.id);

    const cursorBeforeDelivery = cursors.get(`alice:${thread.id}`);
    await messageStore.markDelivered(stream.id, 3000);
    assert.equal(
      cursors.get(`alice:${thread.id}`),
      cursorBeforeDelivery,
      'delivery alone must not manufacture a read ACK after the user leaves',
    );

    const finalAck = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(finalAck.statusCode, 200);
    assert.equal(JSON.parse(finalAck.body).messageId, stream.id);
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
    const body2 = JSON.parse(res2.body);
    assert.equal(body2.advanced, false);
    assert.equal(body2.caughtUp, true);
  });

  // #1304: caughtUp must be false when cursor is stale (v1 stored, v2 latest).
  // The frontend must NOT clear unread suppression in this case.
  it('returns caughtUp=false when stored cursor does not match latest', async () => {
    const thread = threadStore.create('alice', 'Stale cursor thread');
    messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'visible message',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
    });

    // Simulate a stale cursor that's lex-greater than latest (CAS rejects,
    // stored != latest → caughtUp=false). Using a v2 with seq=9999... which
    // is lex-greater than any real message's visibilitySeq.
    const key = `alice:${thread.id}`;
    cursors.set(key, 'v2:9999999999999999:stale-pruned-msg');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/read/latest`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // CAS rejects (stored seq 9999 > latest seq) → advanced=false
    // Stored != latest.cursor → caughtUp=false (frontend keeps badge)
    assert.equal(body.advanced, false);
    assert.equal(body.caughtUp, false);
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
