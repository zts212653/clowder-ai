/**
 * ADR-008 S5: Soft Delete Tests
 *
 * Tests for softDelete/restore on MessageStore + API endpoints.
 * Cursor path (getByThreadAfter) must NOT filter deleted messages.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messageActionsRoutes } from '../dist/routes/message-actions.js';

function createMockSocketManager() {
  const events = [];
  return {
    broadcastAgentMessage() {},
    broadcastToRoom(room, event, data) {
      events.push({ room, event, data });
    },
    getEvents() {
      return events;
    },
  };
}

function seedMessages(store) {
  const msgs = [];
  for (let i = 0; i < 5; i++) {
    msgs.push(
      store.append({
        userId: 'user-1',
        catId: null,
        content: `message ${i}`,
        mentions: ['opus'],
        timestamp: 1000 + i,
        threadId: 'thread-sd',
      }),
    );
  }
  return msgs;
}

// --- Unit: MessageStore softDelete/restore ---

describe('MessageStore.softDelete()', () => {
  it('marks message as deleted', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    const result = store.softDelete(msgs[2].id, 'user-1');
    assert.ok(result);
    assert.equal(result.id, msgs[2].id);
    assert.ok(result.deletedAt);
    assert.equal(result.deletedBy, 'user-1');
  });

  it('returns null for nonexistent id', () => {
    const store = new MessageStore();
    const result = store.softDelete('nonexistent', 'user-1');
    assert.equal(result, null);
  });
});

describe('MessageStore.restore()', () => {
  it('restores a soft-deleted message', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.softDelete(msgs[1].id, 'user-1');
    const restored = store.restore(msgs[1].id);
    assert.ok(restored);
    assert.equal(restored.deletedAt, undefined);
    assert.equal(restored.deletedBy, undefined);
  });

  it('returns null for non-deleted message', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);
    const result = store.restore(msgs[0].id);
    assert.equal(result, null);
  });

  it('returns null for nonexistent id', () => {
    const store = new MessageStore();
    const result = store.restore('nonexistent');
    assert.equal(result, null);
  });
});

// --- Unit: Read path filtering ---

describe('Read path filtering (skip soft-deleted)', () => {
  it('getByThread skips deleted messages', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.softDelete(msgs[1].id, 'user-1');
    store.softDelete(msgs[3].id, 'user-1');

    const result = store.getByThread('thread-sd');
    assert.equal(result.length, 3);
    const ids = result.map((m) => m.id);
    assert.ok(!ids.includes(msgs[1].id));
    assert.ok(!ids.includes(msgs[3].id));
  });

  it('getRecent skips deleted messages', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.softDelete(msgs[4].id, 'user-1');

    const result = store.getRecent(10);
    assert.equal(result.length, 4);
    assert.ok(!result.some((m) => m.id === msgs[4].id));
  });

  it('getMentionsFor skips deleted messages', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.softDelete(msgs[0].id, 'user-1');

    const result = store.getMentionsFor('opus');
    assert.equal(result.length, 4);
    assert.ok(!result.some((m) => m.id === msgs[0].id));
  });

  it('getBefore skips deleted messages', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.softDelete(msgs[2].id, 'user-1');

    // Get messages before timestamp 1005 (all 5), should return 4 (minus deleted)
    const result = store.getBefore(1005);
    assert.equal(result.length, 4);
    assert.ok(!result.some((m) => m.id === msgs[2].id));
  });

  it('getByThreadBefore skips deleted messages', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.softDelete(msgs[1].id, 'user-1');

    const result = store.getByThreadBefore('thread-sd', 1005);
    assert.equal(result.length, 4);
    assert.ok(!result.some((m) => m.id === msgs[1].id));
  });

  // #1200 Sol R2 P2-5: getByThreadAfter KEEPS deleted messages (tombstone-keep per binding doc).
  // Parity direction: both Memory and Redis keep tombstones in cursor pagination.
  it('getByThreadAfter does NOT skip deleted (cursor path)', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.softDelete(msgs[2].id, 'user-1');

    // After msg[0], should return msgs 1-4 including deleted msg[2]
    const result = store.getByThreadAfter('thread-sd', msgs[0].id);
    assert.equal(result.length, 4);
    assert.ok(result.some((m) => m.id === msgs[2].id));
  });

  it('getById still returns deleted messages', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.softDelete(msgs[0].id, 'user-1');

    const found = store.getById(msgs[0].id);
    assert.ok(found);
    assert.ok(found.deletedAt);
  });
});

// --- Integration: API endpoints ---

describe('DELETE /api/messages/:id (soft delete)', () => {
  it('soft deletes a message and returns 200', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${msgs[2].id}`,
      payload: { userId: 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.id, msgs[2].id);
    assert.ok(body.deletedAt);
    assert.equal(body.deletedBy, 'user-1');

    // Verify message is now filtered from getByThread
    const remaining = messageStore.getByThread('thread-sd');
    assert.equal(remaining.length, 4);

    // Verify WebSocket broadcast
    const events = socketManager.getEvents();
    assert.ok(events.some((e) => e.event === 'message_deleted' && e.data.messageId === msgs[2].id));

    await app.close();
  });

  it('returns 404 for nonexistent message', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/messages/nonexistent-id',
      payload: { userId: 'user-1' },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'MESSAGE_NOT_FOUND');

    await app.close();
  });
});

describe('PATCH /api/messages/:id/restore', () => {
  it('restores a soft-deleted message', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);

    messageStore.softDelete(msgs[1].id, 'user-1');

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager });
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msgs[1].id}/restore`,
      payload: { userId: 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.id, msgs[1].id);
    assert.ok(body.content);

    // Verify message is back in getByThread
    const all = messageStore.getByThread('thread-sd');
    assert.equal(all.length, 5);

    // Verify WebSocket broadcast
    const events = socketManager.getEvents();
    assert.ok(events.some((e) => e.event === 'message_restored'));

    await app.close();
  });

  it('returns 404 for non-deleted message', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager });
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msgs[0].id}/restore`,
      payload: { userId: 'user-1' },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'MESSAGE_NOT_RESTORABLE');

    await app.close();
  });
});

// --- S6: Hard Delete (tombstone) ---

describe('MessageStore.hardDelete()', () => {
  it('wipes content and sets tombstone', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    const result = store.hardDelete(msgs[2].id, 'user-1');
    assert.ok(result);
    assert.equal(result.content, '');
    assert.deepEqual(result.mentions, []);
    assert.equal(result.contentBlocks, undefined);
    assert.equal(result.metadata, undefined);
    assert.ok(result.deletedAt);
    assert.equal(result.deletedBy, 'user-1');
    assert.equal(result._tombstone, true);
  });

  it('returns null for nonexistent id', () => {
    const store = new MessageStore();
    const result = store.hardDelete('nonexistent', 'user-1');
    assert.equal(result, null);
  });

  it('tombstone is filtered from getByThread', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.hardDelete(msgs[3].id, 'user-1');
    const result = store.getByThread('thread-sd');
    assert.equal(result.length, 4);
    assert.ok(!result.some((m) => m.id === msgs[3].id));
  });

  // #1200 Sol R2 P2-5: tombstones are KEPT in getByThreadAfter per binding doc.
  // Both Memory and Redis preserve tombstones for cursor pagination parity.
  it('tombstone is visible in getByThreadAfter (cursor path)', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.hardDelete(msgs[2].id, 'user-1');
    const result = store.getByThreadAfter('thread-sd', msgs[0].id);
    assert.equal(result.length, 4);
    const tombstone = result.find((m) => m.id === msgs[2].id);
    assert.ok(tombstone);
    assert.equal(tombstone._tombstone, true);
  });

  it('restore rejects tombstone', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    store.hardDelete(msgs[1].id, 'user-1');
    const result = store.restore(msgs[1].id);
    assert.equal(result, null);
  });
});

describe('DELETE /api/messages/:id mode=hard', () => {
  it('hard deletes with valid confirmTitle', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);

    const threadStore = {
      async get(id) {
        if (id === 'thread-sd')
          return {
            id,
            title: 'Test Thread',
            createdBy: 'user-1',
            participants: [],
            lastActiveAt: Date.now(),
            createdAt: Date.now(),
          };
        return null;
      },
    };

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager, threadStore });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${msgs[2].id}`,
      payload: { userId: 'user-1', mode: 'hard', confirmTitle: 'Test Thread' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body._tombstone, true);
    assert.ok(body.deletedAt);

    // Verify filtered from read path
    const remaining = messageStore.getByThread('thread-sd');
    assert.equal(remaining.length, 4);

    // Verify WebSocket broadcast
    const events = socketManager.getEvents();
    assert.ok(events.some((e) => e.event === 'message_hard_deleted'));

    await app.close();
  });

  it('rejects hard delete without confirmTitle', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${msgs[0].id}`,
      payload: { userId: 'user-1', mode: 'hard' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'CONFIRM_TITLE_REQUIRED');

    await app.close();
  });

  it('rejects hard delete with wrong confirmTitle', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);

    const threadStore = {
      async get(id) {
        if (id === 'thread-sd')
          return {
            id,
            title: 'Real Title',
            createdBy: 'user-1',
            participants: [],
            lastActiveAt: Date.now(),
            createdAt: Date.now(),
          };
        return null;
      },
    };

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager, threadStore });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${msgs[0].id}`,
      payload: { userId: 'user-1', mode: 'hard', confirmTitle: 'Wrong Title' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'CONFIRM_TITLE_MISMATCH');

    await app.close();
  });

  it('restore rejects tombstone via API', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);

    messageStore.hardDelete(msgs[0].id, 'user-1');

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager });
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msgs[0].id}/restore`,
      payload: { userId: 'user-1' },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'MESSAGE_NOT_RESTORABLE');

    await app.close();
  });
});

// --- R2 fix: Authorization checks ---

function createMockThreadStore(threads = {}) {
  return {
    async get(id) {
      return threads[id] ?? null;
    },
    create() {
      return null;
    },
    list() {
      return [];
    },
    listByProject() {
      return [];
    },
    addParticipants() {},
    getParticipants() {
      return [];
    },
    updateTitle() {},
    updateLastActive() {},
    delete() {
      return true;
    },
  };
}

describe('Authorization: DELETE /api/messages/:id', () => {
  it('rejects soft delete by non-owner non-creator → 403', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore); // userId: 'user-1'
    const threadStore = createMockThreadStore({
      'thread-sd': { id: 'thread-sd', title: 'T', createdBy: 'user-1', participants: [] },
    });

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager, threadStore });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${msgs[0].id}`,
      payload: { userId: 'intruder' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'UNAUTHORIZED');
    await app.close();
  });

  it('thread creator can delete another user message', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    // Add a message from a different user
    const catMsg = messageStore.append({
      userId: 'cat-opus',
      catId: 'opus',
      content: 'cat reply',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-sd',
    });
    const threadStore = createMockThreadStore({
      'thread-sd': { id: 'thread-sd', title: 'T', createdBy: 'user-1', participants: [] },
    });

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager, threadStore });
    await app.ready();

    // user-1 is thread creator, deleting cat-opus's message
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${catMsg.id}`,
      payload: { userId: 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().deletedBy, 'user-1');
    await app.close();
  });

  it('rejects hard delete by non-owner → 403', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);
    const threadStore = createMockThreadStore({
      'thread-sd': { id: 'thread-sd', title: 'T', createdBy: 'user-1', participants: [] },
    });

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager, threadStore });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${msgs[0].id}`,
      payload: { userId: 'intruder', mode: 'hard', confirmTitle: 'T' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'UNAUTHORIZED');
    await app.close();
  });
});

describe('Authorization: PATCH /api/messages/:id/restore', () => {
  it('rejects restore by non-deleter non-creator → 403', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);
    messageStore.softDelete(msgs[0].id, 'user-1');
    const threadStore = createMockThreadStore({
      'thread-sd': { id: 'thread-sd', title: 'T', createdBy: 'user-1', participants: [] },
    });

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager, threadStore });
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msgs[0].id}/restore`,
      payload: { userId: 'intruder' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'UNAUTHORIZED');
    await app.close();
  });

  it('thread creator can restore message deleted by another', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);
    messageStore.softDelete(msgs[0].id, 'someone-else');
    const threadStore = createMockThreadStore({
      'thread-sd': { id: 'thread-sd', title: 'T', createdBy: 'user-1', participants: [] },
    });

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager, threadStore });
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msgs[0].id}/restore`,
      payload: { userId: 'user-1' }, // thread creator
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.json().content);
    await app.close();
  });
});

describe('Hard delete: untitled thread confirmation', () => {
  it('rejects hard delete on untitled thread with wrong confirmTitle', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);
    const threadStore = createMockThreadStore({
      'thread-sd': { id: 'thread-sd', title: null, createdBy: 'user-1', participants: [] },
    });

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager, threadStore });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${msgs[0].id}`,
      payload: { userId: 'user-1', mode: 'hard', confirmTitle: 'anything' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'CONFIRM_TITLE_MISMATCH');
    await app.close();
  });

  it('accepts hard delete on untitled thread with "确认删除"', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const msgs = seedMessages(messageStore);
    const threadStore = createMockThreadStore({
      'thread-sd': { id: 'thread-sd', title: null, createdBy: 'user-1', participants: [] },
    });

    const app = Fastify();
    await app.register(messageActionsRoutes, { messageStore, socketManager, threadStore });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${msgs[0].id}`,
      payload: { userId: 'user-1', mode: 'hard', confirmTitle: '确认删除' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json()._tombstone, true);
    await app.close();
  });
});

// --- Edge case: delete + restore round-trip ---

describe('Soft delete round-trip', () => {
  it('delete → filtered → restore → visible again', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    // Initially 5 visible
    assert.equal(store.getByThread('thread-sd').length, 5);

    // Delete
    store.softDelete(msgs[2].id, 'user-1');
    assert.equal(store.getByThread('thread-sd').length, 4);

    // Restore
    store.restore(msgs[2].id);
    assert.equal(store.getByThread('thread-sd').length, 5);
  });

  it('double softDelete is idempotent', () => {
    const store = new MessageStore();
    const msgs = seedMessages(store);

    const first = store.softDelete(msgs[0].id, 'user-1');
    const second = store.softDelete(msgs[0].id, 'user-2');

    assert.ok(first);
    assert.ok(second);
    // Second delete overwrites deletedBy (latest wins)
    assert.equal(second.deletedBy, 'user-2');
  });
});
