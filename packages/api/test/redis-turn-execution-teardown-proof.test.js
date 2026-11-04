import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Redis from 'ioredis';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const url = process.env.REDIS_URL;
const skip = redisIsolationSkipReason(url);
const input = (invocationId) => ({
  invocationId,
  parentInvocationId: 'proof-parent',
  threadId: 'proof-thread',
  userId: 'proof-user',
  catId: 'codex',
  executionKind: 'ordinary',
  startedAt: 0,
  providerLifecycleTracked: true,
});
function client(t) {
  assertRedisIsolationOrThrow(url, 'provider-teardown-proof');
  const redis = new Redis(url, { keyPrefix: `teardown-proof:${randomUUID()}:`, maxRetriesPerRequest: 1 });
  // Every run keeps its own keys; test shutdown saves the isolated instance.
  t.after(() => redis.quit());
  return redis;
}

for (const status of ['succeeded', 'failed', 'canceled', 'interrupted'])
  test(`Redis atomically rejects ${status} without provider teardown proof`, { skip }, async (t) => {
    const redis = client(t);
    const store = new RedisTurnExecutionStore(redis);
    await store.createRunning(input('unknown'));
    await store.markProviderStarted('unknown', 0);
    await assert.rejects(
      store.transitionTerminal('unknown', { status, endedAt: 100, terminalReason: 'host_only' }),
      /provider_teardown_unconfirmed/,
    );
    assert.equal((await store.get('unknown')).status, 'running');
    assert.deepEqual(await redis.smembers('turnexec:running'), ['unknown']);
    assert.deepEqual(await redis.smembers('turnexec:response-pending'), []);
    await store.recordProviderTeardown('unknown', 0);
    assert.equal(
      (await store.transitionTerminal('unknown', { status, endedAt: 100, terminalReason: 'exact_stop' })).outcome,
      'transitioned',
    );
    assert.equal((await new RedisTurnExecutionStore(redis).get('unknown')).status, status);
  });

test('Redis fences dispatch between the preliminary record read and terminal Lua', { skip }, async (t) => {
  const redis = client(t);
  const owner = new RedisTurnExecutionStore(redis);
  await owner.createRunning(input('dispatch-race'));
  let raced = false;
  const racingRedis = new Proxy(redis, {
    get(target, key) {
      if (key === 'hgetall')
        return async (...args) => {
          const before = await target.hgetall(...args);
          if (!raced) {
            raced = true;
            await owner.markProviderStarted('dispatch-race', 0);
          }
          return before;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(
    new RedisTurnExecutionStore(racingRedis).transitionTerminal('dispatch-race', { status: 'succeeded', endedAt: 100 }),
    /provider_teardown_unconfirmed/,
  );
  assert.equal((await owner.get('dispatch-race')).status, 'running');
  assert.deepEqual(await redis.smembers('turnexec:running'), ['dispatch-race']);
});

test(
  'Redis explicit zero proof and existing terminal history remain hydratable and idempotent',
  { skip },
  async (t) => {
    const redis = client(t);
    const store = new RedisTurnExecutionStore(redis);
    await store.createRunning(input('proof'));
    await store.markProviderStarted('proof', 0);
    assert.equal(
      (await store.transitionTerminal('proof', { status: 'succeeded', endedAt: 100, providerTeardownAt: 0 })).outcome,
      'transitioned',
    );
    assert.equal((await store.get('proof')).providerTeardownAt, 0);
    await store.createRunning(input('history'));
    await store.markProviderStarted('history', 0);
    await redis.hset(
      'turnexec:record:history',
      'status',
      'failed',
      'endedAt',
      '100',
      'terminalReason',
      'legacy_failure',
    );
    assert.equal((await store.get('history')).providerTeardownAt, undefined);
    assert.equal(
      (await store.transitionTerminal('history', { status: 'succeeded', endedAt: 101 })).outcome,
      'already_terminal',
    );
    assert.equal((await store.get('history')).status, 'failed');
  },
);
