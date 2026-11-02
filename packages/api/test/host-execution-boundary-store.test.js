import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Redis from 'ioredis';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { RedisSessionChainStore } from '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const input = { catId: 'codex', threadId: 'boundary-thread', userId: 'boundary-owner' };
const boundary = {
  v: 1,
  clientId: 'openai',
  carrier: 'test_stream',
  implementationKey: 'test:boundary',
  implementationGeneration: 'generation-1',
  accountRef: null,
  workspaceRoot: '/workspace',
  projectRoot: '/workspace',
};
const redisUrl = process.env.REDIS_URL;

for (const backend of ['memory', 'redis']) {
  const options = backend === 'redis' ? { skip: redisIsolationSkipReason(redisUrl) } : {};
  function create(t) {
    if (backend === 'memory') return new SessionChainStore();
    assertRedisIsolationOrThrow(redisUrl, 'host-execution-boundary');
    const redis = new Redis(redisUrl, { keyPrefix: `execution-boundary:${randomUUID()}:`, maxRetriesPerRequest: 1 });
    t.after(() => redis.quit()); // Retain test-owned keys; the instance owner saves all data at shutdown.
    return new RedisSessionChainStore(redis);
  }

  test(`${backend}: selected boundary round-trips, ignores key order and cannot be overwritten`, options, async (t) => {
    const store = create(t);
    const record = await store.create(input);
    assert.ok(await store.bindHostExecutionBoundary(record.id, undefined, boundary));
    assert.deepEqual((await store.get(record.id)).hostExecutionBoundary, boundary);
    const reordered = Object.fromEntries(Object.entries(boundary).reverse());
    assert.ok(await store.bindHostExecutionBoundary(record.id, undefined, reordered));
    assert.equal(
      await store.bindHostExecutionBoundary(record.id, undefined, { ...boundary, clientId: 'google' }),
      null,
    );
    assert.equal((await store.get(record.id)).hostExecutionBoundary.clientId, 'openai');
  });

  test(`${backend}: legacy native history cannot be certified from today's expectation`, options, async (t) => {
    const store = create(t);
    const record = await store.create({ ...input, cliSessionId: 'unknown-native' });
    assert.equal(await store.bindHostExecutionBoundary(record.id, 'unknown-native', boundary), null);
    assert.equal((await store.get(record.id)).hostExecutionBoundary, undefined);
  });

  test(`${backend}: stale runtime, inactive and displaced logical owners are rejected`, options, async (t) => {
    const store = create(t);
    const record = await store.create(input);
    await store.bindHostExecutionBoundary(record.id, undefined, boundary);
    await store.bindCliSessionId(record.id, 'native-1');
    assert.equal(await store.bindHostExecutionBoundary(record.id, undefined, boundary), null);
    assert.ok(await store.bindHostExecutionBoundary(record.id, 'native-1', boundary));
    await store.create(input);
    assert.equal(await store.bindHostExecutionBoundary(record.id, 'native-1', boundary), null);
    await store.update(record.id, { status: 'sealed' });
    assert.equal(await store.bindHostExecutionBoundary(record.id, 'native-1', boundary), null);
  });

  test(`${backend}: two conflicting owners cannot both publish their boundary`, options, async (t) => {
    const store = create(t);
    const record = await store.create(input);
    const results = await Promise.all([
      store.bindHostExecutionBoundary(record.id, undefined, boundary),
      store.bindHostExecutionBoundary(record.id, undefined, { ...boundary, accountRef: 'other-account' }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual((await store.get(record.id)).hostExecutionBoundary, boundary);
  });

  test(`${backend}: one-shot scoped executions cannot acquire an ordinary resume binding`, options, async (t) => {
    const store = create(t);
    const record = await store.create({
      ...input,
      scopedInvocation: {
        invocationId: 'one-shot',
        originMessageId: 'origin',
        executionScope: 'collective-participation',
      },
    });
    assert.equal(await store.bindHostExecutionBoundary(record.id, undefined, boundary), null);
  });
}

test(
  'Redis rejects a stale active owner changed after its preliminary read',
  {
    skip: redisIsolationSkipReason(redisUrl),
  },
  async (t) => {
    assertRedisIsolationOrThrow(redisUrl, 'host-execution-boundary-cas');
    const redis = new Redis(redisUrl, {
      keyPrefix: `execution-boundary-race:${randomUUID()}:`,
      maxRetriesPerRequest: 1,
    });
    t.after(() => redis.quit());
    const owner = new RedisSessionChainStore(redis);
    const old = await owner.create(input);
    let raced = false;
    const racingRedis = new Proxy(redis, {
      get(target, key) {
        if (key === 'hgetall')
          return async (...args) => {
            const before = await target.hgetall(...args);
            if (!raced) {
              raced = true;
              await owner.create(input);
            }
            return before;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    assert.equal(
      await new RedisSessionChainStore(racingRedis).bindHostExecutionBoundary(old.id, undefined, boundary),
      null,
    );
    assert.equal((await owner.get(old.id)).hostExecutionBoundary, undefined);
  },
);
