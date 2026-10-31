import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { SqliteWorldStore } from '../../dist/domains/world/SqliteWorldStore.js';
import { WorldRuntimeCoordinator } from '../../dist/domains/world/WorldRuntimeCoordinator.js';
import { worldRoutes } from '../../dist/routes/world.js';

function buildApp(worldStore, opts = {}) {
  const coordinator = new WorldRuntimeCoordinator(worldStore);
  const app = Fastify();
  if (opts.authenticated !== false) {
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = 'test-user';
    });
  }
  app.register(worldRoutes, { worldStore, coordinator });
  return app;
}

describe('World API Routes', () => {
  let app;
  let worldStore;

  beforeEach(async () => {
    worldStore = new SqliteWorldStore(':memory:');
    await worldStore.initialize();
    app = buildApp(worldStore);
  });

  afterEach(async () => {
    await app.close();
    worldStore.close();
  });

  describe('POST /api/worlds', () => {
    it('creates a world and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: '逐峰宇宙' },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.worldId, 'w1');
      assert.equal(body.name, '逐峰宇宙');
      assert.equal(body.status, 'active');
    });

    it('returns 409 for duplicate worldId (cloud P2)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: '逐峰宇宙' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: '另一个宇宙' },
      });
      assert.equal(res.statusCode, 409);
    });

    it('returns 400 for missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1' },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('GET /api/worlds/:worldId', () => {
    it('returns 404 for nonexistent world', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/worlds/w999' });
      assert.equal(res.statusCode, 404);
    });

    it('returns world after creation', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: '逐峰宇宙' },
      });
      const res = await app.inject({ method: 'GET', url: '/api/worlds/w1' });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).name, '逐峰宇宙');
    });
  });

  describe('POST /api/worlds/:worldId/scenes', () => {
    it('creates a scene', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: '第一幕', mode: 'build' },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.sceneId, 's1');
      assert.equal(body.name, '第一幕');
    });

    it('returns 409 for duplicate sceneId (cloud P2)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: '第一幕', mode: 'build' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: '重复幕', mode: 'perform' },
      });
      assert.equal(res.statusCode, 409);
    });

    it('returns 404 if world does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds/w999/scenes',
        payload: { sceneId: 's1', name: 'scene', mode: 'build' },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST /api/worlds/:worldId/actions', () => {
    it('executes a valid narrate action', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: 'scene', mode: 'build' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/actions',
        payload: {
          sceneId: 's1',
          actorCatId: 'opus',
          mode: 'build',
          actions: [{ type: 'narrate', content: '夜幕降临' }],
          idempotencyKey: 'k1',
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].type, 'narration');
    });

    it('returns 400 for invalid envelope', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/actions',
        payload: { invalid: true },
      });
      assert.equal(res.statusCode, 400);
    });

    it('returns 4xx (not 500) for bad sceneId in actions (cloud P1)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/actions',
        payload: {
          sceneId: 'nonexistent',
          actorCatId: 'opus',
          mode: 'build',
          actions: [{ type: 'narrate', content: 'test' }],
          idempotencyKey: 'k-bad-scene',
        },
      });
      assert.ok(res.statusCode >= 400 && res.statusCode < 500, `expected 4xx, got ${res.statusCode}`);
    });
  });

  describe('GET /api/worlds/:worldId/replay', () => {
    it('returns events for a world', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: 'scene', mode: 'build' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/actions',
        payload: {
          sceneId: 's1',
          actorCatId: 'opus',
          mode: 'build',
          actions: [{ type: 'narrate', content: '夜幕降临' }],
          idempotencyKey: 'k1',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/worlds/w1/replay?sceneId=s1',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.events.length, 1);
    });

    it('returns 404 for nonexistent world', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/worlds/w999/replay' });
      assert.equal(res.statusCode, 404);
    });

    it('returns 400 when sceneId is missing (cloud P2)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/worlds/w1/replay',
      });
      assert.equal(res.statusCode, 400);
    });

    it('returns 400 for non-numeric limit (cloud P1)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/worlds/w1/replay?sceneId=s1&limit=abc',
      });
      assert.equal(res.statusCode, 400);
    });

    it('returns 400 for negative limit (cloud P1)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/worlds/w1/replay?sceneId=s1&limit=-1',
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('ownership (P1-A)', () => {
    it('rejects scene creation by non-owner with 403', async () => {
      // Create world as test-user (default from buildApp hook)
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'owned world' },
      });

      // Build attacker app with different sessionUserId
      const attackerApp = Fastify();
      attackerApp.addHook('onRequest', async (request) => {
        request.sessionUserId = 'attacker';
      });
      attackerApp.register(worldRoutes, {
        worldStore,
        coordinator: new WorldRuntimeCoordinator(worldStore),
      });

      const res = await attackerApp.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: 'injected scene', mode: 'build' },
      });
      assert.equal(res.statusCode, 403);
      await attackerApp.close();
    });

    it('rejects action execution by non-owner with 403', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'owned world' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: 'scene', mode: 'build' },
      });

      const attackerApp = Fastify();
      attackerApp.addHook('onRequest', async (request) => {
        request.sessionUserId = 'attacker';
      });
      attackerApp.register(worldRoutes, {
        worldStore,
        coordinator: new WorldRuntimeCoordinator(worldStore),
      });

      const res = await attackerApp.inject({
        method: 'POST',
        url: '/api/worlds/w1/actions',
        payload: {
          sceneId: 's1',
          actorCatId: 'opus',
          mode: 'build',
          actions: [{ type: 'narrate', content: 'hijack' }],
          idempotencyKey: 'k-attack',
        },
      });
      assert.equal(res.statusCode, 403);
      await attackerApp.close();
    });

    it('allows owner to create scene (200/201)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'my world' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: 'my scene', mode: 'build' },
      });
      assert.equal(res.statusCode, 201);
    });
  });

  describe('authentication (P1-2)', () => {
    it('rejects unauthenticated POST /api/worlds with 401', async () => {
      const unauthApp = buildApp(worldStore, { authenticated: false });
      const res = await unauthApp.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'test' },
      });
      assert.equal(res.statusCode, 401);
      await unauthApp.close();
    });

    it('rejects unauthenticated POST /api/worlds/:worldId/scenes with 401', async () => {
      const unauthApp = buildApp(worldStore, { authenticated: false });
      const res = await unauthApp.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: 'scene', mode: 'build' },
      });
      assert.equal(res.statusCode, 401);
      await unauthApp.close();
    });

    it('rejects unauthenticated POST /api/worlds/:worldId/actions with 401', async () => {
      const unauthApp = buildApp(worldStore, { authenticated: false });
      const res = await unauthApp.inject({
        method: 'POST',
        url: '/api/worlds/w1/actions',
        payload: {
          sceneId: 's1',
          actorCatId: 'opus',
          mode: 'build',
          actions: [{ type: 'narrate', content: 'test' }],
          idempotencyKey: 'k1',
        },
      });
      assert.equal(res.statusCode, 401);
      await unauthApp.close();
    });

    it('rejects unauthenticated GET /api/worlds/:worldId with 401', async () => {
      const unauthApp = buildApp(worldStore, { authenticated: false });
      const res = await unauthApp.inject({ method: 'GET', url: '/api/worlds/w1' });
      assert.equal(res.statusCode, 401);
      await unauthApp.close();
    });

    it('rejects unauthenticated GET /api/worlds/:worldId/replay with 401', async () => {
      const unauthApp = buildApp(worldStore, { authenticated: false });
      const res = await unauthApp.inject({ method: 'GET', url: '/api/worlds/w1/replay' });
      assert.equal(res.statusCode, 401);
      await unauthApp.close();
    });
  });

  describe('read ownership (R3)', () => {
    it('rejects non-owner GET /api/worlds/:worldId with 403', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'private world' },
      });

      const attackerApp = Fastify();
      attackerApp.addHook('onRequest', async (request) => {
        request.sessionUserId = 'attacker';
      });
      attackerApp.register(worldRoutes, {
        worldStore,
        coordinator: new WorldRuntimeCoordinator(worldStore),
      });

      const res = await attackerApp.inject({ method: 'GET', url: '/api/worlds/w1' });
      assert.equal(res.statusCode, 403);
      await attackerApp.close();
    });

    it('rejects non-owner GET /api/worlds/:worldId/replay with 403', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'private world' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/worlds/w1/scenes',
        payload: { sceneId: 's1', name: 'scene', mode: 'build' },
      });

      const attackerApp = Fastify();
      attackerApp.addHook('onRequest', async (request) => {
        request.sessionUserId = 'attacker';
      });
      attackerApp.register(worldRoutes, {
        worldStore,
        coordinator: new WorldRuntimeCoordinator(worldStore),
      });

      const res = await attackerApp.inject({ method: 'GET', url: '/api/worlds/w1/replay?sceneId=s1' });
      assert.equal(res.statusCode, 403);
      await attackerApp.close();
    });

    it('allows owner to read own world', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/worlds',
        payload: { worldId: 'w1', name: 'my world' },
      });
      const res = await app.inject({ method: 'GET', url: '/api/worlds/w1' });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).name, 'my world');
    });
  });
});
