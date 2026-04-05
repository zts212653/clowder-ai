/**
 * Standup Route Tests — Q12 Bootcamp
 * Route-level tests for GET /api/standup/today
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const ALICE = { 'x-cat-cafe-user': 'alice' };

describe('standup route', () => {
  function todayNoon() {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    return d.getTime();
  }

  function makeMockStore(records = []) {
    return {
      create: () => ({ outcome: 'created', invocationId: 'x' }),
      get: () => null,
      update: () => null,
      getByIdempotencyKey: () => null,
      scanAll: async () => records,
    };
  }

  async function buildApp(store) {
    const { default: Fastify } = await import('fastify');
    const { standupRoutes } = await import('../dist/routes/standup.js');
    const app = Fastify();
    await app.register(standupRoutes, { invocationRecordStore: store });
    await app.ready();
    return app;
  }

  test('returns 401 without X-Cat-Cafe-User header', async () => {
    const app = await buildApp(makeMockStore());
    const res = await app.inject({ method: 'GET', url: '/api/standup/today' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('returns 501 if store has no scanAll', async () => {
    const store = { create: () => {}, get: () => null, update: () => null, getByIdempotencyKey: () => null };
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/standup/today', headers: ALICE });
    assert.equal(res.statusCode, 501);
    await app.close();
  });

  test('returns 200 with empty standup for no records', async () => {
    const app = await buildApp(makeMockStore([]));
    const res = await app.inject({ method: 'GET', url: '/api/standup/today', headers: ALICE });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.date);
    assert.deepEqual(body.cats, {});
    assert.equal(body.summary.totalInvocations, 0);
    await app.close();
  });

  test('returns standup scoped to requesting user', async () => {
    const anchor = todayNoon();
    const records = [
      {
        id: 'inv-alice',
        threadId: 'thread-1',
        userId: 'alice',
        userMessageId: null,
        targetCats: ['opus'],
        intent: 'execute',
        status: 'succeeded',
        idempotencyKey: 'key-1',
        usageByCat: { opus: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, costUsd: 0.01 } },
        usageRecordedAt: anchor,
        createdAt: anchor,
        updatedAt: anchor,
      },
      {
        id: 'inv-bob',
        threadId: 'thread-2',
        userId: 'bob',
        userMessageId: null,
        targetCats: ['codex'],
        intent: 'execute',
        status: 'succeeded',
        idempotencyKey: 'key-2',
        usageByCat: { codex: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, costUsd: 0.02 } },
        usageRecordedAt: anchor,
        createdAt: anchor,
        updatedAt: anchor,
      },
    ];

    const app = await buildApp(makeMockStore(records));
    const res = await app.inject({ method: 'GET', url: '/api/standup/today', headers: ALICE });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    // Should only see alice's invocations
    assert.equal(body.summary.totalInvocations, 1);
    assert.ok(body.cats.opus);
    assert.ok(!body.cats.codex);
    await app.close();
  });
});
