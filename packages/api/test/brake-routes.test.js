/**
 * F085 Phase 6 R3 — Brake Routes auth + persistence-status tests.
 *
 * P1 regression: PUT /api/brake/settings persists to Redis with TTL=0, so it
 * must use strict identity. A trusted browser Origin WITHOUT a session used to
 * fall back to 'default-user', letting an unauthenticated browser permanently
 * rewrite the owner's brake settings.
 *
 * Also pins PERSIST_FAILED → 500 at the route level (domain test alone cannot
 * catch a route that maps every error to 400).
 *
 * Uses Fastify injection (no real HTTP server).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { ActivityTracker } = await import('../dist/domains/health/ActivityTracker.js');
const { brakeRoutes } = await import('../dist/routes/brake.js');

function createRecordingRedis() {
  const writes = [];
  return {
    writes,
    client: {
      async hgetall() {
        return {};
      },
      async hset(key, field, value) {
        writes.push([key, field, value]);
        return 1;
      },
    },
  };
}

/**
 * @param {{ redis?: object, sessionUserId?: string }} opts
 * sessionUserId is injected via header 'x-test-session-user' to simulate the
 * session-cookie hook that production installs upstream of these routes.
 */
async function createApp({ redis, failWrites = false } = {}) {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    const sessionUser = req.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      req.sessionUserId = sessionUser.trim();
    }
  });
  const client = failWrites
    ? {
        hgetall: redis.client.hgetall,
        async hset() {
          throw new Error('Redis unavailable');
        },
      }
    : redis?.client;
  const activityTracker = new ActivityTracker(client ? { redis: client } : {});
  await app.register(brakeRoutes, { activityTracker });
  return app;
}

describe('PUT /api/brake/settings — strict identity (R3 P1)', () => {
  it('trusted browser Origin WITHOUT session → 401 and zero Redis writes', async () => {
    const { writes, client } = createRecordingRedis();
    const app = await createApp({ redis: { client } });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/brake/settings',
      headers: { origin: 'http://localhost:3003', 'content-type': 'application/json' },
      payload: { enabled: true, mode: 'hardcore' },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(writes.length, 0, 'unauthenticated browser must not persist anything');
  });

  it('browser Origin WITH session → 200, persists under the session user', async () => {
    const { writes, client } = createRecordingRedis();
    const app = await createApp({ redis: { client } });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/brake/settings',
      headers: {
        origin: 'http://localhost:3003',
        'x-test-session-user': 'default-user',
        'content-type': 'application/json',
      },
      payload: { enabled: true, mode: 'hardcore' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], 'default-user');
    const persisted = JSON.parse(writes[0][2]);
    assert.equal(persisted.enabled, true);
    assert.equal(persisted.mode, 'hardcore');
  });

  it('non-browser explicit identity (X-Cat-Cafe-User) → 200 under that userId', async () => {
    const { writes, client } = createRecordingRedis();
    const app = await createApp({ redis: { client } });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/brake/settings',
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { enabled: true, thresholdMinutes: 60 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], 'alice');
  });

  it('no identity at all → 401', async () => {
    const { writes, client } = createRecordingRedis();
    const app = await createApp({ redis: { client } });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/brake/settings',
      headers: { 'content-type': 'application/json' },
      payload: { enabled: true },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(writes.length, 0);
  });
});

describe('PUT /api/brake/settings — persistence failure status (TD110)', () => {
  it('Redis write failure → 500 PERSIST_FAILED (not 400, not fake 200)', async () => {
    const { client } = createRecordingRedis();
    const app = await createApp({ redis: { client }, failWrites: true });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/brake/settings',
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { enabled: true },
    });

    assert.equal(res.statusCode, 500);
    const body = res.json();
    assert.equal(body.code, 'PERSIST_FAILED');
  });

  it('validation failure → 400', async () => {
    const { client } = createRecordingRedis();
    const app = await createApp({ redis: { client } });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/brake/settings',
      headers: { 'x-cat-cafe-user': 'alice', 'content-type': 'application/json' },
      payload: { thresholdMinutes: 10 },
    });

    assert.equal(res.statusCode, 400);
  });
});

describe('GET /api/brake/settings — lenient read preserved', () => {
  it('trusted browser Origin without session still reads default-user settings', async () => {
    const { client } = createRecordingRedis();
    const app = await createApp({ redis: { client } });

    const res = await app.inject({
      method: 'GET',
      url: '/api/brake/settings',
      headers: { origin: 'http://localhost:3003' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.enabled, false); // Phase 6 default OFF
    assert.equal(body.mode, 'gentle');
  });
});
