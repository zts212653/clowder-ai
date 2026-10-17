import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { InMemoryFrustrationIssueStore } from '../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js';
import { RedisFrustrationIssueStore } from '../dist/domains/cats/services/stores/redis/RedisFrustrationIssueStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

for (const backend of ['memory', 'redis']) {
  test(`${backend} source CAS checks Host cancellation before its atomic write`, async (t) => {
    let redis;
    if (backend === 'redis') {
      const skip = redisIsolationSkipReason(process.env.REDIS_URL);
      if (skip) return t.skip(skip);
      assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F202 source cancellation');
      redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f202-source-current-${randomUUID()}:` });
      t.after(() => redis.quit());
      await redis.ping();
    }
    const store = redis ? new RedisFrustrationIssueStore(redis) : new InMemoryFrustrationIssueStore();
    const created = await store.create({
      userId: 'owner',
      threadId: 'thread',
      catId: 'cat-test',
      signalType: 'cli_error',
      signalDetail: {},
      context: { recentMessages: [] },
    });
    await store.confirm({ issueId: created.issueId });
    const source = await store.getById(created.issueId);
    let active = backend === 'redis';
    if (redis) {
      const read = redis.hgetall.bind(redis);
      redis.hgetall = async (...args) => {
        const result = await read(...args);
        active = false;
        return result;
      };
    }
    await assert.rejects(
      () =>
        store.compareAndSetCommunityIssueDraft(
          { issueId: source.issueId, expectedSource: source, expectedDraftId: null, draftId: 'D', allowReplace: false },
          async () => {
            if (!active) throw Error('source authority expired');
          },
        ),
      /source authority expired/,
    );
    assert.equal((await store.getById(source.issueId)).communityIssueDraftId, undefined);
  });
}
