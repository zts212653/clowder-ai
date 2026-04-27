/**
 * F079 Gap 4: Cat-initiated vote callback tests
 * Tests POST /api/callbacks/start-vote endpoint
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('POST /api/callbacks/start-vote', () => {
  let registry;
  let messageStore;
  let threadStore;
  let socketManager;
  let broadcasts;
  let agentMessages;
  let persistedMessages;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    broadcasts = [];
    agentMessages = [];
    persistedMessages = [];

    // Wrap messageStore.append to track persisted messages
    const originalAppend = messageStore.append.bind(messageStore);
    messageStore.append = async (msg) => {
      const stored = await originalAppend(msg);
      persistedMessages.push(stored);
      return stored;
    };

    socketManager = {
      broadcastAgentMessage(msg) {
        agentMessages.push(msg);
      },
      broadcastToRoom(room, event, data) {
        broadcasts.push({ room, event, data });
      },
      emitToUser() {},
    };
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
    });
    return app;
  }

  test('starts a vote with valid credentials', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'REST 还是 GraphQL？',
        options: ['REST', 'GraphQL'],
        voters: ['codex', 'gemini'],
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.votingState.question, 'REST 还是 GraphQL？');
    assert.equal(body.votingState.createdBy, 'user-1', 'createdBy should be the real userId');
    assert.equal(body.votingState.initiatedByCat, 'opus', 'initiatedByCat tracks the cat');
    assert.deepEqual(body.votingState.voters, ['codex', 'gemini']);
  });

  test('broadcasts vote_started via WebSocket', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: '哪个方案？',
        options: ['A', 'B'],
        voters: ['codex'],
      },
    });

    const voteStarted = broadcasts.find((b) => b.event === 'vote_started');
    assert.ok(voteStarted, 'vote_started event should be broadcast');
    assert.equal(voteStarted.room, `thread:${thread.id}`);
    assert.equal(voteStarted.data.votingState.question, '哪个方案？');
  });

  test('persists vote notification message with @mentions', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: '谁最坏？',
        options: ['opus', 'codex'],
        voters: ['codex', 'gemini'],
      },
    });

    assert.equal(persistedMessages.length, 1, 'should persist 1 notification message');
    const msg = persistedMessages[0];
    assert.ok(msg.content.includes('投票请求'), 'notification should contain vote prompt');
    assert.ok(msg.content.includes('[VOTE:'), 'notification should contain VOTE example');
    assert.equal(msg.catId, 'opus', 'catId should be the initiating cat');
    assert.ok(msg.mentions.length === 2, 'should mention both voters');
  });

  test('returns 409 when active vote already exists', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    // First vote
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'Q1?',
        options: ['A', 'B'],
        voters: ['codex'],
      },
    });

    // Second vote should fail
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'Q2?',
        options: ['C', 'D'],
        voters: ['codex'],
      },
    });

    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'VOTE_ALREADY_ACTIVE');
  });

  test('returns 401 with invalid credentials', async () => {
    const app = await createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': 'fake-id', 'x-callback-token': 'fake-token' },
      payload: {
        question: 'Q?',
        options: ['A', 'B'],
        voters: ['codex'],
      },
    });

    assert.equal(res.statusCode, 401);
  });

  test('returns 400 with fewer than 2 options', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'Q?',
        options: ['A'],
        voters: ['codex'],
      },
    });

    assert.equal(res.statusCode, 400);
  });

  // P1-1: createdBy must be userId (not catId) so closeVoteInternal persists to correct user space
  test('createdBy is userId, initiatedByCat is catId', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'Q?',
        options: ['A', 'B'],
        voters: ['codex'],
      },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.votingState.createdBy, 'user-1', 'createdBy must be the real userId for message persistence');
    assert.equal(body.votingState.initiatedByCat, 'opus', 'initiatedByCat should track the cat who started the vote');
  });

  // P1-2: stale invocation must not be allowed to start a vote
  test('rejects stale invocation with 200 stale_ignored', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'Test');
    const old = await registry.create('user-1', 'opus', thread.id);
    // Create a newer invocation for same cat+thread, making `old` stale
    await registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': old.invocationId, 'x-callback-token': old.callbackToken },
      payload: {
        question: 'Q?',
        options: ['A', 'B'],
        voters: ['codex'],
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'stale_ignored', 'stale invocations should be rejected gracefully');
  });

  // P2: non-existent thread should return 404
  test('returns 404 for non-existent thread', async () => {
    const app = await createApp();
    // Create invocation with a threadId that does NOT exist in threadStore
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'non-existent-thread');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'Q?',
        options: ['A', 'B'],
        voters: ['codex'],
      },
    });

    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'THREAD_NOT_FOUND');
  });

  test('defaults to non-anonymous and 120s timeout', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'Q?',
        options: ['A', 'B'],
        voters: ['codex'],
      },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.votingState.anonymous, false);
    // deadline should be ~120s from now
    const deadline = body.votingState.deadline;
    const now = Date.now();
    assert.ok(deadline > now && deadline <= now + 121_000, 'deadline should be ~120s from now');
  });

  test('dispatches voter cats via A2A when router + invocationRecordStore are provided', async () => {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

    const dispatchedCats = [];
    const invocationQueue = new InvocationQueue();
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      router: {
        routeExecution: async function* () {
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
      },
      invocationRecordStore: {
        create: async (opts) => {
          dispatchedCats.push(...opts.targetCats);
          return { outcome: 'created', invocationId: `inv-${Date.now()}` };
        },
        update: async () => {},
      },
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
        getActiveSlots: () => [],
      },
      invocationQueue,
      queueProcessor: {
        onInvocationComplete: async () => {},
        tryAutoExecute: async () => {},
        registerEntryCompleteHook: () => {},
        unregisterEntryCompleteHook: () => {},
      },
    });

    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: '哪个方案好？',
        options: ['A', 'B'],
        voters: ['codex', 'gemini'],
      },
    });

    assert.equal(res.statusCode, 200);
    // Voters should have been dispatched (either via queue or fallback)
    const queueEntries = invocationQueue.listAutoExecute?.(thread.id) ?? [];
    // At least the queue should have been populated or fallback dispatch triggered
    const dispatched = queueEntries.length > 0 || dispatchedCats.length > 0;
    assert.ok(dispatched, 'voter cats should be dispatched after start-vote');
  });

  test('voters > MAX_QUEUE_DEPTH: all enqueued (F175: agent source bypasses depth limit)', async () => {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

    const fallbackTargets = [];
    const invocationQueue = new InvocationQueue();
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      router: {
        routeExecution: async function* () {
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      invocationRecordStore: {
        create: async (opts) => {
          // Track fallback (direct dispatch) targets — these are called AFTER queue overflow
          fallbackTargets.push(...opts.targetCats);
          return { outcome: 'created', invocationId: `inv-${Date.now()}` };
        },
        update: async () => {},
      },
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
        getActiveSlots: () => [],
      },
      invocationQueue,
      queueProcessor: {
        onInvocationComplete: async () => {},
        tryAutoExecute: async () => {},
        registerEntryCompleteHook: () => {},
        unregisterEntryCompleteHook: () => {},
      },
    });

    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    // 7 voters: queue can hold 5, remaining 2 should fall back to direct dispatch
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'Overflow test?',
        options: ['A', 'B'],
        voters: ['codex', 'gemini', 'sonnet', 'gpt52', 'spark', 'dare', 'antigravity'],
      },
    });

    assert.equal(res.statusCode, 200);

    // F175: agent source bypasses MAX_QUEUE_DEPTH — all 7 voters should be enqueued
    const queueEntries = invocationQueue.listAutoExecute?.(thread.id) ?? [];
    assert.equal(queueEntries.length, 7, 'all 7 voters should be enqueued (agent bypasses depth limit)');

    // No fallback needed — all fit in queue
    assert.equal(fallbackTargets.length, 0, 'no fallback needed when agent source bypasses depth limit');
  });
});
