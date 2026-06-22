import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisFrustrationIssueStore } from '../../dist/domains/cats/services/stores/redis/RedisFrustrationIssueStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

// F245 Phase B Task 3 — listConfirmedInWindow（F222 confirmed issue 只读全局时间窗扫描）
// 必须 Redis-backed（非 in-memory）：confirmed 索引按 user 分片 + scanStream MATCH 不自动 keyPrefix +
// ZRANGEBYSCORE 半开窗，纯 in-memory 遍历测不出这些真实行为（feedback_inmemory_store_tests_miss_redis_behavior）。
// keyPrefix 正确性由 createRedisClient 默认 'cat-cafe:' 前缀隐式守门：若 scanKeys 漏拼前缀，
// scan 命中 0 个分片 key → 跨 user 聚合返回空 → ① 直接红（红测暴露 prefix 坑）。

const REDIS_URL = process.env.REDIS_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY_PATTERNS = ['frustration-issue:*', 'frustration-issues:*'];

function input(over = {}) {
  return {
    threadId: 'th-1',
    userId: 'user-a',
    catId: 'cat-test',
    signalType: 'cli_error',
    signalDetail: { reasonCode: 'auth_failed', publicSummary: 'Auth failed' },
    context: { recentMessages: [{ role: 'user', content: 'help', timestamp: 1000 }] },
    ...over,
  };
}

describe(
  'RedisFrustrationIssueStore.listConfirmedInWindow (F245 Phase B Task 3)',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  () => {
    let redis;
    let store;
    let connected = false;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'listConfirmedInWindow');
      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
        return;
      }
      store = new RedisFrustrationIssueStore(redis);
    });

    after(async () => {
      if (redis && connected) {
        await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
        await redis.quit();
      }
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
    });

    /** Create + confirm an issue, return its confirmedAt timestamp. */
    async function seedConfirmed(over) {
      const draft = await store.create(input(over));
      const confirmed = await store.confirm({ issueId: draft.issueId });
      return { issueId: draft.issueId, confirmedAt: confirmed.confirmedAt };
    }

    it('① aggregates confirmed issues across multiple user keys (prefix dance correct)', async () => {
      const a = await seedConfirmed({ userId: 'user-a' });
      await sleep(5);
      const b = await seedConfirmed({ userId: 'user-b' });

      const got = await store.listConfirmedInWindow(a.confirmedAt, b.confirmedAt + 1);
      const ids = got.map((i) => i.issueId);

      assert.equal(got.length, 2, '跨 user-a / user-b 两个分片 key 聚合');
      assert.ok(ids.includes(a.issueId) && ids.includes(b.issueId));
      assert.ok(got.every((i) => i.status === 'confirmed'));
      // 升序 by confirmedAt
      assert.deepEqual(ids, [a.issueId, b.issueId]);
    });

    it('② half-open window: sinceMs inclusive, untilMs exclusive (by confirmedAt)', async () => {
      const a = await seedConfirmed({ userId: 'user-a' });
      await sleep(5);
      const b = await seedConfirmed({ userId: 'user-b' });
      assert.ok(b.confirmedAt > a.confirmedAt, 'confirmedAt 应严格递增（sleep 保证）');

      // [a, b) → 含 a，排除 b（上界 exclusive）
      const lower = await store.listConfirmedInWindow(a.confirmedAt, b.confirmedAt);
      assert.deepEqual(
        lower.map((i) => i.issueId),
        [a.issueId],
      );

      // [b, b+1) → 含 b，排除 a（下界把 a 排除）
      const upper = await store.listConfirmedInWindow(b.confirmedAt, b.confirmedAt + 1);
      assert.deepEqual(
        upper.map((i) => i.issueId),
        [b.issueId],
      );

      // [a, a) → 空（since==until 半开为空）
      assert.deepEqual(await store.listConfirmedInWindow(a.confirmedAt, a.confirmedAt), []);
    });

    it('③ excludes draft issues (reads confirmed index only, not all issues)', async () => {
      const confirmed = await seedConfirmed({ userId: 'user-a' });
      await store.create(input({ userId: 'user-a' })); // draft, never confirmed

      const got = await store.listConfirmedInWindow(confirmed.confirmedAt, confirmed.confirmedAt + 1);
      assert.deepEqual(
        got.map((i) => i.issueId),
        [confirmed.issueId],
        'draft 不进 confirmed 窗口',
      );
    });

    it('④ empty result when no confirmed issues fall in window', async () => {
      const a = await seedConfirmed({ userId: 'user-a' });
      // window entirely before a.confirmedAt
      assert.deepEqual(await store.listConfirmedInWindow(a.confirmedAt - 100_000, a.confirmedAt - 1), []);
      // no issues at all after cleanup
      await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
      const now = Date.now();
      assert.deepEqual(await store.listConfirmedInWindow(now - 60_000, now + 60_000), []);
    });
  },
);
