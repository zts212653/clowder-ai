/**
 * RedisSummaryStore tests
 * 有 Redis → 测全量；无 Redis → skip
 * + SummaryStoreFactory 分发测试 (always runs)
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisSummaryStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisSummaryStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisSummaryStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisSummaryStore.js');
    RedisSummaryStore = storeModule.RedisSummaryStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-summary-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisSummaryStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['summary:*', 'summaries:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['summary:*', 'summaries:*']);
  });

  it('create stores summary with JSON arrays and listByThread returns it', async () => {
    const summary = await store.create({
      threadId: 'test-thread-s1',
      topic: '讨论猫粮选择',
      conclusions: ['选择 A 品牌', '每月采购'],
      openQuestions: ['预算上限？'],
      createdBy: 'opus',
    });

    assert.ok(summary.id);
    assert.equal(summary.threadId, 'test-thread-s1');
    assert.equal(summary.topic, '讨论猫粮选择');
    assert.deepEqual(summary.conclusions, ['选择 A 品牌', '每月采购']);
    assert.deepEqual(summary.openQuestions, ['预算上限？']);

    const list = await store.listByThread('test-thread-s1');
    assert.ok(list.length >= 1);
    const found = list.find((s) => s.id === summary.id);
    assert.ok(found);
    assert.deepEqual(found.conclusions, ['选择 A 品牌', '每月采购']);
    assert.deepEqual(found.openQuestions, ['预算上限？']);
  });

  it('get returns summary by id', async () => {
    const summary = await store.create({
      threadId: 'test-thread-s2',
      topic: '架构讨论',
      conclusions: ['用 Redis'],
      openQuestions: [],
      createdBy: 'codex',
    });

    const retrieved = await store.get(summary.id);
    assert.ok(retrieved);
    assert.equal(retrieved.topic, '架构讨论');
    assert.deepEqual(retrieved.conclusions, ['用 Redis']);
    assert.deepEqual(retrieved.openQuestions, []);
  });

  it('delete removes summary', async () => {
    const summary = await store.create({
      threadId: 'test-thread-s3',
      topic: '临时纪要',
      conclusions: ['待定'],
      openQuestions: ['所有'],
      createdBy: 'user',
    });

    const deleted = await store.delete(summary.id);
    assert.equal(deleted, true);

    const retrieved = await store.get(summary.id);
    assert.equal(retrieved, null);

    const deleted2 = await store.delete('nonexistent');
    assert.equal(deleted2, false);
  });
});

describe('SummaryStoreFactory', () => {
  it('returns SummaryStore when no redis, RedisSummaryStore when redis', async () => {
    const { createSummaryStore } = await import(
      '../dist/domains/cats/services/stores/factories/SummaryStoreFactory.js'
    );
    const { SummaryStore } = await import('../dist/domains/cats/services/stores/ports/SummaryStore.js');
    const { RedisSummaryStore } = await import('../dist/domains/cats/services/stores/redis/RedisSummaryStore.js');

    const memoryStore = createSummaryStore();
    assert.ok(memoryStore instanceof SummaryStore, 'no redis → SummaryStore');

    const fakeRedis = { multi: () => ({}) };
    const redisStore = createSummaryStore(fakeRedis);
    assert.ok(redisStore instanceof RedisSummaryStore, 'redis → RedisSummaryStore');
  });
});
