/**
 * F155: Frontend-Facing Guide Action Routes Tests
 * POST /api/guide-actions/start  — start guide via frontend click
 * POST /api/guide-actions/cancel — cancel guide via frontend click
 *
 * These endpoints use userId-based auth (X-Cat-Cafe-User header),
 * NOT MCP callback auth. They verify the frontend-only interaction path.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('F155 Guide Action Routes (frontend-facing)', () => {
  let threadStore;
  let guideSessionStore;
  let guideBridge;
  let socketManager;
  let broadcastCalls;
  let emitCalls;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryGuideSessionStore, createGuideStoreBridge } = await import(
      '../dist/domains/guides/GuideSessionRepository.js'
    );
    threadStore = new ThreadStore();
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
    const { guideActionRoutes } = await import('../dist/routes/guide-action-routes.js');
    const app = Fastify();
    await app.register(guideActionRoutes, { threadStore, socketManager, guideSessionStore });
    return app;
  }

  /** Seed a thread with guideState in given status */
  async function seedThread(guideId, status, createdBy = 'user-1') {
    const thread = await threadStore.create(createdBy, 'test-thread');
    await guideBridge.set(thread.id, {
      v: 1,
      guideId,
      status,
      offeredAt: Date.now(),
    });
    return thread;
  }

  async function seedDefaultThread(guideId, status, userId = 'default-user') {
    const thread = await threadStore.get('default');
    await guideBridge.set(thread.id, {
      v: 1,
      guideId,
      status,
      offeredAt: Date.now(),
      userId,
    });
    return thread;
  }

  // --- /api/guide-actions/start ---

  test('start: transitions offered → active and emits socket event', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'active');
    assert.ok(body.guideState.startedAt);

    // Verify socket event
    assert.equal(broadcastCalls.length, 0);
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

  test('start: transitions awaiting_choice → active', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'awaiting_choice');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).guideState.status, 'active');
  });

  test('start: rejects when guide is already active', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 400);
  });

  test('start: self-heals when no guide state exists (card-first delivery)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200, 'self-heal should create active state');
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'active');
    assert.equal(body.guideState.guideId, 'add-member');
    assert.equal(body.guideState.userId, 'user-1');
    assert.ok(body.guideState.startedAt);
  });

  test('start: blocks self-heal on shared default thread (prevents state manufacturing)', async () => {
    const app = await createApp();
    const thread = await threadStore.get('default');
    // No guideState set — simulates naked POST without prior offer

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 409, 'self-heal must be blocked on shared default thread');
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'guide_not_offered');
  });

  test('start: rejects without user identity', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401);
  });

  // --- /api/guide-actions/cancel ---

  test('cancel: transitions offered → cancelled and emits exit control event', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'cancelled');
    assert.ok(body.guideState.completedAt);

    assert.equal(broadcastCalls.length, 0);
    assert.deepEqual(emitCalls, [
      {
        userId: 'user-1',
        event: 'guide_control',
        data: {
          action: 'exit',
          guideId: 'add-member',
          threadId: thread.id,
          timestamp: emitCalls[0].data.timestamp,
        },
      },
    ]);
    assert.equal(typeof emitCalls[0].data.timestamp, 'number');
  });

  test('cancel: idempotent when already cancelled', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'cancelled');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).guideState.status, 'cancelled');
  });

  test('cancel: returns OK when no guide state exists (card-first delivery)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200, 'cancel with no state should be idempotent');
    assert.equal(JSON.parse(res.body).guideState, null);
  });

  test('cancel: rejects without user identity', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401);
  });

  // --- /api/guide-actions/preview ---

  test('preview: transitions offered → awaiting_choice and returns flow', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/preview',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'awaiting_choice');
    assert.ok(body.flow);
    assert.ok(Array.isArray(body.flow.steps));
  });

  test('preview: self-heals when no guide state exists (card-first delivery)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'test-thread');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/preview',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200, 'preview self-heal should create awaiting_choice state');
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'awaiting_choice');
    assert.equal(body.guideState.guideId, 'add-member');
    assert.ok(body.flow);
    assert.ok(Array.isArray(body.flow.steps));
  });

  test('preview: blocks self-heal on shared default thread (prevents state manufacturing)', async () => {
    const app = await createApp();
    const thread = await threadStore.get('default');
    // No guideState set — simulates naked POST without prior offer

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/preview',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 409, 'preview self-heal must be blocked on shared default thread');
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'guide_not_offered');
  });

  test('preview: idempotent when already awaiting_choice', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'awaiting_choice');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/preview',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'awaiting_choice');
    assert.ok(body.flow);
  });

  test('preview: rejects without user identity', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/preview',
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401);
  });

  // --- P1: start must reject when flow is not loadable ---

  test('start: rejects when guide flow is not loadable (400)', async () => {
    const app = await createApp();
    // Seed thread with a guideId that has no corresponding flow YAML
    const thread = await seedThread('nonexistent-flow', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'nonexistent-flow' },
    });

    assert.equal(res.statusCode, 400, 'start must fail when flow cannot be loaded');
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'guide_flow_invalid');
    // Verify state was NOT updated to active
    const gs = await guideBridge.get(thread.id);
    assert.equal(gs.status, 'offered', 'state must remain offered on flow load failure');
  });

  // --- P1-1: Thread ownership (cross-user state tampering) ---

  test('start: rejects when user does not own the thread (403)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered'); // created by user-1

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'attacker-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403, 'cross-user start must be rejected');
  });

  test('cancel: rejects when user does not own the thread (403)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered'); // created by user-1

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'attacker-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403, 'cross-user cancel must be rejected');
  });

  // --- P2-1: Header-only auth (query param userId spoofing) ---

  test('start: rejects query-param userId without header (401)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: `/api/guide-actions/start?userId=user-1`,
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401, 'query-param userId must not authenticate');
  });

  test('cancel: rejects query-param userId without header (401)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: `/api/guide-actions/cancel?userId=user-1`,
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401, 'query-param userId must not authenticate');
  });

  // --- Default thread (createdBy='system') public access ---

  test('start: allows the guide owner on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200, 'default-thread guide owner should be allowed');
    assert.equal(JSON.parse(res.body).guideState.status, 'active');
    assert.equal(broadcastCalls.length, 0, 'guide_start must not broadcast to shared default thread room');
    assert.equal(emitCalls.length, 1, 'guide_start must be emitted only to the guide owner');
    assert.deepEqual(emitCalls[0], {
      userId: 'default-user',
      event: 'guide_start',
      data: {
        guideId: 'add-member',
        threadId: thread.id,
        timestamp: emitCalls[0].data.timestamp,
      },
    });
    assert.equal(typeof emitCalls[0].data.timestamp, 'number');
  });

  test('start: rejects other users on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'offered', 'default-user');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'attacker-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403, 'default-thread guide must stay owner-scoped');
  });

  test('cancel: allows the guide owner on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200, 'default-thread guide owner should be allowed');
    assert.equal(JSON.parse(res.body).guideState.status, 'cancelled');
    assert.equal(broadcastCalls.length, 0, 'guide_control exit must not broadcast to shared default thread room');
    assert.equal(emitCalls.length, 1, 'guide_control exit must be emitted only to the guide owner');
    assert.deepEqual(emitCalls[0], {
      userId: 'default-user',
      event: 'guide_control',
      data: {
        action: 'exit',
        guideId: 'add-member',
        threadId: thread.id,
        timestamp: emitCalls[0].data.timestamp,
      },
    });
    assert.equal(typeof emitCalls[0].data.timestamp, 'number');
  });

  test('cancel: rejects other users on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'offered', 'default-user');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'attacker-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403, 'default-thread guide must stay owner-scoped');
  });

  test('start: rejects arbitrary users on non-default system-owned threads', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered', 'system');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/start',
      headers: { 'x-cat-cafe-user': 'any-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'Thread access denied');
  });

  test('cancel: rejects arbitrary users on non-default system-owned threads', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered', 'system');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/cancel',
      headers: { 'x-cat-cafe-user': 'any-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'Thread access denied');
  });

  // --- /api/guide-flows/:guideId ---

  test('guide-flows: rejects without user identity (401)', async () => {
    const app = await createApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/guide-flows/add-member',
    });

    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'Identity required (X-Cat-Cafe-User header)');
  });

  test('guide-flows: returns flow for authenticated users', async () => {
    const app = await createApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/guide-flows/add-member',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, 'add-member');
    assert.ok(Array.isArray(body.steps));
    assert.ok(body.steps.length > 0);
  });

  // --- /api/guide-actions/complete ---

  test('complete: transitions active → completed and emits socket event', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guideState.status, 'completed');
    assert.ok(body.guideState.completedAt);

    assert.equal(broadcastCalls.length, 0);
    assert.deepEqual(emitCalls, [
      {
        userId: 'user-1',
        event: 'guide_complete',
        data: {
          guideId: 'add-member',
          threadId: thread.id,
          timestamp: emitCalls[0].data.timestamp,
        },
      },
    ]);
    assert.equal(typeof emitCalls[0].data.timestamp, 'number');
  });

  test('complete: idempotent when already completed', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'completed');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).guideState.status, 'completed');
  });

  test('complete: rejects when guide not active', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'offered');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 400);
  });

  test('complete: rejects when user does not own the thread (403)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'attacker-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403, 'cross-user complete must be rejected');
  });

  test('complete: rejects without user identity (401)', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 401);
  });

  test('complete: allows the guide owner on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'active');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).guideState.status, 'completed');
    assert.equal(broadcastCalls.length, 0, 'guide_complete must not broadcast to shared default thread room');
    assert.equal(emitCalls.length, 1, 'guide_complete must be emitted only to the guide owner');
    assert.deepEqual(emitCalls[0], {
      userId: 'default-user',
      event: 'guide_complete',
      data: {
        guideId: 'add-member',
        threadId: thread.id,
        timestamp: emitCalls[0].data.timestamp,
      },
    });
    assert.equal(typeof emitCalls[0].data.timestamp, 'number');
  });

  test('complete: rejects other users on system-owned default thread', async () => {
    const app = await createApp();
    const thread = await seedDefaultThread('add-member', 'active', 'default-user');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'attacker-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403, 'default-thread guide must stay owner-scoped');
  });

  test('complete: rejects arbitrary users on non-default system-owned threads', async () => {
    const app = await createApp();
    const thread = await seedThread('add-member', 'active', 'system');

    const res = await app.inject({
      method: 'POST',
      url: '/api/guide-actions/complete',
      headers: { 'x-cat-cafe-user': 'any-user' },
      payload: { threadId: thread.id, guideId: 'add-member' },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'Thread access denied');
  });
});
