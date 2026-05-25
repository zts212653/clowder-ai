/**
 * RedisRuntimeSessionStore tests
 * F211 Phase A1: Redis-backed runtime-session metadata sidecar.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function metadataFor(sessionId, overrides = {}) {
  return {
    sessionId,
    runtime: 'antigravity-desktop',
    runtimeSessionId: `cascade-${sessionId}`,
    threadId: 'thread-1',
    catId: 'antig-opus',
    userId: 'user-1',
    surface: 'cat-cafe-dispatch',
    identityHistory: [
      {
        catId: 'antig-opus',
        model: 'claude-opus-4-6',
        from: 1000,
        source: 'session_init',
      },
    ],
    lifecycle: {
      state: 'active',
      startedAt: 1000,
      lastObservedAt: 1000,
    },
    ...overrides,
  };
}

describe('RedisRuntimeSessionStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisRuntimeSessionStore;
  let RuntimeSessionKeys;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const RUNTIME_SESSION_PATTERNS = ['runtime-session:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisRuntimeSessionStore');

    const storeModule = await import('../dist/domains/cats/services/runtime-session/RedisRuntimeSessionStore.js');
    RedisRuntimeSessionStore = storeModule.RedisRuntimeSessionStore;
    const keysModule = await import('../dist/domains/cats/services/stores/redis-keys/runtime-session-keys.js');
    RuntimeSessionKeys = keysModule.RuntimeSessionKeys;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-runtime-session-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisRuntimeSessionStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, RUNTIME_SESSION_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, RUNTIME_SESSION_PATTERNS);
  });

  it('upsert persists metadata without Redis expiry', async () => {
    const saved = await store.upsert(metadataFor('session-1'));

    const byId = await store.getBySessionId('session-1');
    assert.deepEqual(byId, saved);
    assert.equal(byId.lifecycle.state, 'active');

    const ttl = await redis.ttl(RuntimeSessionKeys.detail('session-1'));
    assert.equal(ttl, -1, 'runtime-session metadata must be persistent');
  });

  it('runtime tuple lookup returns the current metadata and removes stale tuple index', async () => {
    await store.upsert(metadataFor('session-1', { runtimeSessionId: 'cascade-old' }));
    await store.upsert(metadataFor('session-1', { runtimeSessionId: 'cascade-new' }));

    assert.equal(await store.getByRuntimeSession('antigravity-desktop', 'cascade-old'), null);
    assert.equal((await store.getByRuntimeSession('antigravity-desktop', 'cascade-new')).sessionId, 'session-1');

    const staleRaw = await redis.get(RuntimeSessionKeys.byRuntime('antigravity-desktop', 'cascade-old'));
    assert.equal(staleRaw, null, 'stale runtime tuple index must be removed');
  });

  it('active thread/cat lookup returns the newest active metadata only', async () => {
    await store.upsert(
      metadataFor('session-older', {
        runtimeSessionId: 'cascade-older',
        lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 2000 },
      }),
    );
    await store.upsert(
      metadataFor('session-newer', {
        runtimeSessionId: 'cascade-newer',
        lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 3000 },
      }),
    );
    await store.upsert(
      metadataFor('session-other-cat', {
        runtimeSessionId: 'cascade-other-cat',
        catId: 'opus-47',
        lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 4000 },
      }),
    );
    await store.upsert(
      metadataFor('session-sealed-newest', {
        runtimeSessionId: 'cascade-sealed',
        lifecycle: { state: 'sealed', startedAt: 1000, lastObservedAt: 5000, sealReason: 'test' },
      }),
    );

    const active = await store.getActiveByThreadCat('antigravity-desktop', 'thread-1', 'antig-opus');

    assert.equal(active.sessionId, 'session-newer');
    assert.equal(active.runtimeSessionId, 'cascade-newer');
    assert.equal(
      (await store.getActiveByThreadCat('antigravity-desktop', 'thread-1', 'opus-47')).sessionId,
      'session-other-cat',
    );
    assert.equal(await store.getActiveByThreadCat('antigravity-desktop', 'missing-thread', 'antig-opus'), null);

    const activeRaw = await redis.get(RuntimeSessionKeys.byThreadCat('antigravity-desktop', 'thread-1', 'antig-opus'));
    assert.equal(activeRaw, 'session-newer', 'active binding index should point at newest active metadata');
  });

  it('active thread/cat index is removed when lifecycle leaves active', async () => {
    await store.upsert(metadataFor('session-1', { runtimeSessionId: 'cascade-1' }));

    assert.equal(
      (await store.getActiveByThreadCat('antigravity-desktop', 'thread-1', 'antig-opus')).sessionId,
      'session-1',
    );

    await store.updateLifecycle('session-1', {
      state: 'runtime_seal_pending',
      pendingSince: 3000,
      lastObservedAt: 3000,
    });

    assert.equal(await store.getActiveByThreadCat('antigravity-desktop', 'thread-1', 'antig-opus'), null);
    assert.equal(
      await redis.get(RuntimeSessionKeys.byThreadCat('antigravity-desktop', 'thread-1', 'antig-opus')),
      null,
    );
  });

  it('lifecycle state index moves records and orders by lastObservedAt', async () => {
    await store.upsert(
      metadataFor('session-newer', {
        lifecycle: { state: 'runtime_seal_pending', startedAt: 1000, lastObservedAt: 3000 },
      }),
    );
    await store.upsert(
      metadataFor('session-active', {
        lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 1500 },
      }),
    );
    await store.upsert(
      metadataFor('session-older', {
        lifecycle: { state: 'runtime_seal_pending', startedAt: 1000, lastObservedAt: 2000 },
      }),
    );

    await store.updateLifecycle('session-active', {
      state: 'runtime_seal_pending',
      lastObservedAt: 2500,
      pendingSince: 2500,
    });

    assert.deepEqual(
      (await store.listByLifecycleState('runtime_seal_pending')).map((entry) => entry.sessionId),
      ['session-older', 'session-active', 'session-newer'],
    );
    assert.deepEqual(await redis.zrange(RuntimeSessionKeys.byLifecycleState('active'), 0, -1), []);
  });
});
