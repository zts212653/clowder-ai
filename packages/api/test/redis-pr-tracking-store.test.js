// @ts-check

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

let Redis;
try {
  Redis = (await import('ioredis')).default;
} catch {
  Redis = null;
}

const { RedisPrTrackingStore } = await import('../dist/infrastructure/email/RedisPrTrackingStore.js');

const REDIS_URL = process.env.REDIS_URL;
const TEST_PREFIX = 'test-pr-tracking:';

function createTestRedis() {
  if (!Redis || !REDIS_URL) return null;
  try {
    return new Redis(REDIS_URL, {
      keyPrefix: TEST_PREFIX,
      lazyConnect: true,
      retryStrategy: () => null,
    });
  } catch {
    return null;
  }
}

describe('RedisPrTrackingStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  /** @type {import('ioredis').default | null} */
  let redis;
  /** @type {InstanceType<typeof RedisPrTrackingStore> | null} */
  let store;
  let connected = false;

  beforeEach(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisPrTrackingStore');
    redis = createTestRedis();
    if (!redis) return;
    try {
      await redis.connect();
      connected = true;
    } catch {
      redis.disconnect();
      redis = null;
      connected = false;
      return;
    }
    // Clean test keys
    const keys = await redis.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) {
      const pipeline = redis.multi();
      for (const k of keys) {
        pipeline.del(k.replace(TEST_PREFIX, ''));
      }
      await pipeline.exec();
    }
    store = new RedisPrTrackingStore(/** @type {any} */ (redis), { ttlSeconds: 60 });
  });

  afterEach(async () => {
    if (redis && connected) {
      const keys = await redis.keys(`${TEST_PREFIX}*`);
      if (keys.length > 0) {
        const pipeline = redis.multi();
        for (const k of keys) {
          pipeline.del(k.replace(TEST_PREFIX, ''));
        }
        await pipeline.exec();
      }
      await redis.quit();
    }
  });

  function skipIfNoRedis() {
    if (!connected || !store) {
      return true;
    }
    return false;
  }

  it('registers and retrieves a PR entry', async () => {
    if (skipIfNoRedis()) return;

    const input = {
      repoFullName: 'zts212653/cat-cafe',
      prNumber: 42,
      catId: 'opus',
      threadId: 'thread-1',
      userId: 'user-1',
    };

    const entry = await store.register(input);
    assert.strictEqual(entry.repoFullName, 'zts212653/cat-cafe');
    assert.strictEqual(entry.prNumber, 42);
    assert.strictEqual(entry.catId, 'opus');
    assert.strictEqual(entry.threadId, 'thread-1');
    assert.strictEqual(typeof entry.registeredAt, 'number');

    const found = await store.get('zts212653/cat-cafe', 42);
    assert.ok(found);
    assert.strictEqual(found.repoFullName, 'zts212653/cat-cafe');
    assert.strictEqual(found.prNumber, 42);
    assert.strictEqual(found.catId, 'opus');
  });

  it('returns null for non-existent PR', async () => {
    if (skipIfNoRedis()) return;
    const result = await store.get('owner/repo', 999);
    assert.strictEqual(result, null);
  });

  it('overwrites existing entry for same repo+pr', async () => {
    if (skipIfNoRedis()) return;

    await store.register({
      repoFullName: 'owner/repo',
      prNumber: 10,
      catId: 'opus',
      threadId: 'thread-old',
      userId: 'user-1',
    });

    await store.register({
      repoFullName: 'owner/repo',
      prNumber: 10,
      catId: 'codex',
      threadId: 'thread-new',
      userId: 'user-2',
    });

    const found = await store.get('owner/repo', 10);
    assert.ok(found);
    assert.strictEqual(found.catId, 'codex');
    assert.strictEqual(found.threadId, 'thread-new');
  });

  it('removes a tracked PR', async () => {
    if (skipIfNoRedis()) return;

    await store.register({
      repoFullName: 'owner/repo',
      prNumber: 5,
      catId: 'opus',
      threadId: 'thread-1',
      userId: 'user-1',
    });

    const removed = await store.remove('owner/repo', 5);
    assert.strictEqual(removed, true);
    const found = await store.get('owner/repo', 5);
    assert.strictEqual(found, null);
  });

  it('returns false when removing non-existent PR', async () => {
    if (skipIfNoRedis()) return;
    const removed = await store.remove('owner/repo', 999);
    assert.strictEqual(removed, false);
  });

  it('lists all entries sorted by registeredAt descending', async () => {
    if (skipIfNoRedis()) return;

    await store.register({
      repoFullName: 'owner/repo',
      prNumber: 1,
      catId: 'opus',
      threadId: 't-1',
      userId: 'u-1',
    });

    await new Promise((r) => setTimeout(r, 10));

    await store.register({
      repoFullName: 'owner/repo',
      prNumber: 2,
      catId: 'codex',
      threadId: 't-2',
      userId: 'u-1',
    });

    const all = await store.listAll();
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].prNumber, 2);
    assert.strictEqual(all[1].prNumber, 1);
  });

  it('isolates entries by repo (same PR number, different repo)', async () => {
    if (skipIfNoRedis()) return;

    await store.register({
      repoFullName: 'owner/repo-a',
      prNumber: 1,
      catId: 'opus',
      threadId: 't-a',
      userId: 'u-1',
    });

    await store.register({
      repoFullName: 'owner/repo-b',
      prNumber: 1,
      catId: 'codex',
      threadId: 't-b',
      userId: 'u-1',
    });

    const a = await store.get('owner/repo-a', 1);
    const b = await store.get('owner/repo-b', 1);
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(a.catId, 'opus');
    assert.strictEqual(b.catId, 'codex');
  });

  it('self-heals stale sorted set members in listAll', async () => {
    if (skipIfNoRedis()) return;

    await store.register({
      repoFullName: 'owner/repo',
      prNumber: 1,
      catId: 'opus',
      threadId: 't-1',
      userId: 'u-1',
    });

    // Manually delete the hash but leave the sorted set entry
    await /** @type {any} */ (redis).del('pr-tracking:owner/repo#1');

    // listAll should return empty (hash gone) and self-heal the stale member
    const all = await store.listAll();
    assert.strictEqual(all.length, 0);

    // After self-healing, the sorted set should also be cleaned
    await new Promise((r) => setTimeout(r, 50));
    const members = await /** @type {any} */ (redis).zrange('pr-tracking:all', 0, -1);
    assert.strictEqual(members.length, 0);
  });

  it('get() self-heals stale zset member when hash expired', async () => {
    if (skipIfNoRedis()) return;

    await store.register({
      repoFullName: 'owner/repo',
      prNumber: 77,
      catId: 'opus',
      threadId: 't-1',
      userId: 'u-1',
    });

    // Manually delete hash, leaving orphan zset member
    await /** @type {any} */ (redis).del('pr-tracking:owner/repo#77');

    // get() returns null AND self-heals the zset
    const result = await store.get('owner/repo', 77);
    assert.strictEqual(result, null);

    await new Promise((r) => setTimeout(r, 50));
    const score = await /** @type {any} */ (redis).zscore('pr-tracking:all', 'owner/repo#77');
    assert.strictEqual(score, null);
  });

  it('remove() cleans zset member even when hash already expired', async () => {
    if (skipIfNoRedis()) return;

    await store.register({
      repoFullName: 'owner/repo',
      prNumber: 88,
      catId: 'opus',
      threadId: 't-1',
      userId: 'u-1',
    });

    // Manually delete hash, leaving orphan zset member
    await /** @type {any} */ (redis).del('pr-tracking:owner/repo#88');

    // Confirm zset member still exists
    const scoreBefore = await /** @type {any} */ (redis).zscore('pr-tracking:all', 'owner/repo#88');
    assert.ok(scoreBefore !== null);

    // remove() returns false (hash gone) but still cleans zset
    const removed = await store.remove('owner/repo', 88);
    assert.strictEqual(removed, false);

    const scoreAfter = await /** @type {any} */ (redis).zscore('pr-tracking:all', 'owner/repo#88');
    assert.strictEqual(scoreAfter, null);
  });

  it('survives interface contract: IPrTrackingStore compatibility', async () => {
    if (skipIfNoRedis()) return;

    assert.strictEqual(typeof store.register, 'function');
    assert.strictEqual(typeof store.get, 'function');
    assert.strictEqual(typeof store.remove, 'function');
    assert.strictEqual(typeof store.listAll, 'function');
  });
});
