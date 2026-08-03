/**
 * ADR-008 S7: Edit → Branch Tests
 *
 * POST /api/threads/:id/branch — create conversation branch from a message.
 * Edit semantics: messages up to fromMessageId are copied; last one gets editedContent.
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

function createMockThreadStore() {
  const threads = {};
  let seq = 0;
  return {
    create(userId, title, projectPath) {
      const id = `thread-branch-${++seq}`;
      const thread = {
        id,
        projectPath: projectPath ?? 'default',
        title: title ?? null,
        createdBy: userId,
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      };
      threads[id] = thread;
      return thread;
    },
    get(id) {
      return threads[id] ?? null;
    },
    addParticipants(threadId, catIds) {
      const thread = threads[threadId];
      if (thread) {
        for (const catId of catIds) {
          if (!thread.participants.includes(catId)) {
            thread.participants.push(catId);
          }
        }
      }
    },
    list: () => Object.values(threads),
    listByProject: () => [],
    getParticipants: (id) => threads[id]?.participants ?? [],
    updateTitle: () => {},
    updateLastActive: () => {},
    delete: (id) => {
      const existed = !!threads[id];
      delete threads[id];
      return existed;
    },
    _threads: threads,
    _seedThread(id, data) {
      threads[id] = {
        id,
        projectPath: data.projectPath ?? 'default',
        title: data.title ?? null,
        createdBy: data.createdBy ?? 'user-1',
        participants: data.participants ?? [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      };
    },
  };
}

function seedThread(messageStore, threadStore) {
  threadStore._seedThread('thread-orig', {
    title: '原始对话',
    createdBy: 'user-1',
    participants: ['opus', 'codex'],
    projectPath: '/projects/test',
  });

  const msgs = [];
  msgs.push(
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '你好',
      mentions: ['opus'],
      timestamp: 1000,
      threadId: 'thread-orig',
    }),
  );
  msgs.push(
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '你好！有什么可以帮你？',
      mentions: [],
      timestamp: 1001,
      threadId: 'thread-orig',
    }),
  );
  msgs.push(
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '帮我写个登录页',
      mentions: ['opus'],
      timestamp: 1002,
      threadId: 'thread-orig',
    }),
  );
  msgs.push(
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '好的，已创建登录页...',
      mentions: [],
      timestamp: 1003,
      threadId: 'thread-orig',
    }),
  );
  return msgs;
}

async function setupApp(messageStore, threadStore) {
  const socketManager = createMockSocketManager();
  const app = Fastify();
  await app.register(threadBranchRoutes, { messageStore, threadStore, socketManager });
  await app.ready();
  return { app, socketManager };
}

async function waitFor(predicate, timeoutMs = 500, intervalMs = 10) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe('POST /api/threads/:id/branch (ADR-008 D4 / S7)', () => {
  it('creates branch with all messages up to fromMessageId', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const msgs = seedThread(messageStore, threadStore);
    const { app } = await setupApp(messageStore, threadStore);

    // Branch from msg[2] (3rd message) — should copy msgs 0-2
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: msgs[2].id, userId: 'user-1' },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.threadId);
    assert.equal(body.messageCount, 3);
    assert.equal(body.title, '原始对话 (分支)');

    // Verify new thread has copied messages
    const branchMsgs = messageStore.getByThread(body.threadId, 100);
    assert.equal(branchMsgs.length, 3);
    assert.equal(branchMsgs[0].content, '你好');
    assert.equal(branchMsgs[1].content, '你好！有什么可以帮你？');
    assert.equal(branchMsgs[2].content, '帮我写个登录页');

    // Verify original thread is unchanged
    const origMsgs = messageStore.getByThread('thread-orig', 100);
    assert.equal(origMsgs.length, 4);

    await app.close();
  });

  it('can branch from queued cat-authored speech already published to the timeline', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    seedThread(messageStore, threadStore);
    const seed = messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'published source-cat seed',
      mentions: ['opus'],
      timestamp: 1004,
      threadId: 'thread-orig',
      deliveryStatus: 'queued',
    });
    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: seed.id, userId: 'user-1' },
    });

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.messageCount, 5);
    assert.equal(messageStore.getByThread(body.threadId, 100).at(-1).content, 'published source-cat seed');
    await app.close();
  });

  it('replaces last message content when editedContent is provided', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const msgs = seedThread(messageStore, threadStore);
    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: {
        fromMessageId: msgs[2].id,
        editedContent: '帮我写个注册页',
        userId: 'user-1',
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();

    const branchMsgs = messageStore.getByThread(body.threadId, 100);
    assert.equal(branchMsgs.length, 3);
    assert.equal(branchMsgs[2].content, '帮我写个注册页'); // edited

    await app.close();
  });

  it('copies participants from source thread', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const msgs = seedThread(messageStore, threadStore);
    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: msgs[0].id, userId: 'user-1' },
    });

    const body = res.json();
    const newThread = threadStore.get(body.threadId);
    assert.ok(newThread);
    assert.deepEqual(newThread.participants.sort(), ['codex', 'opus']);

    await app.close();
  });

  it('broadcasts thread_branched event', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const msgs = seedThread(messageStore, threadStore);
    const { app, socketManager } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: msgs[1].id, userId: 'user-1' },
    });

    const body = res.json();
    const events = socketManager.getEvents();
    const branchEvent = events.find((e) => e.event === 'thread_branched');
    assert.ok(branchEvent);
    assert.equal(branchEvent.data.sourceThreadId, 'thread-orig');
    assert.equal(branchEvent.data.newThreadId, body.threadId);

    await app.close();
  });

  it('returns 404 for nonexistent source thread', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/nonexistent/branch',
      payload: { fromMessageId: 'msg-1', userId: 'user-1' },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'THREAD_NOT_FOUND');

    await app.close();
  });

  it('returns 400 for invalid fromMessageId', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    seedThread(messageStore, threadStore);
    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: 'nonexistent-msg', userId: 'user-1' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_FROM_MESSAGE');

    await app.close();
  });

  it('returns 400 when fromMessage belongs to different thread', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    seedThread(messageStore, threadStore);

    // Create a message in a different thread
    const otherMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'other thread',
      mentions: [],
      timestamp: 2000,
      threadId: 'other-thread',
    });

    threadStore._seedThread('other-thread', { title: 'Other' });
    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: otherMsg.id, userId: 'user-1' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_FROM_MESSAGE');

    await app.close();
  });

  it('cannot branch from soft-deleted message', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const msgs = seedThread(messageStore, threadStore);
    const { app } = await setupApp(messageStore, threadStore);

    // Soft delete the target message
    messageStore.softDelete(msgs[2].id, 'user-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: msgs[2].id, userId: 'user-1' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'FROM_MESSAGE_DELETED');

    await app.close();
  });

  it('branch from first message copies only 1 message', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const msgs = seedThread(messageStore, threadStore);
    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: msgs[0].id, userId: 'user-1' },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.messageCount, 1);

    const branchMsgs = messageStore.getByThread(body.threadId, 100);
    assert.equal(branchMsgs.length, 1);
    assert.equal(branchMsgs[0].content, '你好');

    await app.close();
  });

  it('rejects branch by non-creator → 403', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const msgs = seedThread(messageStore, threadStore);
    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: msgs[0].id, userId: 'intruder' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'UNAUTHORIZED');

    await app.close();
  });

  it('rolls back branch when addParticipants fails', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const msgs = seedThread(messageStore, threadStore);

    // Sabotage addParticipants to throw
    threadStore.addParticipants = () => {
      throw new Error('Simulated addParticipants failure');
    };

    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: msgs[0].id, userId: 'user-1' },
    });

    assert.equal(res.statusCode, 500);
    assert.equal(res.json().code, 'BRANCH_FAILED');

    // Verify branch thread was cleaned up
    const allThreads = threadStore.list();
    const branchThreads = allThreads.filter((t) => t.id !== 'thread-orig');
    assert.equal(branchThreads.length, 0, 'Branch thread should be cleaned up after addParticipants failure');

    await app.close();
  });

  it('rolls back partial branch on append failure', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    const msgs = seedThread(messageStore, threadStore);

    // Sabotage append to fail on the 3rd call
    let appendCount = 0;
    const origAppend = messageStore.append.bind(messageStore);
    messageStore.append = (data) => {
      appendCount++;
      if (appendCount === 3) throw new Error('Simulated append failure');
      return origAppend(data);
    };

    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-orig/branch',
      payload: { fromMessageId: msgs[3].id, userId: 'user-1' },
    });

    assert.equal(res.statusCode, 500);
    assert.equal(res.json().code, 'BRANCH_FAILED');

    // Verify the partial branch thread was cleaned up
    const allThreads = threadStore.list();
    const branchThreads = allThreads.filter((t) => t.id !== 'thread-orig');
    assert.equal(branchThreads.length, 0, 'Branch thread should be cleaned up');

    await app.close();
  });

  it('reconciles orphan branch in background when rollback cleanup fails once', async () => {
    process.env.CAT_BRANCH_ROLLBACK_RETRY_DELAYS_MS = '0';
    try {
      const messageStore = new MessageStore();
      const threadStore = createMockThreadStore();
      const msgs = seedThread(messageStore, threadStore);

      let appendCount = 0;
      const origAppend = messageStore.append.bind(messageStore);
      messageStore.append = (data) => {
        appendCount++;
        if (appendCount === 2) throw new Error('Simulated append failure');
        return origAppend(data);
      };

      let deleteMessagesAttempts = 0;
      const origDeleteByThread = messageStore.deleteByThread.bind(messageStore);
      messageStore.deleteByThread = (threadId) => {
        deleteMessagesAttempts++;
        if (deleteMessagesAttempts === 1) {
          throw new Error('Simulated deleteByThread transient failure');
        }
        return origDeleteByThread(threadId);
      };

      let deleteThreadAttempts = 0;
      const origDeleteThread = threadStore.delete.bind(threadStore);
      threadStore.delete = (threadId) => {
        deleteThreadAttempts++;
        if (deleteThreadAttempts === 1) {
          throw new Error('Simulated thread delete transient failure');
        }
        return origDeleteThread(threadId);
      };

      const { app } = await setupApp(messageStore, threadStore);

      const res = await app.inject({
        method: 'POST',
        url: '/api/threads/thread-orig/branch',
        payload: { fromMessageId: msgs[3].id, userId: 'user-1' },
      });

      assert.equal(res.statusCode, 500);
      assert.equal(res.json().code, 'BRANCH_FAILED');

      const hasOnlySourceThread = () => threadStore.list().every((thread) => thread.id === 'thread-orig');
      const cleaned = await waitFor(hasOnlySourceThread, 400, 10);

      assert.equal(cleaned, true, 'Background reconciliation should eventually clean orphan branch');
      assert.ok(deleteMessagesAttempts >= 2, 'deleteByThread should be retried');
      assert.ok(deleteThreadAttempts >= 2, 'thread delete should be retried');

      await app.close();
    } finally {
      delete process.env.CAT_BRANCH_ROLLBACK_RETRY_DELAYS_MS;
    }
  });

  it('uses default title for untitled thread branch', async () => {
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();
    threadStore._seedThread('thread-notitle', {
      title: null,
      createdBy: 'user-1',
    });
    const msg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'hi',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-notitle',
    });

    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-notitle/branch',
      payload: { fromMessageId: msg.id, userId: 'user-1' },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.json().title, '分支对话');

    await app.close();
  });

  it('preserves origin field when copying messages to branch (play-mode isolation)', async () => {
    // Regression (砚砚 R10): branch copy dropped origin, making stream messages
    // appear as legacy untagged in the new thread — bypassing play-mode isolation.
    const messageStore = new MessageStore();
    const threadStore = createMockThreadStore();

    threadStore._seedThread('thread-origin-test', {
      title: 'Origin test',
      createdBy: 'user-1',
      participants: ['opus', 'codex'],
    });

    // User message (no origin)
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Hello',
      mentions: ['opus'],
      timestamp: 1000,
      threadId: 'thread-origin-test',
    });
    // Opus stream message (origin: 'stream' — should be hidden in play mode)
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'thinking...',
      mentions: [],
      origin: 'stream',
      timestamp: 1001,
      threadId: 'thread-origin-test',
    });
    // Codex callback message (origin: 'callback' — should be visible)
    const m3 = messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'result',
      mentions: [],
      origin: 'callback',
      timestamp: 1002,
      threadId: 'thread-origin-test',
    });

    const { app } = await setupApp(messageStore, threadStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-origin-test/branch',
      payload: { fromMessageId: m3.id, userId: 'user-1' },
    });

    assert.equal(res.statusCode, 201);
    const newThreadId = res.json().threadId;

    // Check copied messages in the new thread
    const copied = messageStore.getByThread(newThreadId);
    assert.equal(copied.length, 3, 'all 3 messages should be copied');

    // Verify origin is preserved
    const copiedStream = copied.find((m) => m.content === 'thinking...');
    assert.equal(copiedStream.origin, 'stream', 'stream origin must be preserved in branch');

    const copiedCallback = copied.find((m) => m.content === 'result');
    assert.equal(copiedCallback.origin, 'callback', 'callback origin must be preserved in branch');

    const copiedUser = copied.find((m) => m.content === 'Hello');
    assert.equal(copiedUser.origin, undefined, 'user message has no origin');

    await app.close();
  });
});
