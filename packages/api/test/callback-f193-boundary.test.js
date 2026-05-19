/**
 * F193 Phase A — AC-A5: KD-1 boundary regression tests.
 *
 * Locks two non-obvious boundaries that future refactors might erode:
 *   1. F052 sourceThreadId metadata is injected when invocation-token caller
 *      cross-posts with routing creds (AC-A4 doesn't strip it).
 *   2. Same-name cat (e.g. opus in source thread cross-posts to thread with
 *      another opus session) is NOT self-filtered — the receiving thread's
 *      same-cat session must be triggerable. analyzeA2AMentions(content,
 *      isCrossThread ? undefined : senderCatId) is the existing exemption;
 *      this test prevents accidental tightening.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
  };
}

function createMockInvocationRecordStore() {
  const records = [];
  return {
    create(input) {
      const id = `inv-${records.length}`;
      records.push({ id, ...input });
      return { outcome: 'created', invocationId: id };
    },
    update() {},
    getRecords() {
      return records;
    },
  };
}

function createMockRouter() {
  return {
    async *routeExecution() {
      yield* [];
    },
    getExecutions() {
      return [];
    },
  };
}

function createMockThreadStore() {
  const threads = new Map();
  return {
    create(userId, title) {
      const thread = {
        id: `thread-${threads.size}`,
        userId,
        createdBy: userId,
        title: title ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      threads.set(thread.id, thread);
      return thread;
    },
    get(id) {
      return threads.get(id) ?? null;
    },
    list(userId) {
      return [...threads.values()].filter((t) => t.userId === userId);
    },
    listByProject(userId) {
      return [...threads.values()].filter((t) => t.userId === userId);
    },
    getParticipants() {
      return [];
    },
    getParticipantsWithActivity() {
      return [];
    },
    addParticipants() {},
    updateParticipantActivity() {},
    updateTitle() {},
  };
}

describe('F193 AC-A5: KD-1 boundary regression', () => {
  let registry;
  let messageStore;
  let socketManager;
  let invocationRecordStore;
  let mockRouter;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    socketManager = createMockSocketManager();
    invocationRecordStore = createMockInvocationRecordStore();
    mockRouter = createMockRouter();
    threadStore = createMockThreadStore();
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      router: mockRouter,
      invocationRecordStore,
      threadStore,
    });
    return app;
  }

  test('invocation-token cross-post with targetCats injects F052 sourceThreadId metadata', async () => {
    const app = await createApp();
    const sourceThread = threadStore.create('user-1', 'Source');
    const targetThread = threadStore.create('user-1', 'Target');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', sourceThread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: targetThread.id,
        content: 'cross-thread relay payload',
        targetCats: ['codex'],
        clientMessageId: 'b1',
      },
    });

    assert.equal(res.statusCode, 200);
    const stored = messageStore.getByThread(targetThread.id, 10, 'user-1');
    const cross = stored.find((m) => m.content === 'cross-thread relay payload');
    assert.ok(cross, 'cross-post message stored in target thread');
    assert.ok(cross.extra?.crossPost, 'F052 crossPost metadata must be injected for invocation-token relay');
    assert.equal(cross.extra.crossPost.sourceThreadId, sourceThread.id);
    assert.equal(cross.extra.crossPost.sourceInvocationId, invocationId);
  });

  test('same-name cat cross-thread @ is NOT self-filtered (F052 exemption preserved)', async () => {
    // Source thread has cat=opus invocation. The cat sends cross-post to
    // target thread with @opus mentioning another opus session. The same-cat
    // self-reference filter MUST be skipped for cross-thread (otherwise
    // the target thread's opus session would never be triggered).
    const app = await createApp();
    const sourceThread = threadStore.create('user-1', 'Source (has opus session)');
    const targetThread = threadStore.create('user-1', 'Target (also has opus session)');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', sourceThread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: targetThread.id,
        content: 'hi other opus session, ping you to coordinate\n@opus',
        clientMessageId: 'b2',
      },
    });

    assert.equal(res.statusCode, 200, 'cross-post with line-start @opus must be accepted');
    // Verify the cross-post created an InvocationRecord for opus in target thread
    // (would be 0 if same-cat self-filter wrongly applied to cross-thread)
    const records = invocationRecordStore.getRecords();
    assert.ok(
      records.length >= 1,
      'cross-thread @opus must trigger target-thread opus session (self-filter exemption)',
    );
    const opusRecord = records.find((r) => r.targetCats?.includes('opus'));
    assert.ok(
      opusRecord,
      'InvocationRecord for opus in target thread must exist; self-filter must NOT drop @opus on cross-thread',
    );
  });
});
