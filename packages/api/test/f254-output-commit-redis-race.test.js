import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function message(content, timestamp, overrides = {}) {
  return {
    userId: 'user-1',
    catId: null,
    content,
    mentions: [],
    timestamp,
    threadId: 'thread-1',
    ...overrides,
  };
}

describe('RedisMessageStore F254 conditional append', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let MessageKeys;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore F254 conditional append');
    const [{ createRedisClient }, { RedisMessageStore }, messageKeysModule] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../dist/domains/cats/services/stores/redis-keys/message-keys.js'),
    ]);
    MessageKeys = messageKeysModule.MessageKeys;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
      store = new RedisMessageStore(redis);
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
    await redis.quit();
  });

  it('publishes unconditionally and persists the exact pre-append raw frontier', async () => {
    const trigger = await store.append(message('question', 100));
    const queued = await store.append(message('queued information', 150, { deliveryStatus: 'queued' }));
    const candidate = message('published answer', 200, {
      catId: 'codex-sol',
      origin: 'stream',
      idempotencyKey: 'f254-published:inv-1',
    });

    const result = await store.appendAndObservePriorFrontier(candidate);

    assert.equal(result.kind, 'committed');
    assert.equal(result.priorFrontierMessageId, queued.id);
    assert.equal(result.idempotent, false);
    assert.deepEqual(result.message.extra?.freshness, {
      kind: 'scan_pending',
      priorFrontierMessageId: queued.id,
    });
    assert.equal((await store.getById(result.message.id)).content, 'published answer');
    assert.notEqual(result.priorFrontierMessageId, trigger.id);
  });

  it('idempotent unconditional replay returns the original boundary and body', async () => {
    const trigger = await store.append(message('question', 100));
    const candidate = message('first body', 200, {
      catId: 'codex-sol',
      origin: 'stream',
      idempotencyKey: 'f254-published:inv-2',
    });
    const first = await store.appendAndObservePriorFrontier(candidate);
    await store.append(message('later information', 250));

    const replay = await store.appendAndObservePriorFrontier({
      ...candidate,
      content: 'must not replace',
      timestamp: 300,
    });

    assert.equal(replay.idempotent, true);
    assert.equal(replay.message.id, first.message.id);
    assert.equal(replay.message.content, 'first body');
    assert.equal(replay.priorFrontierMessageId, trigger.id);
    assert.equal((await store.getByThread('thread-1')).filter((item) => item.catId === 'codex-sol').length, 1);
  });

  it('self-heals a dangling idempotency pointer before publishing', async () => {
    const candidate = message('recovered publish', 200, {
      catId: 'codex-sol',
      origin: 'stream',
      idempotencyKey: 'f254-published:dangling',
    });
    await redis.set(MessageKeys.idempotency('user-1', 'thread-1', candidate.idempotencyKey), 'missing-message-id');

    const result = await store.appendAndObservePriorFrontier(candidate);

    assert.equal(result.idempotent, false);
    assert.equal(result.message.content, 'recovered publish');
    assert.equal(
      await redis.get(MessageKeys.idempotency('user-1', 'thread-1', candidate.idempotencyKey)),
      result.message.id,
    );
  });

  it('linearizes compare, idempotency claim, hash, and indexes in one operation', async () => {
    const trigger = await store.append(message('question', 100));
    const racing = await store.append(message('new information', 150));
    const candidate = message('answer', 200, {
      catId: 'codex-sol',
      origin: 'stream',
      idempotencyKey: 'freshness-closure:closure-1:final',
    });

    const lost = await store.appendIfThreadFrontier(candidate, trigger.id);
    assert.deepEqual(lost, { kind: 'frontier_advanced', actualLatestMessageId: racing.id });
    assert.equal(await store.getByIdempotencyKey('user-1', 'thread-1', candidate.idempotencyKey), null);

    const won = await store.appendIfThreadFrontier(candidate, racing.id);
    assert.equal(won.kind, 'committed');
    const retry = await store.appendIfThreadFrontier({ ...candidate, content: 'duplicate' }, trigger.id);
    assert.equal(retry.kind, 'committed');
    assert.equal(retry.message.id, won.message.id);
    assert.equal((await store.getByThread('thread-1')).filter((item) => item.catId === 'codex-sol').length, 1);
  });

  it('lets only one of two different finals commit against the same frontier', async () => {
    const trigger = await store.append(message('question', 100));
    const [left, right] = await Promise.all([
      store.appendIfThreadFrontier(
        message('left', 200, {
          catId: 'codex-sol',
          origin: 'stream',
          idempotencyKey: 'closure-left',
        }),
        trigger.id,
      ),
      store.appendIfThreadFrontier(
        message('right', 200, {
          catId: 'opus48',
          origin: 'stream',
          idempotencyKey: 'closure-right',
        }),
        trigger.id,
      ),
    ]);
    assert.deepEqual([left.kind, right.kind].sort(), ['committed', 'frontier_advanced']);
  });
});
