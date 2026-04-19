/**
 * F155: Guide State Callback Tests
 * POST /api/callbacks/update-guide-state
 * POST /api/callbacks/start-guide
 * POST /api/callbacks/guide-control
 *
 * Tests forward-only state machine, multi-cat dedup, and authorization.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('F155 Guide State Callbacks', () => {
  let registry;
  let threadStore;
  let messageStore;
  let guideSessionStore;
  let guideBridge;
  let socketManager;
  let broadcastCalls;
  let emitCalls;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InMemoryGuideSessionStore, createGuideStoreBridge } = await import(
      '../dist/domains/guides/GuideSessionRepository.js'
    );

    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    guideSessionStore = new InMemoryGuideSessionStore();
    guideBridge = createGuideStoreBridge(guideSessionStore);
    broadcastCalls = [];
    emitCalls = [];
    socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom(room, event, data) {
        broadcastCalls.push({ room, event, data });
      },
      emitToUser(userId, event, data) {
        emitCalls.push({ userId, event, data });
      },
      getMessages() {
        return [];
      },
    };
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { leaderboardEventsRoutes } = await import('../dist/routes/leaderboard-events.js');
    const { GameStore } = await import('../dist/domains/leaderboard/game-store.js');
    const { AchievementStore } = await import('../dist/domains/leaderboard/achievement-store.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      guideSessionStore,
      sharedBank: 'cat-cafe-shared',
    });
    await app.register(leaderboardEventsRoutes, {
      gameStore: new GameStore(),
      achievementStore: new AchievementStore(),
    });
    return app;
  }

  async function seedDefaultThread(guideId, status, userId = 'default-user') {
    const thread = await threadStore.get('default');
    await guideBridge.set(thread.id, {
      v: 1,
      guideId,
      status,
      offeredAt: Date.now(),
      ...(status === 'active' ? { startedAt: Date.now() } : {}),
      userId,
    });
    return thread;
  }

  // --- update-guide-state ---

  test('creates initial guide state as "offered"', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-guide-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, guideId: 'add-member', status: 'offered' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.guideId, 'add-member');
    assert.equal(body.guideState.status, 'offered');
    assert.ok(body.guideState.offeredAt > 0);
  });

  test('rejects initial state that is not "offered"', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-guide-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, guideId: 'add-member', status: 'active' },
    });

    assert.equal(res.statusCode, 400);
  });

  test('update-guide-state rejects active transition and requires start-guide side effects', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    await guideBridge.set(thread.id, {
      v: 1,
      guideId: 'add-member',
      status: 'offered',
      offeredAt: 1000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-guide-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, guideId: 'add-member', status: 'active' },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'guide_start_required');
    assert.match(body.message, /start-guide/i);

    const gs = await guideBridge.get(thread.id);
    assert.equal(gs.status, 'offered');
    assert.equal(gs.offeredAt, 1000);
    assert.deepEqual(emitCalls, []);
    assert.deepEqual(broadcastCalls, []);
  });

  test('rejects invalid backward transition: active → offered', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    await guideBridge.set(thread.id, {
      v: 1,
      guideId: 'add-member',
      status: 'active',
      offeredAt: 1000,
      startedAt: 2000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-guide-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, guideId: 'add-member', status: 'offered' },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Invalid guide transition'));
  });

  test('rejects re-offering same guide when it is still active', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    await guideBridge.set(thread.id, {
      v: 1,
      guideId: 'add-member',
      status: 'active',
      offeredAt: 1000,
      startedAt: 2000,
    });

    // Trying to go back to 'offered' is an invalid backward transition
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-guide-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, guideId: 'add-member', status: 'offered' },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('Invalid guide transition'));
  });

  test('allows re-offering same guide after it was completed', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    await guideBridge.set(thread.id, {
      v: 1,
      guideId: 'add-member',
      status: 'completed',
      offeredAt: 1000,
      completedAt: 3000,
    });

    // completed is terminal; completed→offered is not a normal transition,
    // but the route should treat "same guideId + terminal state" as a new offer
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-guide-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, guideId: 'add-member', status: 'offered' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).guideState.guideId, 'add-member');
    assert.equal(JSON.parse(res.body).guideState.status, 'offered');
  });

  test('rejects cross-thread write', async () => {
    const app = await createApp();
    const thread1 = await threadStore.create('user-1', 'thread-1');
    const thread2 = await threadStore.create('user-1', 'thread-2');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread1.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-guide-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread2.id, guideId: 'add-member', status: 'offered' },
    });

    assert.equal(res.statusCode, 403);
  });

  test('returns 401 for invalid credentials', async () => {
    const app = await createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-guide-state',
      payload: {
        invocationId: 'fake',
        callbackToken: 'fake',
        threadId: 't1',
        guideId: 'add-member',
        status: 'offered',
      },
    });

    assert.equal(res.statusCode, 401);
  });

  test('update-guide-state rejects cross-user mutation on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'offered', 'guide-owner');
    const { invocationId, callbackToken } = registry.create('attacker-user', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-guide-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, guideId: 'add-member', status: 'active' },
    });

    assert.equal(res.statusCode, 403);
    const gs = await guideBridge.get(thread.id);
    assert.equal(gs.status, 'offered');
    assert.equal(gs.userId, 'guide-owner');
  });

  // --- start-guide ---

  test('start-guide transitions from offered → active and emits socket event', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    await guideBridge.set(thread.id, {
      v: 1,
      guideId: 'add-member',
      status: 'offered',
      offeredAt: 1000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-guide',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'active');

    assert.equal(
      broadcastCalls.find((c) => c.event === 'guide_start'),
      undefined,
      'guide_start should be user-scoped',
    );
    assert.deepEqual(emitCalls, [
      {
        userId: 'user-1',
        event: 'guide_start',
        data: {
          guideId: 'add-member',
          threadId: thread.id,
          timestamp: emitCalls[0].data.timestamp,
        },
      },
    ]);
    assert.equal(typeof emitCalls[0].data.timestamp, 'number');
  });

  test('start-guide emits guide_start only to the guide owner on shared default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'offered', 'guide-owner');
    const { invocationId, callbackToken } = registry.create('guide-owner', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-guide',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(
      broadcastCalls.find((c) => c.event === 'guide_start'),
      undefined,
      'shared default-thread guide_start must not use room broadcast',
    );
    assert.deepEqual(emitCalls, [
      {
        userId: 'guide-owner',
        event: 'guide_start',
        data: {
          guideId: 'add-member',
          threadId: thread.id,
          timestamp: emitCalls[0].data.timestamp,
        },
      },
    ]);
    assert.equal(typeof emitCalls[0].data.timestamp, 'number');
  });

  test('start-guide rejects when no guide is offered', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-guide',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('guide_not_offered'));
  });

  test('start-guide rejects when guide is already active', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    await guideBridge.set(thread.id, {
      v: 1,
      guideId: 'add-member',
      status: 'active',
      offeredAt: 1000,
      startedAt: 2000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-guide',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 400);
  });

  test('start-guide rejects cross-user start on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'offered', 'guide-owner');
    const { invocationId, callbackToken } = registry.create('attacker-user', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-guide',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403);
    const gs = await guideBridge.get(thread.id);
    assert.equal(gs.status, 'offered');
    assert.equal(
      broadcastCalls.find((c) => c.event === 'guide_start'),
      undefined,
    );
  });

  // --- guide-control ---

  test('guide-control emits socket event when guide is active', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    await guideBridge.set(thread.id, {
      v: 1,
      guideId: 'add-member',
      status: 'active',
      offeredAt: 1000,
      startedAt: 2000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guide-control',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { action: 'next' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(
      broadcastCalls.find((c) => c.event === 'guide_control'),
      undefined,
      'guide_control should be user-scoped',
    );
    assert.deepEqual(emitCalls, [
      {
        userId: 'user-1',
        event: 'guide_control',
        data: {
          action: 'next',
          guideId: 'add-member',
          threadId: thread.id,
          timestamp: emitCalls[0].data.timestamp,
        },
      },
    ]);
    assert.equal(typeof emitCalls[0].data.timestamp, 'number');
  });

  test('guide-control emits only to the guide owner on shared default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'active', 'guide-owner');
    const { invocationId, callbackToken } = registry.create('guide-owner', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guide-control',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { action: 'next' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(
      broadcastCalls.find((c) => c.event === 'guide_control'),
      undefined,
      'shared default-thread guide_control must not use room broadcast',
    );
    assert.deepEqual(emitCalls, [
      {
        userId: 'guide-owner',
        event: 'guide_control',
        data: {
          action: 'next',
          guideId: 'add-member',
          threadId: thread.id,
          timestamp: emitCalls[0].data.timestamp,
        },
      },
    ]);
    assert.equal(typeof emitCalls[0].data.timestamp, 'number');
  });

  test('guide-control rejects when no active guide', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guide-control',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { action: 'next' },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('no_active_guide'));
  });

  test('guide-control exit cancels the guide', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    await guideBridge.set(thread.id, {
      v: 1,
      guideId: 'add-member',
      status: 'active',
      offeredAt: 1000,
      startedAt: 2000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guide-control',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { action: 'exit' },
    });

    assert.equal(res.statusCode, 200);
    const gs = await guideBridge.get(thread.id);
    assert.equal(gs.status, 'cancelled');
  });

  test('guide-control rejects cross-user control on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'active', 'guide-owner');
    const { invocationId, callbackToken } = registry.create('attacker-user', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guide-control',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { action: 'exit' },
    });

    assert.equal(res.statusCode, 403);
    const gs = await guideBridge.get(thread.id);
    assert.equal(gs.status, 'active');
    assert.equal(
      broadcastCalls.find((c) => c.event === 'guide_control'),
      undefined,
    );
  });
});
