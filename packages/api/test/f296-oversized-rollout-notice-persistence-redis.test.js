import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function lifecycle(status) {
  return JSON.stringify({
    type: 'session_rollover_lifecycle',
    v: 1,
    rolloverId: 'inv-redis-oversized:codex-native-resume',
    status,
    reason: 'oversized_retire',
  });
}

describe('F296 oversized rollover Redis projection', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let firstStore;
  let secondStore;
  let MessageKeys;
  let persistUserFacingSystemInfoNotices;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F296 oversized rollover Redis projection');
    const [{ createRedisClient }, storeModule, keysModule, persistenceModule] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../dist/domains/cats/services/stores/redis-keys/message-keys.js'),
      import('../dist/domains/cats/services/agents/routing/persist-system-info-warnings.js'),
    ]);
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
    firstStore = new storeModule.RedisMessageStore(redis, { ttlSeconds: 0 });
    secondStore = new storeModule.RedisMessageStore(redis, { ttlSeconds: 0 });
    MessageKeys = keysModule.MessageKeys;
    persistUserFacingSystemInfoNotices = persistenceModule.persistUserFacingSystemInfoNotices;
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  after(async () => {
    if (!redis) return;
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
    await redis.quit();
  });

  it('deduplicates across store instances and keeps lifecycle messages plus claims at TTL=0', async () => {
    const pending = lifecycle('pending');
    await Promise.all([
      persistUserFacingSystemInfoNotices({
        messageStore: firstStore,
        threadId: 'thread-redis-owner',
        catId: 'codex-sol',
        contents: [pending],
      }),
      persistUserFacingSystemInfoNotices({
        messageStore: secondStore,
        threadId: 'thread-redis-owner',
        catId: 'codex-sol',
        contents: [pending],
      }),
    ]);
    await persistUserFacingSystemInfoNotices({
      messageStore: secondStore,
      threadId: 'thread-redis-owner',
      catId: 'codex-sol',
      contents: [lifecycle('succeeded')],
    });

    const messages = (await firstStore.getByThread('thread-redis-owner')).filter(
      (message) => message.source?.connector === 'session-rollover-lifecycle',
    );
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((message) => message.source.meta.sessionRollover.status),
      ['pending', 'succeeded'],
    );
    for (const message of messages) {
      assert.equal(await redis.ttl(MessageKeys.detail(message.id)), -1);
    }
    for (const status of ['pending', 'succeeded']) {
      assert.equal(
        await redis.ttl(
          MessageKeys.idempotency(
            'system',
            'thread-redis-owner',
            `session-rollover:inv-redis-oversized:codex-native-resume:${status}`,
          ),
        ),
        -1,
      );
    }
  });
});
