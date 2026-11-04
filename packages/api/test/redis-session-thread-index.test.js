import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const COMPLETE = 'session-chain-index:by-thread:v1';

describe('session thread index survives process replacement', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisSessionChainStore;
  let createRedisClient;
  let redis;
  const keyPrefix = `session-index-${randomUUID()}:`;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'session thread index');
    ({ RedisSessionChainStore } = await import('../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js'));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
    redis = createRedisClient({ url: REDIS_URL, keyPrefix });
    await redis.ping();
  });
  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
  });
  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  async function legacy(threadId, catId = 'opus') {
    const id = `${threadId}-${catId}`;
    await redis.hset(`session:${id}`, {
      id,
      threadId,
      catId,
      userId: 'owner',
      seq: '0',
      status: 'sealed',
      messageCount: '1',
      createdAt: '1',
      updatedAt: '1',
    });
    await redis.zadd(`session-chain:${catId}:${threadId}`, 0, id);
    return id;
  }

  it('backfills every legacy chain once and a new client reads old and newly created sessions without SCAN', async () => {
    const legacyA = await legacy('old-a');
    const legacyB = await legacy('old-b', 'codex');
    const first = new RedisSessionChainStore(redis);
    const [a, b] = await Promise.all([first.getChainByThread('old-a'), first.getChainByThread('old-b')]);
    assert.equal(a[0].id, legacyA);
    assert.equal(b[0].id, legacyB);
    const created = await first.create({ threadId: 'new-thread', catId: 'codex', userId: 'owner' });

    const nextClient = createRedisClient({ url: REDIS_URL, keyPrefix });
    let scans = 0;
    const scan = nextClient.scanStream.bind(nextClient);
    nextClient.scanStream = (...args) => {
      scans += 1;
      return scan(...args);
    };
    try {
      const nextProcess = new RedisSessionChainStore(nextClient);
      assert.equal((await nextProcess.getChainByThread('old-a'))[0].id, legacyA);
      assert.equal((await nextProcess.getChainByThread('old-b'))[0].id, legacyB);
      assert.equal((await nextProcess.getChainByThread('new-thread'))[0].id, created.id);
      assert.deepEqual(await nextProcess.getChainByThread('missing'), []);
      assert.equal(scans, 0, 'a process restart must reuse the complete durable index');
      assert.equal(await redis.ttl(COMPLETE), -1, 'completion must survive idle time, like the index itself');
    } finally {
      await nextClient.quit();
    }
  });

  it('does not certify partial pipeline results or hide another thread after a backfill failure', async () => {
    const good = await legacy('good');
    const bad = await legacy('bad');
    await redis.set('session-chain-by-thread:bad', 'wrong-type');
    const first = new RedisSessionChainStore(redis);
    await assert.rejects(first.getChainByThread('good'), /WRONGTYPE/);
    assert.equal(await redis.exists(COMPLETE), 0, 'a partial index has no completion proof');

    await redis.del('session-chain-by-thread:bad');
    assert.equal((await first.getChainByThread('good'))[0].id, good);
    const restarted = new RedisSessionChainStore(redis);
    assert.equal((await restarted.getChainByThread('bad'))[0].id, bad);
  });

  it('does not infer completeness from an existing but partial per-thread index', async () => {
    const older = await legacy('mixed', 'opus');
    const first = new RedisSessionChainStore(redis);
    const recent = await first.create({ threadId: 'mixed', catId: 'codex', userId: 'owner' });
    const found = await first.getChainByThread('mixed');
    assert.deepEqual(found.map((record) => record.id).sort(), [older, recent.id].sort());
    assert.equal(await redis.ttl(COMPLETE), -1);
  });
});
