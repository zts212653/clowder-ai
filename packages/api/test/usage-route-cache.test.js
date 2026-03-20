/**
 * Usage Route Tests — F051
 * Route-level tests for /api/usage/daily: caching, refresh, auth, user isolation.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

const ALICE = { 'x-cat-cafe-user': 'alice' };
const BOB = { 'x-cat-cafe-user': 'bob' };

describe('usage route', () => {
  /** @type {typeof import('../dist/routes/usage.js').clearUsageCache} */
  let clearUsageCache;

  let scanAllCallCount = 0;

  function makeMockStore(records = []) {
    scanAllCallCount = 0;
    return {
      create: () => ({ outcome: 'created', invocationId: 'x' }),
      get: () => null,
      update: () => null,
      getByIdempotencyKey: () => null,
      scanAll: async () => {
        scanAllCallCount++;
        return records;
      },
    };
  }

  async function buildApp(store) {
    const { default: Fastify } = await import('fastify');
    const { usageRoutes, clearUsageCache: clear } = await import('../dist/routes/usage.js');
    clearUsageCache = clear;
    const app = Fastify();
    await app.register(usageRoutes, { invocationRecordStore: store });
    await app.ready();
    return app;
  }

  afterEach(() => {
    if (clearUsageCache) clearUsageCache();
  });

  test('cached response: scanAll called once for same user', async () => {
    const store = makeMockStore([]);
    const app = await buildApp(store);

    const res1 = await app.inject({ method: 'GET', url: '/api/usage/daily', headers: ALICE });
    assert.equal(res1.statusCode, 200);
    assert.equal(scanAllCallCount, 1);

    const res2 = await app.inject({ method: 'GET', url: '/api/usage/daily', headers: ALICE });
    assert.equal(res2.statusCode, 200);
    assert.equal(scanAllCallCount, 1, 'scanAll should NOT be called again (cached)');

    await app.close();
  });

  test('refresh=1 bypasses cache', async () => {
    const store = makeMockStore([]);
    const app = await buildApp(store);

    await app.inject({ method: 'GET', url: '/api/usage/daily', headers: ALICE });
    assert.equal(scanAllCallCount, 1);

    await app.inject({ method: 'GET', url: '/api/usage/daily?refresh=1', headers: ALICE });
    assert.equal(scanAllCallCount, 2);

    await app.close();
  });

  test('different query params miss cache', async () => {
    const store = makeMockStore([]);
    const app = await buildApp(store);

    await app.inject({ method: 'GET', url: '/api/usage/daily?days=7', headers: ALICE });
    assert.equal(scanAllCallCount, 1);

    await app.inject({ method: 'GET', url: '/api/usage/daily?days=1', headers: ALICE });
    assert.equal(scanAllCallCount, 2);

    await app.close();
  });

  test('store without scanAll returns 501', async () => {
    const storeWithoutScan = {
      create: () => ({ outcome: 'created', invocationId: 'x' }),
      get: () => null,
      update: () => null,
      getByIdempotencyKey: () => null,
    };
    const app = await buildApp(storeWithoutScan);

    const res = await app.inject({ method: 'GET', url: '/api/usage/daily', headers: ALICE });
    assert.equal(res.statusCode, 501);

    await app.close();
  });

  test('user isolation: alice cannot see bob records', async () => {
    const now = Date.now();
    const records = [
      {
        id: 'inv-alice',
        threadId: 't1',
        userId: 'alice',
        userMessageId: null,
        targetCats: ['opus'],
        intent: 'execute',
        status: 'succeeded',
        idempotencyKey: 'k1',
        usageByCat: { opus: { inputTokens: 1000, outputTokens: 100 } },
        usageRecordedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'inv-bob',
        threadId: 't2',
        userId: 'bob',
        userMessageId: null,
        targetCats: ['codex'],
        intent: 'execute',
        status: 'succeeded',
        idempotencyKey: 'k2',
        usageByCat: { codex: { inputTokens: 2000, outputTokens: 200 } },
        usageRecordedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const store = makeMockStore(records);
    const app = await buildApp(store);

    const aliceRes = await app.inject({ method: 'GET', url: '/api/usage/daily', headers: ALICE });
    const aliceData = JSON.parse(aliceRes.body);
    assert.equal(aliceData.grandTotal.inputTokens, 1000, 'alice should only see her own tokens');

    clearUsageCache();

    const bobRes = await app.inject({ method: 'GET', url: '/api/usage/daily', headers: BOB });
    const bobData = JSON.parse(bobRes.body);
    assert.equal(bobData.grandTotal.inputTokens, 2000, 'bob should only see his own tokens');

    await app.close();
  });

  test('different users get separate cache entries', async () => {
    const store = makeMockStore([]);
    const app = await buildApp(store);

    await app.inject({ method: 'GET', url: '/api/usage/daily', headers: ALICE });
    assert.equal(scanAllCallCount, 1);

    // Bob's request should miss alice's cache (different userId in key)
    await app.inject({ method: 'GET', url: '/api/usage/daily', headers: BOB });
    assert.equal(scanAllCallCount, 2, 'different user should miss cache');

    await app.close();
  });

  test('no header → 401', async () => {
    const store = makeMockStore([]);
    const app = await buildApp(store);

    const res = await app.inject({ method: 'GET', url: '/api/usage/daily' });
    assert.equal(res.statusCode, 401, 'missing header should return 401');
    assert.equal(scanAllCallCount, 0, 'scanAll should NOT be called without auth');

    await app.close();
  });

  test('query param userId without header → 401 (no spoofing)', async () => {
    const store = makeMockStore([]);
    const app = await buildApp(store);

    const res = await app.inject({ method: 'GET', url: '/api/usage/daily?userId=bob' });
    assert.equal(res.statusCode, 401, 'query param userId must not bypass header auth');
    assert.equal(scanAllCallCount, 0);

    await app.close();
  });
});
