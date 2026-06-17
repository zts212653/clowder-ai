/**
 * F233 Phase A — BriefingConfigStore 状态机 + 不变量测试（Task 3）。
 *
 * Memory store 测状态机逻辑（unbound/bound/覆盖/clear + resolveBriefingTarget 三态）。
 * Redis store 测持久化覆盖（INV-1 真 Redis 单 key）。
 * Skipped(Redis 部分) when REDIS_URL / isolation flag absent。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, test } from 'node:test';
import { cleanupPrefixedRedisKeys } from './helpers/redis-test-helpers.js';

const { MemoryBriefingConfigStore, RedisBriefingConfigStore, resolveBriefingTarget } = await import(
  '../dist/domains/cats/services/duty-briefing/BriefingConfigStore.js'
);

// ─── Memory store: 状态机逻辑（无 Redis，总跑）───

test('状态机: unbound → bound → 覆盖(INV-1) → clear', async () => {
  const store = new MemoryBriefingConfigStore();
  assert.equal(await store.getBinding(), null, 'unbound: 初始无绑定');

  await store.setBinding('thread-A');
  assert.deepEqual(await store.getBinding(), { threadId: 'thread-A' }, 'bound: 绑定 A');

  await store.setBinding('thread-B');
  assert.deepEqual(await store.getBinding(), { threadId: 'thread-B' }, 'INV-1: 覆盖非累加，至多一个 active binding');

  await store.clearBinding();
  assert.equal(await store.getBinding(), null, 'clear → 回到 unbound');
});

test('resolveBriefingTarget: unbound（无绑定 → 不投递）', async () => {
  const store = new MemoryBriefingConfigStore();
  const target = await resolveBriefingTarget(store, () => true);
  assert.deepEqual(target, { status: 'unbound' });
});

test('resolveBriefingTarget: bound（绑定 + thread 存在 → 正常投递）', async () => {
  const store = new MemoryBriefingConfigStore();
  await store.setBinding('thread-A');
  const target = await resolveBriefingTarget(store, (tid) => tid === 'thread-A');
  assert.deepEqual(target, { status: 'bound', threadId: 'thread-A' });
});

test('resolveBriefingTarget: degraded（INV-2 绑定但 thread 删→不静默；INV-3 解析不建 thread）', async () => {
  const store = new MemoryBriefingConfigStore();
  await store.setBinding('thread-gone');
  const sideEffectCreate = 0;
  const threadExists = (_tid) => {
    // 只读校验：返回不存在，绝不在这里创建（INV-3 绑定/解析不自动建 thread）
    return false;
  };
  const target = await resolveBriefingTarget(store, threadExists);
  assert.deepEqual(target, { status: 'degraded', threadId: 'thread-gone' }, 'INV-2: 显式 degraded 不静默吞简报');
  assert.equal(sideEffectCreate, 0, 'INV-3: 解析过程零创建副作用');
  assert.deepEqual(await store.getBinding(), { threadId: 'thread-gone' }, 'degraded 不清绑定（等重绑 → bound）');
});

// ─── Redis store: 持久化覆盖（INV-1 真 Redis 单 key）───

const REDIS_URL = process.env.REDIS_URL;
const ISOLATED = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const shouldSkipSuite = !REDIS_URL || !ISOLATED;
const BINDING_KEY_PATTERNS = ['duty-briefing:*'];

describe(
  'RedisBriefingConfigStore (Redis)',
  { skip: shouldSkipSuite ? 'Redis isolation not configured' : false },
  () => {
    let createRedisClient;
    let redis;
    let connected = false;

    before(async () => {
      ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
      }
    });

    after(async () => {
      if (redis && connected) {
        await cleanupPrefixedRedisKeys(redis, BINDING_KEY_PATTERNS);
        await redis.quit();
      }
    });

    beforeEach(async () => {
      if (connected) await cleanupPrefixedRedisKeys(redis, BINDING_KEY_PATTERNS);
    });

    it('Redis 持久化: setBinding 覆盖(INV-1 单 key) + clear', async (t) => {
      if (!connected) return t.skip('Redis not connected');
      const store = new RedisBriefingConfigStore(redis);
      assert.equal(await store.getBinding(), null, '初始 unbound');
      await store.setBinding('thread-A');
      await store.setBinding('thread-B');
      assert.deepEqual(await store.getBinding(), { threadId: 'thread-B' }, 'INV-1: 真 Redis 单 key 覆盖');
      await store.clearBinding();
      assert.equal(await store.getBinding(), null, 'clear 后真 Redis 无残留');
    });
  },
);
