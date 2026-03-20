/**
 * Usage Route Cache Tests — F128
 * Route-level tests for /api/usage/daily caching and refresh=1 behavior.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

describe('usage route cache behavior', () => {
  /** @type {typeof import('../dist/routes/usage.js').clearUsageCache} */
  let clearUsageCache;

  /** Track scanAll call count */
  let scanAllCallCount = 0;

  /** Minimal store mock with scanAll that counts calls */
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

  /** Build a Fastify app with the usage route registered */
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

  test('second request within 60s returns cached (scanAll called once)', async () => {
    const store = makeMockStore([]);
    const app = await buildApp(store);

    const res1 = await app.inject({ method: 'GET', url: '/api/usage/daily' });
    assert.equal(res1.statusCode, 200);
    assert.equal(scanAllCallCount, 1);

    const res2 = await app.inject({ method: 'GET', url: '/api/usage/daily' });
    assert.equal(res2.statusCode, 200);
    assert.equal(scanAllCallCount, 1, 'scanAll should NOT be called again (cached)');

    assert.deepEqual(JSON.parse(res1.body), JSON.parse(res2.body));

    await app.close();
  });

  test('refresh=1 bypasses cache (scanAll called twice)', async () => {
    const store = makeMockStore([]);
    const app = await buildApp(store);

    await app.inject({ method: 'GET', url: '/api/usage/daily' });
    assert.equal(scanAllCallCount, 1);

    await app.inject({ method: 'GET', url: '/api/usage/daily?refresh=1' });
    assert.equal(scanAllCallCount, 2, 'scanAll should be called again with refresh=1');

    await app.close();
  });

  test('different query params bypass cache', async () => {
    const store = makeMockStore([]);
    const app = await buildApp(store);

    await app.inject({ method: 'GET', url: '/api/usage/daily?days=7' });
    assert.equal(scanAllCallCount, 1);

    await app.inject({ method: 'GET', url: '/api/usage/daily?days=1' });
    assert.equal(scanAllCallCount, 2, 'different days param should miss cache');

    await app.close();
  });

  test('store without scanAll returns 501', async () => {
    const storeWithoutScan = {
      create: () => ({ outcome: 'created', invocationId: 'x' }),
      get: () => null,
      update: () => null,
      getByIdempotencyKey: () => null,
      // no scanAll
    };
    const app = await buildApp(storeWithoutScan);

    const res = await app.inject({ method: 'GET', url: '/api/usage/daily' });
    assert.equal(res.statusCode, 501);

    await app.close();
  });
});
