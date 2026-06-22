/**
 * F177 Phase H — Cross-post participant check warning.
 *
 * When a cat cross-posts to a thread and targetCats are NOT current
 * participants in that thread, the response should include a
 * routing_warning with kind='target_not_in_thread'. This catches
 * the "posted to wrong thread" misroute that caused ball drops
 * during F195 dogfood.
 *
 * The warning is informational (doesn't block delivery) because
 * cross-posting to introduce a cat into a new thread is legitimate.
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

/** Thread store with configurable participants per thread. */
function createMockThreadStore() {
  const threads = new Map();
  const participantsMap = new Map();
  return {
    create(userId, title) {
      const thread = {
        id: `thread-${threads.size}`,
        userId,
        createdBy: userId,
        title: title ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        participants: [],
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
    getParticipants(threadId) {
      return participantsMap.get(threadId) ?? [];
    },
    getParticipantsWithActivity() {
      return [];
    },
    addParticipants(threadId, catIds) {
      const existing = participantsMap.get(threadId) ?? [];
      for (const catId of catIds) {
        if (!existing.includes(catId)) existing.push(catId);
      }
      participantsMap.set(threadId, existing);
    },
    /** Test helper: set participants for a specific thread. */
    _setParticipants(threadId, catIds) {
      participantsMap.set(threadId, [...catIds]);
    },
    updateParticipantActivity() {},
    updateTitle() {},
  };
}

function createMockAgentKeyRegistry(validSecret = 'test-agent-secret') {
  const claimed = new Set();
  return {
    async verify(secret) {
      if (secret === validSecret) {
        return {
          ok: true,
          record: {
            agentKeyId: 'ak_test1',
            catId: 'opus',
            userId: 'user-1',
            secretHash: 'x',
            salt: 'y',
            scope: 'user-bound',
            issuedAt: Date.now(),
            expiresAt: Date.now() + 86400000,
          },
        };
      }
      return { ok: false, reason: 'agent_key_unknown' };
    },
    async claimClientMessageId(_agentKeyId, clientMessageId) {
      if (claimed.has(clientMessageId)) return false;
      claimed.add(clientMessageId);
      return true;
    },
  };
}

describe('F177-H: Cross-post participant check warning', () => {
  let registry;
  let messageStore;
  let socketManager;
  let invocationRecordStore;
  let mockRouter;
  let threadStore;
  let agentKeyRegistry;

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
    agentKeyRegistry = createMockAgentKeyRegistry();
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
      agentKeyRegistry,
    });
    return app;
  }

  test('cross-post to thread where targetCat is NOT a participant emits target_not_in_thread warning', async () => {
    const app = await createApp();
    const sourceThread = threadStore.create('user-1', 'Source');
    const targetThread = threadStore.create('user-1', 'Target');

    // Target thread has sonnet as participant, but NOT codex
    threadStore._setParticipants(targetThread.id, ['sonnet']);

    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', sourceThread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: targetThread.id,
        content: 'Review done for PR #2478',
        targetCats: ['codex'],
        clientMessageId: 'f177h-1',
      },
    });

    assert.equal(res.statusCode, 200, `response: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(body.routing_warnings, 'should have routing_warnings');
    const notInThread = body.routing_warnings.find((w) => w.kind === 'target_not_in_thread');
    assert.ok(notInThread, `should have target_not_in_thread warning, got: ${JSON.stringify(body.routing_warnings)}`);
    assert.equal(notInThread.catId, 'codex');
    assert.equal(notInThread.threadId, targetThread.id);
  });

  test('cross-post to thread where targetCat IS a participant emits NO target_not_in_thread warning', async () => {
    const app = await createApp();
    const sourceThread = threadStore.create('user-1', 'Source');
    const targetThread = threadStore.create('user-1', 'Target');

    // Target thread has codex as participant
    threadStore._setParticipants(targetThread.id, ['codex', 'sonnet']);

    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', sourceThread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: targetThread.id,
        content: 'Review done for PR #2478',
        targetCats: ['codex'],
        clientMessageId: 'f177h-2',
      },
    });

    assert.equal(res.statusCode, 200, `response: ${res.body}`);
    const body = JSON.parse(res.body);
    const notInThread = (body.routing_warnings ?? []).find((w) => w.kind === 'target_not_in_thread');
    assert.equal(notInThread, undefined, 'should NOT have target_not_in_thread warning when cat is participant');
  });

  test('cross-post warning message includes thread ID for actionable diagnosis', async () => {
    const app = await createApp();
    const sourceThread = threadStore.create('user-1', 'Source');
    const targetThread = threadStore.create('user-1', 'Target');

    // No participants in target thread
    threadStore._setParticipants(targetThread.id, []);

    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', sourceThread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: targetThread.id,
        content: 'cross-post with bad routing',
        targetCats: ['codex'],
        clientMessageId: 'f177h-3',
      },
    });

    assert.equal(res.statusCode, 200, `response: ${res.body}`);
    const body = JSON.parse(res.body);
    // The human-readable message should mention the thread ID
    assert.ok(body.message, 'should have message');
    assert.match(body.message, /thread/, 'message should mention thread for actionable diagnosis');
  });

  test('same-thread post does NOT emit target_not_in_thread warning (only cross-thread)', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'MyThread');

    // Thread has no participants — but same-thread post should never trigger this warning
    threadStore._setParticipants(thread.id, []);

    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: 'same-thread message\n@codex',
        clientMessageId: 'f177h-4',
      },
    });

    assert.equal(res.statusCode, 200, `response: ${res.body}`);
    const body = JSON.parse(res.body);
    const notInThread = (body.routing_warnings ?? []).find((w) => w.kind === 'target_not_in_thread');
    assert.equal(notInThread, undefined, 'same-thread post should never emit target_not_in_thread');
  });

  test('agent-key post to thread where targetCat is NOT a participant emits target_not_in_thread warning', async () => {
    const app = await createApp();
    const targetThread = threadStore.create('user-1', 'Target');

    // Target thread has sonnet, NOT codex
    threadStore._setParticipants(targetThread.id, ['sonnet']);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'test-agent-secret' },
      payload: {
        threadId: targetThread.id,
        content: 'agent-key review delivery',
        targetCats: ['codex'],
        clientMessageId: 'f177h-ak-1',
      },
    });

    assert.equal(res.statusCode, 200, `response: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(body.routing_warnings, 'agent-key path should also have routing_warnings');
    const notInThread = body.routing_warnings.find((w) => w.kind === 'target_not_in_thread');
    assert.ok(
      notInThread,
      `agent-key path should emit target_not_in_thread, got: ${JSON.stringify(body.routing_warnings)}`,
    );
    assert.equal(notInThread.catId, 'codex');
    assert.equal(notInThread.threadId, targetThread.id);
  });

  test('agent-key post to thread where targetCat IS a participant emits NO warning', async () => {
    const app = await createApp();
    const targetThread = threadStore.create('user-1', 'Target');

    // Target thread has codex as participant
    threadStore._setParticipants(targetThread.id, ['codex']);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'test-agent-secret' },
      payload: {
        threadId: targetThread.id,
        content: 'agent-key message to correct thread',
        targetCats: ['codex'],
        clientMessageId: 'f177h-ak-2',
      },
    });

    assert.equal(res.statusCode, 200, `response: ${res.body}`);
    const body = JSON.parse(res.body);
    const notInThread = (body.routing_warnings ?? []).find((w) => w.kind === 'target_not_in_thread');
    assert.equal(notInThread, undefined, 'no warning when target is a participant');
  });
});
