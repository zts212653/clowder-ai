/**
 * F109 Phase A — Task 4: Branch permission for system-created threads
 *
 * Bug: thread-branch.ts:130 rejects all non-owner, including system threads.
 * Fix: createdBy === userId || createdBy === 'system'
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { threadBranchRoutes } from '../dist/routes/thread-branch.js';

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

function createMockThreadStore(threads = {}) {
  let nextId = 100;
  return {
    async get(id) {
      return threads[id] ?? null;
    },
    async create(userId, title, projectPath) {
      const id = `branch-${++nextId}`;
      return {
        id,
        title,
        createdBy: userId,
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
        projectPath,
      };
    },
    async addParticipants() {},
    async getParticipants() {
      return [];
    },
    async list() {
      return [];
    },
    async listByProject() {
      return [];
    },
    async updateTitle() {},
    async updateLastActive() {},
    async delete() {
      return true;
    },
  };
}

describe('F109: Branch from system-created thread', () => {
  it('allows branching from a system-created thread (createdBy=system)', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();

    // Seed a system-created thread with a message
    const msg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'hello from system thread',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-sys',
    });

    const threadStore = createMockThreadStore({
      'thread-sys': {
        id: 'thread-sys',
        title: 'System Thread',
        createdBy: 'system',
        participants: ['opus'],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      },
    });

    const app = Fastify();
    await app.register(threadBranchRoutes, { threadStore, messageStore, socketManager });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/thread-sys/branch`,
      payload: {
        fromMessageId: msg.id,
        userId: 'user-1',
      },
    });

    // Currently returns 403 — after fix should return 201 (Created)
    assert.equal(res.statusCode, 201, `Expected 201 but got ${res.statusCode}: ${res.body}`);
    const body = res.json();
    assert.ok(body.threadId, 'Should return new thread ID');

    await app.close();
  });

  it('still rejects branching from another user thread', async () => {
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();

    const msg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'message',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-other',
    });

    const threadStore = createMockThreadStore({
      'thread-other': {
        id: 'thread-other',
        title: 'Other Thread',
        createdBy: 'user-other',
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      },
    });

    const app = Fastify();
    await app.register(threadBranchRoutes, { threadStore, messageStore, socketManager });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/thread-other/branch`,
      payload: {
        fromMessageId: msg.id,
        userId: 'user-1',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'UNAUTHORIZED');

    await app.close();
  });
});
