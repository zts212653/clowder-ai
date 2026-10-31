import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('eval-domain-override', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let createRedisClient;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL);
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
  });

  after(async () => {
    if (redis) {
      await cleanupPrefixedRedisKeys(redis, ['eval-domain:*']);
      await redis.quit();
    }
  });

  it('get returns null when no override exists', async () => {
    const { getEvalCatOverride } = await import(
      '../../dist/infrastructure/harness-eval/domain/eval-domain-override.js'
    );
    const result = await getEvalCatOverride(redis, 'eval:test-no-exist');
    assert.equal(result, null);
  });

  it('set + get round-trips the override', async () => {
    const { getEvalCatOverride, setEvalCatOverride, clearEvalCatOverride } = await import(
      '../../dist/infrastructure/harness-eval/domain/eval-domain-override.js'
    );

    const override = await setEvalCatOverride(redis, 'eval:test-roundtrip', {
      catId: 'deepseek',
      handle: '@deepseek',
      model: 'deepseek-r1',
    });
    assert.equal(override.catId, 'deepseek');
    assert.equal(override.handle, '@deepseek');
    assert.ok(override.setAt, 'setAt timestamp must be present');

    const fetched = await getEvalCatOverride(redis, 'eval:test-roundtrip');
    assert.equal(fetched.catId, 'deepseek');
    assert.equal(fetched.handle, '@deepseek');
    assert.equal(fetched.model, 'deepseek-r1');

    // cleanup
    await clearEvalCatOverride(redis, 'eval:test-roundtrip');
    const cleared = await getEvalCatOverride(redis, 'eval:test-roundtrip');
    assert.equal(cleared, null);
  });
});
