/**
 * RedisLabelStore tests
 * 有 Redis → 测全量；无 Redis → skip
 * + LabelStoreFactory 分发测试 (always runs)
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisLabelStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisLabelStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisLabelStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisLabelStore.js');
    RedisLabelStore = storeModule.RedisLabelStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-label-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisLabelStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['label:*', 'labels:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['label:*', 'labels:*']);
  });

  it('create + list labels', async () => {
    const label = await store.create({
      id: 'lbl_1',
      name: '开源拆解',
      color: '#5B8C5A',
      sortOrder: 0,
      createdBy: 'user1',
      createdAt: Date.now(),
    });
    assert.equal(label.name, '开源拆解');

    const labels = await store.list('user1');
    assert.equal(labels.length, 1);
    assert.equal(labels[0].id, 'lbl_1');
    assert.equal(labels[0].color, '#5B8C5A');
  });

  it('get returns label by id', async () => {
    await store.create({
      id: 'lbl_2',
      name: '日常闲聊',
      color: '#4A90D9',
      sortOrder: 1,
      createdBy: 'user1',
      createdAt: Date.now(),
    });

    const retrieved = await store.get('lbl_2');
    assert.ok(retrieved);
    assert.equal(retrieved.name, '日常闲聊');
    assert.equal(retrieved.color, '#4A90D9');
  });

  it('get returns null for non-existent label', async () => {
    const result = await store.get('nonexistent');
    assert.equal(result, null);
  });

  it('update label name and color', async () => {
    await store.create({
      id: 'lbl_3',
      name: '源码拆解',
      color: '#5B8C5A',
      sortOrder: 0,
      createdBy: 'user1',
      createdAt: Date.now(),
    });

    const updated = await store.update('lbl_3', 'user1', { name: '架构拆解', color: '#3A7D44' });
    assert.ok(updated);
    assert.equal(updated.name, '架构拆解');
    assert.equal(updated.color, '#3A7D44');
  });

  it('update sortOrder adjusts sorted set score', async () => {
    await store.create({
      id: 'lbl_a',
      name: 'First',
      color: '#111111',
      sortOrder: 0,
      createdBy: 'user2',
      createdAt: Date.now(),
    });
    await store.create({
      id: 'lbl_b',
      name: 'Second',
      color: '#222222',
      sortOrder: 1,
      createdBy: 'user2',
      createdAt: Date.now(),
    });

    await store.update('lbl_a', 'user2', { sortOrder: 2 });
    const labels = await store.list('user2');
    assert.equal(labels[0].id, 'lbl_b');
    assert.equal(labels[1].id, 'lbl_a');
  });

  it('update returns null for non-existent label', async () => {
    const result = await store.update('nonexistent', 'user1', { name: 'new' });
    assert.equal(result, null);
  });

  it('delete removes label', async () => {
    await store.create({
      id: 'lbl_4',
      name: '将被删除',
      color: '#FF0000',
      sortOrder: 0,
      createdBy: 'user1',
      createdAt: Date.now(),
    });

    const ok = await store.delete('lbl_4', 'user1');
    assert.equal(ok, true);

    const labels = await store.list('user1');
    assert.equal(labels.length, 0);

    const retrieved = await store.get('lbl_4');
    assert.equal(retrieved, null);
  });

  it('delete returns false for non-existent label', async () => {
    const ok = await store.delete('nonexistent', 'user1');
    assert.equal(ok, false);
  });

  it('list returns labels sorted by sortOrder', async () => {
    const now = Date.now();
    await store.create({ id: 'lbl_c', name: 'C', color: '#333333', sortOrder: 2, createdBy: 'user3', createdAt: now });
    await store.create({ id: 'lbl_a2', name: 'A', color: '#111111', sortOrder: 0, createdBy: 'user3', createdAt: now });
    await store.create({ id: 'lbl_b2', name: 'B', color: '#222222', sortOrder: 1, createdBy: 'user3', createdAt: now });

    const labels = await store.list('user3');
    assert.equal(labels.length, 3);
    assert.equal(labels[0].id, 'lbl_a2');
    assert.equal(labels[1].id, 'lbl_b2');
    assert.equal(labels[2].id, 'lbl_c');
  });

  it('update returns null when userId does not match createdBy', async () => {
    await store.create({
      id: 'lbl_cross_u',
      name: 'alice的',
      color: '#AA0000',
      sortOrder: 0,
      createdBy: 'alice',
      createdAt: Date.now(),
    });
    const result = await store.update('lbl_cross_u', 'bob', { name: 'hijacked' });
    assert.equal(result, null);
    const label = await store.get('lbl_cross_u');
    assert.equal(label?.name, 'alice的');
  });

  it('delete returns false when userId does not match createdBy', async () => {
    await store.create({
      id: 'lbl_cross_d',
      name: 'alice的',
      color: '#BB0000',
      sortOrder: 0,
      createdBy: 'alice',
      createdAt: Date.now(),
    });
    const ok = await store.delete('lbl_cross_d', 'bob');
    assert.equal(ok, false);
    const label = await store.get('lbl_cross_d');
    assert.ok(label, 'label should still exist');
  });

  it('list returns empty array for user with no labels', async () => {
    const labels = await store.list('no-labels-user');
    assert.deepEqual(labels, []);
  });
});

describe('LabelStoreFactory', () => {
  it('returns RedisLabelStore when redis provided', async () => {
    const { createLabelStore } = await import('../dist/domains/cats/services/stores/factories/LabelStoreFactory.js');
    const { RedisLabelStore } = await import('../dist/domains/cats/services/stores/redis/RedisLabelStore.js');

    const fakeRedis = { hset: () => {} };
    const store = createLabelStore(fakeRedis);
    assert.ok(store instanceof RedisLabelStore, 'redis → RedisLabelStore');
  });

  it('returns InMemoryLabelStore when no redis', async () => {
    const { createLabelStore } = await import('../dist/domains/cats/services/stores/factories/LabelStoreFactory.js');

    const store = createLabelStore();
    assert.ok(store, 'should return a store');
    assert.equal(typeof store.create, 'function');
    assert.equal(typeof store.list, 'function');
    assert.equal(typeof store.get, 'function');
    assert.equal(typeof store.update, 'function');
    assert.equal(typeof store.delete, 'function');
  });
});
