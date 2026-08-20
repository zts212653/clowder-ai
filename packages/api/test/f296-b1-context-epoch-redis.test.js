/**
 * F296 B1: RedisContextEpochStore integration test.
 *
 * Why this file exists separately from the in-memory tests: an epoch that only
 * lives in process memory is worse than no epoch. On restart the counter would
 * restart at 1 and be REUSED — and a presentation ledger keyed by
 * (scope, epoch) would then treat already-delivered projections as fresh, or
 * revive a `hot` binding for a runtime that no longer holds that memory.
 * Iron Rule #5 (LL-048): recoverable state is persistent, TTL=0.
 *
 * Uses test Redis infrastructure (port 6398, never 6399).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Redis from 'ioredis';

const TEST_PREFIX = `test:context-epoch:${Date.now()}:`;

describe('F296 B1: RedisContextEpochStore', () => {
  /** @type {import('ioredis').default} */
  let redis;
  let store;
  let available = false;
  let connectionFailed = false;

  before(async () => {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6398';
    redis = new Redis(redisUrl, {
      keyPrefix: TEST_PREFIX,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    try {
      await redis.connect();
    } catch {
      connectionFailed = true;
      redis.disconnect();
      return; // Redis unavailable → skip
    }
    const { RedisContextEpochStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisContextEpochStore.js'
    );
    store = new RedisContextEpochStore(redis);
    available = true;
  });

  after(async () => {
    if (redis?.status === 'ready') {
      const keys = await redis.keys(`${TEST_PREFIX}*`);
      if (keys.length) {
        const pipeline = redis.multi();
        for (const key of keys) {
          pipeline.del(key.startsWith(TEST_PREFIX) ? key.slice(TEST_PREFIX.length) : key);
        }
        await pipeline.exec();
      }
      await redis.quit();
    }
  });

  it('closes the optional client when Redis is unavailable', () => {
    if (!connectionFailed) return;
    assert.equal(redis.status, 'end', 'a skipped Redis test must not leave a reconnect timer alive');
  });

  it('round-trips an epoch record', async () => {
    if (!available) return;
    await store.compareAndPut(
      {
        scopeKey: 'user-1::opus::thread-1',
        contextEpoch: 3,
        contextMode: 'hot',
        boundRuntimeSessionId: 'runtime-a',
        lastTransitionRef: 'ev:resumed',
        consumedCompactionEventIds: [],
        version: 1,
        updatedAt: 1_700_000_000_000,
      },
      0,
    );

    const read = await store.get('user-1::opus::thread-1');
    assert.equal(read.contextEpoch, 3);
    assert.equal(read.contextMode, 'hot');
    assert.equal(read.boundRuntimeSessionId, 'runtime-a');
    assert.equal(read.lastTransitionRef, 'ev:resumed');
  });

  it('persists with no expiry (Iron Rule #5)', async () => {
    if (!available) return;
    await store.compareAndPut(
      {
        scopeKey: 'user-1::opus::thread-ttl',
        contextEpoch: 1,
        contextMode: 'cold',
        lastTransitionRef: 'ev:fresh',
        consumedCompactionEventIds: [],
        version: 1,
        updatedAt: Date.now(),
      },
      0,
    );
    const ttl = await redis.ttl('context-epoch:scope:user-1::opus::thread-ttl');
    assert.equal(ttl, -1, 'epoch records must not expire');
  });

  it('a cleared binding actually disappears (fail-closed must survive the write)', async () => {
    if (!available) return;
    const scopeKey = 'user-1::opus::thread-binding';
    await store.compareAndPut(
      {
        scopeKey,
        contextEpoch: 4,
        contextMode: 'hot',
        boundRuntimeSessionId: 'runtime-a',
        lastTransitionRef: 'ev:resumed',
        consumedCompactionEventIds: [],
        version: 1,
        updatedAt: Date.now(),
      },
      0,
    );
    // unknown → fail closed → binding dropped
    await store.compareAndPut(
      {
        scopeKey,
        contextEpoch: 5,
        contextMode: 'cold',
        lastTransitionRef: 'ev:unknown',
        consumedCompactionEventIds: [],
        version: 2,
        updatedAt: Date.now(),
      },
      1,
    );

    const read = await store.get(scopeKey);
    assert.equal(read.contextEpoch, 5);
    assert.equal(
      read.boundRuntimeSessionId,
      undefined,
      'a stale binding must not linger — a later resumed claim could match it',
    );
  });

  it('the epoch survives a store instance being recreated (restart proxy)', async () => {
    if (!available) return;
    const scopeKey = 'user-1::opus::thread-restart';
    await store.compareAndPut(
      {
        scopeKey,
        contextEpoch: 9,
        contextMode: 'cold',
        lastTransitionRef: 'ev:unknown',
        consumedCompactionEventIds: [],
        version: 1,
        updatedAt: Date.now(),
      },
      0,
    );

    const { RedisContextEpochStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisContextEpochStore.js'
    );
    const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/ContextEpochOwner.js');
    const rebuilt = new ContextEpochOwner(new RedisContextEpochStore(redis));

    const next = await rebuilt.resolve({
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-restart',
      disposition: { state: 'fresh', reason: 'no_prior_session', evidenceRef: 'ev:fresh' },
    });
    assert.equal(next.contextEpoch, 10, 'a restart must continue the epoch, never reuse it');
  });

  it('B2a: a stale-version write is rejected server-side (real CAS, not TOCTOU)', async () => {
    if (!available) return;
    const scopeKey = 'user-1::opus::thread-cas';
    const base = {
      scopeKey,
      contextMode: 'cold',
      lastTransitionRef: 'ev',
      consumedCompactionEventIds: [],
      updatedAt: Date.now(),
    };
    assert.equal(await store.compareAndPut({ ...base, contextEpoch: 1, version: 1 }, 0), true);
    // Writer B still believes version 0 — must lose.
    assert.equal(await store.compareAndPut({ ...base, contextEpoch: 2, version: 1 }, 0), false);
    assert.equal((await store.get(scopeKey)).contextEpoch, 1, 'the loser must not overwrite the winner');
    // With the observed version it lands.
    assert.equal(await store.compareAndPut({ ...base, contextEpoch: 2, version: 2 }, 1), true);
    assert.equal((await store.get(scopeKey)).contextEpoch, 2);
  });

  it('B2a: two concurrent owners on one scope never share an epoch', async () => {
    if (!available) return;
    const { RedisContextEpochStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisContextEpochStore.js'
    );
    const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/ContextEpochOwner.js');
    const scope = { userId: 'user-1', catId: 'opus', threadId: 'thread-race' };
    const unknown = { state: 'unknown', reason: 'signal_unavailable', evidenceRef: 'ev:unknown' };

    // Two independent owner instances = the two real writers (invocation path
    // and PreCompact hook route), which share no process-local mutex.
    const a = new ContextEpochOwner(new RedisContextEpochStore(redis));
    const b = new ContextEpochOwner(new RedisContextEpochStore(redis));
    const [ra, rb] = await Promise.all([
      a.resolve({ ...scope, disposition: unknown }),
      b.resolve({ ...scope, disposition: unknown }),
    ]);

    assert.notEqual(ra.contextEpoch, rb.contextEpoch, 'a shared epoch would collide in the ledger key');
    assert.deepEqual(
      [ra.contextEpoch, rb.contextEpoch].sort((x, y) => x - y),
      [1, 2],
    );
  });

  it('unknown scope reads as null, not as epoch 0', async () => {
    if (!available) return;
    assert.equal(await store.get('user-1::opus::never-seen'), null);
  });
});
