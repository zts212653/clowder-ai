/**
 * F33 Phase 3: Session Strategy Config Route Tests
 * Fastify inject tests for GET/PATCH/DELETE /api/config/session-strategy
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

async function loadOverridesModule() {
  return import('../dist/config/session-strategy-overrides.js');
}

async function createApp() {
  const { sessionStrategyConfigRoutes } = await import('../dist/routes/session-strategy-config.js');
  const app = Fastify();
  await app.register(sessionStrategyConfigRoutes);
  return app;
}

const USER_HEADER = { 'x-cat-cafe-user': 'test-user' };

describe('session-strategy-config routes', () => {
  let overridesModule;

  beforeEach(async () => {
    overridesModule = await loadOverridesModule();
    overridesModule._clearRuntimeOverrides();
  });

  afterEach(async () => {
    overridesModule._clearRuntimeOverrides();
  });

  // ── GET /api/config/session-strategy ──

  describe('GET /api/config/session-strategy', () => {
    test('returns list of cats with strategy info', async () => {
      const app = await createApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/config/session-strategy',
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.cats));
      assert.ok(body.cats.length > 0);
      // Each cat entry has required fields
      const first = body.cats[0];
      assert.ok(first.catId);
      assert.ok(first.displayName);
      assert.ok(first.clientId);
      assert.ok(first.effective);
      assert.ok(first.source);
      assert.equal(typeof first.hasOverride, 'boolean');
      assert.equal(typeof first.hybridCapable, 'boolean');
      assert.equal(typeof first.sessionChainEnabled, 'boolean');
    });
  });

  // ── PATCH /api/config/session-strategy/:catId ──

  describe('PATCH /api/config/session-strategy/:catId', () => {
    test('P1-2: returns 400 without X-Cat-Cafe-User header', async () => {
      const app = await createApp();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/session-strategy/opus',
        payload: { strategy: 'compress' },
        // No identity header
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /Identity required/);
    });

    test('returns 404 for unknown catId', async () => {
      const app = await createApp();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/session-strategy/nonexistent-cat',
        headers: USER_HEADER,
        payload: { strategy: 'handoff' },
      });
      assert.equal(res.statusCode, 404);
    });

    test('returns 400 for invalid body (bad thresholds)', async () => {
      const app = await createApp();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/session-strategy/opus',
        headers: USER_HEADER,
        payload: { strategy: 'handoff', thresholds: { warn: 2.0, action: 3.0 } },
      });
      assert.equal(res.statusCode, 400);
    });

    test('returns 422 for hybrid on non-hook-capable provider', async () => {
      const app = await createApp();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/session-strategy/codex',
        headers: USER_HEADER,
        payload: { strategy: 'hybrid', hybrid: { maxCompressions: 2 } },
      });
      assert.equal(res.statusCode, 422);
      assert.match(res.json().error, /hybrid strategy requires/);
    });

    test('200 success sets override and returns effective config', async () => {
      const app = await createApp();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/session-strategy/opus',
        headers: USER_HEADER,
        payload: {
          strategy: 'compress',
          thresholds: { warn: 0.7, action: 0.85 },
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.catId, 'opus');
      assert.equal(body.source, 'runtime_override');
      assert.equal(body.effective.strategy, 'compress');
      // Cache should be updated
      const cached = overridesModule.getRuntimeOverride('opus');
      assert.ok(cached);
      assert.equal(cached.strategy, 'compress');
    });
  });

  // ── DELETE /api/config/session-strategy/:catId ──

  describe('DELETE /api/config/session-strategy/:catId', () => {
    test('P1-2: returns 400 without X-Cat-Cafe-User header', async () => {
      const app = await createApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/config/session-strategy/opus',
        // No identity header
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /Identity required/);
    });

    test('returns 404 for unknown catId', async () => {
      const app = await createApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/config/session-strategy/nonexistent-cat',
        headers: USER_HEADER,
      });
      assert.equal(res.statusCode, 404);
    });

    test('returns 404 when no override exists', async () => {
      const app = await createApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/config/session-strategy/opus',
        headers: USER_HEADER,
      });
      assert.equal(res.statusCode, 404);
      assert.match(res.json().error, /No runtime override/);
    });

    test('200 success deletes override and returns fallback config', async () => {
      // Pre-set an override
      await overridesModule.setRuntimeOverride('opus', { strategy: 'compress' });

      const app = await createApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/config/session-strategy/opus',
        headers: USER_HEADER,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.catId, 'opus');
      assert.equal(body.deleted, true);
      assert.notEqual(body.source, 'runtime_override');
      // Cache should be cleared
      assert.equal(overridesModule.getRuntimeOverride('opus'), undefined);
    });
  });
});
