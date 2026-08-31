import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const SKIP = redisIsolationSkipReason(REDIS_URL);
const KEY_PREFIX = 'cat-cafe-f308-thread-progress-test:';
let redis;
let RedisThreadProgressReceiptStore;

before(async () => {
  if (SKIP) return;
  assertRedisIsolationOrThrow(REDIS_URL, 'f308-thread-progress-receipts');
  const [{ createRedisClient }, storeModule] = await Promise.all([
    import('@cat-cafe/shared/utils'),
    import('../dist/domains/thread-progress/RedisThreadProgressReceiptStore.js'),
  ]);
  RedisThreadProgressReceiptStore = storeModule.RedisThreadProgressReceiptStore;
  redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
  await cleanupClientKeyspace(redis);
});

afterEach(async () => {
  if (redis) await cleanupClientKeyspace(redis);
});

after(async () => {
  if (redis) await redis.quit();
});

describe('RedisThreadProgressReceiptStore', { skip: SKIP }, () => {
  test('concurrent replays create one persistent first-writer receipt', async () => {
    const store = new RedisThreadProgressReceiptStore(redis);
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      v: 1,
      id: `receipt-${index}`,
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      kind: 'completed',
      impactAxes: ['verified_outcome'],
      actor: { kind: 'cat', catId: 'opus' },
      headline: `candidate-${index}`,
      provenance: [{ kind: 'task', taskId: 'task-1' }],
      sourceKey: 'same-terminal-source-key',
      occurredAt: 100 + index,
      createdAt: 100 + index,
    }));

    const results = await Promise.all(candidates.map((candidate) => store.appendIfAbsent(candidate)));
    const winners = results.filter((result) => result.inserted);
    assert.equal(winners.length, 1);
    assert.equal(new Set(results.map((result) => result.receipt.id)).size, 1);
    const listed = await store.listByThread('user-1', 'thread-1');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, winners[0].receipt.id);
    assert.equal(await redis.pttl(`thread-progress:receipt:${listed[0].id}`), -1);
    assert.equal(await redis.pttl('thread-progress:source:same-terminal-source-key'), -1);
    assert.equal(await redis.pttl('thread-progress:thread:user-1:thread-1'), -1);
  });

  test('one terminal turn cannot create a second receipt by changing kind', async () => {
    const store = new RedisThreadProgressReceiptStore(redis);
    const base = {
      v: 1,
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      impactAxes: ['goal_or_scope'],
      actor: { kind: 'cat', catId: 'opus' },
      provenance: [{ kind: 'invocation', invocationId: 'turn-1' }],
      occurredAt: 100,
      createdAt: 100,
    };
    const first = await store.appendIfAbsent(
      { ...base, id: 'decision-1', kind: 'decision', headline: '决定范围', sourceKey: 'decision-source' },
      { terminalTurnKey: 'terminal-turn-1' },
    );
    const second = await store.appendIfAbsent(
      { ...base, id: 'milestone-1', kind: 'milestone', headline: '重复里程碑', sourceKey: 'milestone-source' },
      { terminalTurnKey: 'terminal-turn-1' },
    );

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.receipt.id, first.receipt.id);
    assert.equal((await store.listByThread('user-1', 'thread-1')).length, 1);
  });
});
