import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const COMPLETE = 'invoc-index:running:v1';

describe('durable invocation running index', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisInvocationRecordStore;
  let createRedisClient;
  let redis;
  const keyPrefix = `invocation-index-${randomUUID()}:`;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'invocation running index');
    ({ RedisInvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js'
    ));
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

  async function legacy(threadId, userId = 'owner') {
    const id = `${threadId}-${userId}`;
    await redis.hset(`invoc:${id}`, {
      id,
      threadId,
      userId,
      targetCats: '["opus"]',
      status: 'running',
      createdAt: '1',
      updatedAt: '1',
    });
    return id;
  }

  async function create(store, threadId, userId = 'owner') {
    const { invocationId } = await store.create({
      threadId,
      userId,
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: randomUUID(),
      actionLeaseCarrier: { kind: 'none' },
    });
    return invocationId;
  }

  // Return a real Redis reply, then allow a canonical writer to win before the
  // reader acts on that now-stale snapshot. No timers or copied store logic.
  function afterPipelineRead(t, method, afterRead) {
    const pipeline = redis.pipeline.bind(redis);
    let armed = true;
    t.mock.method(redis, 'pipeline', (...args) => {
      const p = pipeline(...args);
      const read = p[method].bind(p);
      const exec = p.exec.bind(p);
      let observed = false;
      p[method] = (...readArgs) => {
        observed = true;
        return read(...readArgs);
      };
      p.exec = async (...execArgs) => {
        const reply = await exec(...execArgs);
        if (armed && observed) {
          armed = false;
          await afterRead();
        }
        return reply;
      };
      return p;
    });
  }

  it('a new client reuses complete legacy indexes and sees later canonical transitions without SCAN', async () => {
    const a = await legacy('legacy-a');
    const b = await legacy('legacy-b', 'other-owner');
    const first = new RedisInvocationRecordStore(redis);
    assert.deepEqual(await first.listRunningThreadIds('owner'), ['legacy-a']);
    const recent = await create(first, 'recent');
    await first.update(recent, { status: 'running' });

    const client = createRedisClient({ url: REDIS_URL, keyPrefix });
    let scans = 0;
    const scan = client.scan.bind(client);
    client.scan = (...args) => {
      scans += 1;
      return scan(...args);
    };
    try {
      const next = new RedisInvocationRecordStore(client);
      assert.deepEqual((await next.listRunningThreadIds('owner')).sort(), ['legacy-a', 'recent']);
      assert.equal((await next.listRunningByThread('legacy-a', 'owner'))[0].id, a);
      assert.equal((await next.listRunningByThread('legacy-b', 'other-owner'))[0].id, b);
      await first.reassignUserId(recent, 'other-owner');
      assert.deepEqual(await next.listRunningThreadIds('owner'), ['legacy-a']);
      assert.deepEqual((await next.listRunningThreadIds('other-owner')).sort(), ['legacy-b', 'recent']);
      await first.update(recent, { status: 'succeeded' });
      assert.deepEqual(await next.listRunningThreadIds('other-owner'), ['legacy-b']);
      assert.deepEqual(await next.listRunningByThread('recent', 'other-owner'), []);
      assert.equal(scans, 0, 'process replacement must not rescan every historical invocation');
      assert.equal(await redis.ttl(COMPLETE), -1, 'completion lasts as long as its derived indexes');
    } finally {
      await client.quit();
    }
  });

  it('a partial SADD failure cannot certify completion or hide a different legacy thread', async () => {
    const good = await legacy('good');
    const bad = await legacy('bad');
    await redis.set('invoc:running:bad:owner', 'wrong-type');
    const first = new RedisInvocationRecordStore(redis);
    await assert.rejects(first.listRunningByThread('good', 'owner'), /WRONGTYPE/);
    assert.equal(await redis.exists(COMPLETE), 0);
    await redis.del('invoc:running:bad:owner');
    assert.equal((await first.listRunningByThread('good', 'owner'))[0].id, good);
    const next = new RedisInvocationRecordStore(redis);
    assert.equal((await next.listRunningByThread('bad', 'owner'))[0].id, bad);
    assert.deepEqual((await next.listRunningThreadIds('owner')).sort(), ['bad', 'good']);
  });

  it('does not infer completion from a nonempty but partial candidate index', async () => {
    await legacy('older');
    const reader = new RedisInvocationRecordStore(redis);
    const recent = await create(reader, 'recent');
    await reader.update(recent, { status: 'running' });
    assert.deepEqual((await reader.listRunningThreadIds('owner')).sort(), ['older', 'recent']);
    assert.equal(await redis.ttl(COMPLETE), -1);
  });

  it('candidate cleanup cannot remove a thread that starts running after its empty-set read', async (t) => {
    const store = new RedisInvocationRecordStore(redis);
    const id = await create(store, 'race');
    await store.listRunningThreadIds('owner');
    await redis.sadd('invoc:running-threads:owner', 'race');
    afterPipelineRead(t, 'scard', () => store.update(id, { status: 'running' }));

    await store.listRunningThreadIds('owner');
    // Same-client command ordering drains the optional cleanup before inspection.
    await redis.ping();
    assert.deepEqual(await redis.smembers('invoc:running-threads:owner'), ['race']);
    assert.deepEqual(await store.listRunningThreadIds('owner'), ['race']);
  });

  it('record cleanup cannot remove a failed invocation that retries after its hash read', async (t) => {
    const store = new RedisInvocationRecordStore(redis);
    const id = await create(store, 'retry');
    await store.update(id, { status: 'running' });
    await store.update(id, { status: 'failed' });
    await store.listRunningThreadIds('owner');
    await redis.sadd('invoc:running:retry:owner', id);
    afterPipelineRead(t, 'hgetall', () => store.update(id, { status: 'running' }));

    await store.listRunningByThread('retry', 'owner');
    await redis.ping();
    assert.deepEqual(await redis.smembers('invoc:running:retry:owner'), [id]);
    assert.equal((await store.listRunningByThread('retry', 'owner'))[0].id, id);
  });

  it('record cleanup retains a changed unknown hash for the next authoritative read', async (t) => {
    const store = new RedisInvocationRecordStore(redis);
    const id = await create(store, 'unknown');
    await store.listRunningThreadIds('owner');
    await redis.sadd('invoc:running:unknown:owner', id);
    afterPipelineRead(t, 'hgetall', () => redis.hset(`invoc:${id}`, 'targetCats', 'invalid-json'));

    await store.listRunningByThread('unknown', 'owner');
    await redis.ping();
    assert.deepEqual(await redis.smembers('invoc:running:unknown:owner'), [id]);
    await assert.rejects(store.listRunningByThread('unknown', 'owner'), /targetCats/);
  });
});
