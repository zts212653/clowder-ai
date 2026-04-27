/**
 * F174 D2b-1 — POST /api/debug/callback-auth/hide-similar
 *
 * Owner-gated companion of GET /api/debug/callback-auth. Lets the user
 * suppress in-context surfaces for a given (reason, tool, catId) tuple
 * for 24h via the notifier's hideSimilar() method.
 *
 * Owner gating mirrors the GET endpoint: session required + session user
 * must match explicit DEFAULT_OWNER_USER_ID. Fail-closed.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

function makeNotifierStub() {
  const calls = [];
  return {
    calls,
    hideSimilar(params) {
      calls.push(params);
    },
    async notify() {
      return false;
    },
  };
}

async function buildApp({ notifier }) {
  const { registerCallbackAuthDebugRoute } = await import('../dist/routes/callback-auth-debug.js');
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const v = request.headers['x-test-session-user'];
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      request.sessionUserId = raw.trim();
    }
  });
  registerCallbackAuthDebugRoute(app, { notifier });
  await app.ready();
  return app;
}

describe('POST /api/debug/callback-auth/hide-similar (F174-D2b-1)', () => {
  let notifier;
  let app;

  beforeEach(async () => {
    notifier = makeNotifierStub();
    app = await buildApp({ notifier });
    process.env.DEFAULT_OWNER_USER_ID = 'default-user';
  });

  test('401 when no session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/hide-similar',
      payload: { reason: 'expired', tool: 't', catId: 'opus', threadId: 't1', userId: 'u1' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(notifier.calls.length, 0);
  });

  test('403 when session user is not the configured owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/hide-similar',
      headers: { 'x-test-session-user': 'someone-else' },
      payload: { reason: 'expired', tool: 't', catId: 'opus', threadId: 't1', userId: 'u1' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(notifier.calls.length, 0);
  });

  test('403 when DEFAULT_OWNER_USER_ID is not configured', async () => {
    process.env.DEFAULT_OWNER_USER_ID = '';
    const freshApp = await buildApp({ notifier });
    const res = await freshApp.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/hide-similar',
      headers: { 'x-test-session-user': 'default-user' },
      payload: { reason: 'expired', tool: 't', catId: 'opus', threadId: 't1', userId: 'u1' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(notifier.calls.length, 0);
    await freshApp.close();
  });

  test('400 when body shape is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/hide-similar',
      headers: { 'x-test-session-user': 'default-user' },
      payload: { reason: 'expired' }, // missing tool + catId
    });
    assert.equal(res.statusCode, 400);
    assert.equal(notifier.calls.length, 0);
  });

  test('200 + notifier.hideSimilar called when valid (full scoped key)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/hide-similar',
      headers: { 'x-test-session-user': 'default-user' },
      payload: {
        reason: 'expired',
        tool: 'register_pr_tracking',
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(notifier.calls.length, 1);
    assert.deepEqual(notifier.calls[0], {
      reason: 'expired',
      tool: 'register_pr_tracking',
      catId: 'opus',
      threadId: 'thread-abc',
      userId: 'user-1',
    });
  });

  test('Cloud P1 #1397: 400 when threadId is missing (full scoped key required)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/hide-similar',
      headers: { 'x-test-session-user': 'default-user' },
      payload: { reason: 'expired', tool: 't', catId: 'opus', userId: 'u1' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(notifier.calls.length, 0);
  });

  test('Cloud P1 #1397: 400 when userId is missing (full scoped key required)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/hide-similar',
      headers: { 'x-test-session-user': 'default-user' },
      payload: { reason: 'expired', tool: 't', catId: 'opus', threadId: 't1' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(notifier.calls.length, 0);
  });

  test('404 when notifier not wired (back-compat: D2b-1 not enabled)', async () => {
    const { registerCallbackAuthDebugRoute } = await import('../dist/routes/callback-auth-debug.js');
    const freshApp = Fastify();
    freshApp.addHook('preHandler', async (request) => {
      request.sessionUserId = 'default-user';
    });
    registerCallbackAuthDebugRoute(freshApp); // no notifier
    await freshApp.ready();
    const res = await freshApp.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/hide-similar',
      payload: { reason: 'expired', tool: 't', catId: 'opus', threadId: 't1', userId: 'u1' },
    });
    assert.equal(res.statusCode, 404);
    await freshApp.close();
  });
});
