/**
 * F155: Guide engine callback route tests
 * Tests: start-guide, guide-resolve, guide-control
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('F155 Guide callback routes', () => {
  let registry;
  let messageStore;
  let threadStore;
  let guideSessionStore;
  let guideBridge;
  let socketManager;
  let broadcasts;
  let emits;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryGuideSessionStore, createGuideStoreBridge } = await import(
      '../dist/domains/guides/GuideSessionRepository.js'
    );

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    guideSessionStore = new InMemoryGuideSessionStore();
    guideBridge = createGuideStoreBridge(guideSessionStore);
    broadcasts = [];
    emits = [];

    socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom(room, event, data) {
        broadcasts.push({ room, event, data });
      },
      emitToUser(userId, event, data) {
        emits.push({ userId, event, data });
      },
    };
  });

  async function createApp(overrides = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      guideSessionStore,
      ...overrides,
    });
    return app;
  }

  function createCreds() {
    const thread = threadStore.create('user-1', 'Test');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    return { invocationId, callbackToken, threadId: thread.id };
  }

  async function seedGuideState(threadId, guideId, status) {
    await guideBridge.set(threadId, {
      v: 1,
      guideId,
      status,
      offeredAt: Date.now(),
      ...(status === 'active' ? { startedAt: Date.now() } : {}),
    });
  }

  // ─── start-guide ───

  describe('POST /api/callbacks/start-guide', () => {
    test('starts guide with valid guideId', async () => {
      const app = await createApp();
      const { invocationId, callbackToken, threadId } = createCreds();
      await seedGuideState(threadId, 'add-member', 'offered');

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/start-guide',
        payload: { invocationId, callbackToken, guideId: 'add-member' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.equal(body.guideId, 'add-member');

      assert.equal(broadcasts.length, 0);
      assert.deepEqual(emits, [
        {
          userId: 'user-1',
          event: 'guide_start',
          data: {
            guideId: 'add-member',
            threadId,
            timestamp: emits[0].data.timestamp,
          },
        },
      ]);
      assert.equal(typeof emits[0].data.timestamp, 'number');
    });

    test('rejects unknown guideId', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/start-guide',
        payload: { invocationId, callbackToken, guideId: 'nonexistent-flow' },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'unknown_guide_id');
      assert.equal(broadcasts.length, 0);
    });

    test('rejects expired credentials', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/start-guide',
        payload: { invocationId: 'fake', callbackToken: 'fake', guideId: 'add-member' },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(broadcasts.length, 0);
    });

    test('returns stale_ignored for non-latest invocation', async () => {
      const app = await createApp();
      const { invocationId, callbackToken, threadId } = createCreds();
      // Create a newer invocation to make the first one stale
      registry.create('user-1', 'opus', threadId);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/start-guide',
        payload: { invocationId, callbackToken, guideId: 'add-member' },
      });

      const body = JSON.parse(res.body);
      assert.equal(body.status, 'stale_ignored');
      assert.equal(broadcasts.length, 0);
    });

    test('rejects callback start when guide flow is not loadable', async () => {
      const app = await createApp({
        loadGuideFlow() {
          throw new Error('broken flow yaml');
        },
      });
      const { invocationId, callbackToken, threadId } = createCreds();
      await seedGuideState(threadId, 'add-member', 'offered');

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/start-guide',
        payload: { invocationId, callbackToken, guideId: 'add-member' },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'guide_flow_invalid');
      assert.equal(body.message, 'broken flow yaml');
      assert.equal((await guideBridge.get(threadId)).status, 'offered');
      assert.equal(broadcasts.length, 0);
    });
  });

  // ─── guide-resolve ───

  describe('POST /api/callbacks/guide-resolve', () => {
    test('resolves matching intent', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-resolve',
        payload: { invocationId, callbackToken, intent: '添加成员' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.ok(body.matches.length > 0);
      assert.equal(body.matches[0].id, 'add-member');
    });

    test('returns empty matches for unrelated intent', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-resolve',
        payload: { invocationId, callbackToken, intent: '天气预报' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.equal(body.matches.length, 0);
    });

    test('rejects expired credentials', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-resolve',
        payload: { invocationId: 'fake', callbackToken: 'fake', intent: '添加' },
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ─── guide-control ───

  describe('POST /api/callbacks/guide-control', () => {
    test('emits control action to the invocation user with valid credentials', async () => {
      const app = await createApp();
      const { invocationId, callbackToken, threadId } = createCreds();
      await seedGuideState(threadId, 'add-member', 'active');

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-control',
        payload: { invocationId, callbackToken, action: 'next' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.equal(body.action, 'next');
      assert.equal(broadcasts.length, 0);
      assert.deepEqual(emits, [
        {
          userId: 'user-1',
          event: 'guide_control',
          data: {
            action: 'next',
            guideId: 'add-member',
            threadId,
            timestamp: emits[0].data.timestamp,
          },
        },
      ]);
      assert.equal(typeof emits[0].data.timestamp, 'number');
    });

    test('rejects invalid action', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-control',
        payload: { invocationId, callbackToken, action: 'destroy' },
      });

      assert.equal(res.statusCode, 400);
    });

    test('rejects expired credentials', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-control',
        payload: { invocationId: 'fake', callbackToken: 'fake', action: 'next' },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(broadcasts.length, 0);
    });
  });
});
