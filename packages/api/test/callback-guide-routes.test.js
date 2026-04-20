/**
 * F155: Guide engine callback route tests
 * Tests: start-guide, get-available-guides, guide-control
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
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

  function createCreds(projectPath = 'default') {
    const thread = threadStore.create('user-1', 'Test', projectPath);
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
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { guideId: 'add-member' },
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
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { guideId: 'nonexistent-flow' },
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
        headers: { 'x-invocation-id': 'fake', 'x-callback-token': 'fake' },
        payload: { guideId: 'add-member' },
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
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { guideId: 'add-member' },
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
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { guideId: 'add-member' },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'guide_flow_invalid');
      assert.equal(body.message, 'broken flow yaml');
      assert.equal((await guideBridge.get(threadId)).status, 'offered');
      assert.equal(broadcasts.length, 0);
    });
  });

  // ─── get-available-guides ───

  describe('POST /api/callbacks/get-available-guides', () => {
    test('returns the currently available guide catalog', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/get-available-guides',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.ok(body.guides.length > 0);
      assert.ok(body.guides.some((guide) => guide.id === 'add-member'));
      assert.deepEqual(
        body.guides.find((guide) => guide.id === 'add-member'),
        {
          id: 'add-member',
          name: '添加成员',
          description: '引导你完成新成员的创建和配置',
          category: 'member-config',
          priority: 'P0',
          crossSystem: false,
          estimatedTime: '3min',
        },
      );
    });

    test('keeps the legacy /guide-resolve alias compatible with discovery responses when no intent is provided', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const legacyRes = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-resolve',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      });

      assert.equal(legacyRes.statusCode, 200);
      const legacyBody = JSON.parse(legacyRes.body);
      assert.equal(legacyBody.status, 'ok');
      assert.ok(legacyBody.guides.length > 0);
      assert.ok(legacyBody.guides.some((guide) => guide.id === 'add-member'));
    });

    test('preserves the legacy /guide-resolve { matches } contract when callers still send intent', async () => {
      const app = await createApp();
      const { invocationId, callbackToken } = createCreds();

      const legacyRes = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-resolve',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { intent: '帮我添加成员并配置认证' },
      });

      assert.equal(legacyRes.statusCode, 200);
      const legacyBody = JSON.parse(legacyRes.body);
      assert.equal(legacyBody.status, 'ok');
      assert.ok(Array.isArray(legacyBody.matches));
      assert.ok(legacyBody.matches.length > 0);
      assert.equal(legacyBody.matches[0].id, 'add-member');
      assert.equal(typeof legacyBody.matches[0].score, 'number');
      assert.equal(legacyBody.guides, undefined);
    });

    test('filters guides that are unavailable in the current context', async () => {
      const app = await createApp({
        getGuideAvailabilityContext: (threadId) => {
          assert.equal(typeof threadId, 'string');
          return { memberCardCount: 0 };
        },
      });
      const { invocationId, callbackToken } = createCreds();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/get-available-guides',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.equal(
        body.guides.some((guide) => guide.id === 'edit-member-auth'),
        false,
      );
    });

    test('derives default guide availability from the authenticated thread projectPath only', async () => {
      const app = await createApp();
      const emptyProjectRoot = mkdtempSync(join(tmpdir(), 'guide-availability-'));
      const registrySnapshot = Object.entries(catRegistry.getAllConfigs());
      const { invocationId, callbackToken } = createCreds(emptyProjectRoot);

      try {
        catRegistry.reset();
        catRegistry.register('foreign-runtime-cat', {
          id: 'foreign-runtime-cat',
          displayName: 'Foreign Runtime Cat',
          nickname: '外部猫',
          mentionPatterns: ['@foreign-runtime-cat'],
          breed: 'maine-coon',
          clientId: 'openai',
          defaultModel: 'gpt-5.4',
          color: { primary: '#111111', secondary: '#ffffff' },
          roleDescription: '',
          personality: '',
        });
        const res = await app.inject({
          method: 'POST',
          url: '/api/callbacks/get-available-guides',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        });

        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.status, 'ok');
        assert.equal(
          body.guides.some((guide) => guide.id === 'edit-member-auth'),
          false,
        );
      } finally {
        catRegistry.reset();
        for (const [id, config] of registrySnapshot) {
          catRegistry.register(id, config);
        }
        rmSync(emptyProjectRoot, { recursive: true, force: true });
      }
    });

    test('rejects expired credentials', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/get-available-guides',
        headers: { 'x-invocation-id': 'fake', 'x-callback-token': 'fake' },
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
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { action: 'next' },
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
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { action: 'destroy' },
      });

      assert.equal(res.statusCode, 400);
    });

    test('rejects expired credentials', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guide-control',
        headers: { 'x-invocation-id': 'fake', 'x-callback-token': 'fake' },
        payload: { action: 'next' },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(broadcasts.length, 0);
    });
  });
});
