/**
 * CommunityRepoConfigStore Redis migration tests (F168 Phase F — F-0)
 *
 * Pre-canonicalization deployments could persist mixed-case repository names in
 * both the config hash key and the repository index. The canonical store must
 * preserve those configs, converge them to one lowercase identity, and never
 * let a stale legacy row overwrite an existing canonical row.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const INDEX_KEY = 'community:repo-configs:index';
const KEY_PATTERNS = ['community:repo-config:*', INDEX_KEY];

async function seedConfig(redis, repo, overrides = {}) {
  const now = overrides.updatedAt ?? 1_700_000_000_000;
  await redis
    .multi()
    .hmset(`community:repo-config:${repo}`, {
      repo,
      guardThreadId: overrides.guardThreadId ?? 'thread-legacy',
      guardCatId: overrides.guardCatId ?? 'opus47',
      reviewMode: overrides.reviewMode ?? 'maintainer_review',
      cloudReviewPolicy: overrides.cloudReviewPolicy ?? 'required',
      createdAt: String(overrides.createdAt ?? now - 1_000),
      updatedAt: String(now),
    })
    .sadd(INDEX_KEY, repo)
    .exec();
}

describe(
  'CommunityRepoConfigStore (Redis legacy identity migration)',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  () => {
    let RedisCommunityRepoConfigStore;
    let createRedisClient;
    let redis;
    let store;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'CommunityRepoConfigStore legacy migration');
      ({ RedisCommunityRepoConfigStore } = await import('../dist/domains/community/CommunityRepoConfigStore.js'));
      ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
      redis = createRedisClient({ url: REDIS_URL });
      await redis.ping();
      store = new RedisCommunityRepoConfigStore(redis);
    });

    after(async () => {
      if (redis) {
        await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
        await redis.quit();
      }
    });

    beforeEach(async () => {
      await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
    });

    it('reads and atomically migrates a legacy mixed-case key to canonical identity', async () => {
      await seedConfig(redis, 'Owner/Repo');

      const config = await store.getByRepo('owner/repo');

      assert.equal(config?.repo, 'owner/repo');
      assert.equal(config?.guardThreadId, 'thread-legacy');
      assert.equal(config?.reviewMode, 'maintainer_review');
      assert.equal(await redis.exists('community:repo-config:Owner/Repo'), 0);
      assert.equal(await redis.exists('community:repo-config:owner/repo'), 1);
      assert.deepStrictEqual(await redis.smembers(INDEX_KEY), ['owner/repo']);
    });

    it('preserves canonical data and removes a stale legacy duplicate', async () => {
      await seedConfig(redis, 'owner/repo', {
        guardThreadId: 'thread-canonical',
        guardCatId: 'codex-sol',
        updatedAt: 1_800_000_000_000,
      });
      await seedConfig(redis, 'Owner/Repo', {
        guardThreadId: 'thread-stale',
        updatedAt: 1_700_000_000_000,
      });

      const config = await store.getByRepo('OWNER/REPO');

      assert.equal(config?.guardThreadId, 'thread-canonical');
      assert.equal(await redis.exists('community:repo-config:Owner/Repo'), 0);

      const configs = await store.listAll();
      assert.equal(configs.length, 1);
      assert.equal(configs[0].repo, 'owner/repo');
      assert.equal(configs[0].guardThreadId, 'thread-canonical');
      assert.equal(await redis.exists('community:repo-config:Owner/Repo'), 0);
      assert.deepStrictEqual(await redis.smembers(INDEX_KEY), ['owner/repo']);
    });

    it('migrates before upsert so omitted policies and createdAt survive', async () => {
      await seedConfig(redis, 'Owner/Repo', {
        createdAt: 1_600_000_000_000,
        updatedAt: 1_700_000_000_000,
      });

      const updated = await store.upsert({
        repo: 'OWNER/REPO',
        guardThreadId: 'thread-new',
        guardCatId: 'codex-sol',
      });

      assert.equal(updated.repo, 'owner/repo');
      assert.equal(updated.createdAt, 1_600_000_000_000);
      assert.equal(updated.reviewMode, 'maintainer_review');
      assert.equal(updated.cloudReviewPolicy, 'required');
      assert.equal((await store.listAll()).length, 1);
    });

    it('deletes a config that only exists under a legacy mixed-case key', async () => {
      await seedConfig(redis, 'Owner/Repo');

      assert.equal(await store.deleteByRepo('owner/repo'), true);
      assert.equal(await redis.exists('community:repo-config:Owner/Repo'), 0);
      assert.equal(await redis.exists('community:repo-config:owner/repo'), 0);
      assert.deepStrictEqual(await redis.smembers(INDEX_KEY), []);
    });
  },
);
