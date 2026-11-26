/**
 * Concierge Route tests (F229 PR-A1)
 * Uses lightweight Fastify injection (no real HTTP server).
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const USER_HEADER = { 'x-cat-cafe-user': 'test-user' };

describe('PUT /api/concierge/config', () => {
  let app;

  beforeEach(async () => {
    const { conciergeRoutes } = await import('../dist/routes/concierge.js');
    const { MemoryConciergeConfigStore } = await import('../dist/domains/concierge/ConciergeConfigStore.js');
    const { ConciergeThreadService } = await import('../dist/domains/concierge/ConciergeThreadService.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const conciergeConfigStore = new MemoryConciergeConfigStore();
    const threadStore = new ThreadStore();
    const conciergeThreadService = new ConciergeThreadService({ threadStore });

    app = Fastify();
    await app.register(conciergeRoutes, { conciergeConfigStore, conciergeThreadService });
  });

  it('saves the owner runtime choices it still holds', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers: { ...USER_HEADER, 'content-type': 'application/json' },
      payload: { householdReadsAllowed: false, ballPosition: { x: 4, y: 8 } },
    });
    assert.equal(res.statusCode, 200, `expected 200, got: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.config.householdReadsAllowed, false);
    assert.deepEqual(body.config.ballPosition, { x: 4, y: 8 });
  });

  it('rejects companion settings — they are official.companion plugin configuration', async () => {
    for (const payload of [{ dutyCatProfileId: 'opus' }, { personaTone: '温暖' }, { enabled: false }]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/concierge/config',
        headers: { ...USER_HEADER, 'content-type': 'application/json' },
        payload,
      });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}, got: ${res.body}`);
    }
  });

  it('returns 401 when no identity header is present (unauthenticated PUT)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers: { 'content-type': 'application/json' }, // no x-cat-cafe-user
      payload: { householdReadsAllowed: false },
    });
    assert.equal(res.statusCode, 401, `expected 401 without identity, got: ${res.body}`);
  });

  it('returns 401 for trusted-origin browser PUT without a session (R14 P1)', async () => {
    // Regression (R14 P1): resolveUserId(request, {}) still returns 'default-user' for
    // trusted-origin browser requests via resolveHeaderUserId's fallback, so the 401
    // branch is unreachable in the main UI path.
    // Fix: use resolveStrictUserId which treats any browser request without a session as 401.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers: {
        origin: 'http://localhost:3003', // trusted origin (default CORS list)
        'content-type': 'application/json',
        // no session cookie, no x-cat-cafe-user
      },
      payload: { householdReadsAllowed: false },
    });
    assert.equal(res.statusCode, 401, `expected 401 for trusted-origin browser without session, got: ${res.body}`);
  });
});

describe('POST /api/concierge/thread', () => {
  let app;

  beforeEach(async () => {
    const { conciergeRoutes } = await import('../dist/routes/concierge.js');
    const { MemoryConciergeConfigStore } = await import('../dist/domains/concierge/ConciergeConfigStore.js');
    const { ConciergeThreadService } = await import('../dist/domains/concierge/ConciergeThreadService.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const conciergeConfigStore = new MemoryConciergeConfigStore();
    const threadStore = new ThreadStore();
    const conciergeThreadService = new ConciergeThreadService({ threadStore });

    app = Fastify();
    await app.register(conciergeRoutes, { conciergeConfigStore, conciergeThreadService });
  });

  it('returns 401 when no identity header is present (unauthenticated POST)', async () => {
    // Same regression: mutation path must reject unauthenticated callers.
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/thread',
      // no x-cat-cafe-user header; POST /concierge/thread has no body
    });
    assert.equal(res.statusCode, 401, `expected 401 without identity, got: ${res.body}`);
  });

  it('creates thread for authenticated user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/thread',
      headers: { 'x-cat-cafe-user': 'authenticated-user' },
    });
    assert.equal(res.statusCode, 200, `expected 200, got: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(typeof body.threadId === 'string' && body.threadId.length > 0);
  });
});
