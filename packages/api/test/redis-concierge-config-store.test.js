/**
 * RedisConciergeConfigStore tests (F229 PR-A1)
 * 有 Redis → 测全量；无 Redis → skip
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisConciergeConfigStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisConciergeConfigStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisConciergeConfigStore');

    const storeModule = await import('../dist/domains/concierge/ConciergeConfigStore.js');
    RedisConciergeConfigStore = storeModule.RedisConciergeConfigStore;

    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-concierge-config.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisConciergeConfigStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['concierge:config:*', 'concierge:thread:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['concierge:config:*']);
  });

  it('get returns defaults when no config stored', async () => {
    const config = await store.get('user-1');
    assert.equal(config.ballPosition, null);
    assert.equal(config.appAssistEnabled, false);
  });

  it('put persists config and get returns it (round-trip)', async () => {
    await store.put('user-2', { ballPosition: { x: 1, y: 2 }, householdReadsAllowed: false, appAssistEnabled: true });
    const retrieved = await store.get('user-2');
    assert.deepEqual(retrieved.ballPosition, { x: 1, y: 2 });
    assert.equal(retrieved.householdReadsAllowed, false);
    assert.equal(retrieved.appAssistEnabled, true);
  });

  it('put is idempotent — second put overwrites first', async () => {
    await store.put('user-3', { ballPosition: { x: 1, y: 1 }, householdReadsAllowed: true });
    await store.put('user-3', { ballPosition: { x: 2, y: 2 }, householdReadsAllowed: false });
    const config = await store.get('user-3');
    assert.deepEqual(config.ballPosition, { x: 2, y: 2 });
    assert.equal(config.householdReadsAllowed, false);
  });

  it('config is stored with TTL=0 (persistent, no expiry)', async () => {
    await store.put('user-4', { ballPosition: null });
    // ioredis keyPrefix auto-applies; TTL=-1 means persistent
    const prefix = redis.options.keyPrefix ?? '';
    const ttl = await redis.ttl(`${prefix}concierge:config:user-4`);
    const ttlDirect = await redis.ttl('concierge:config:user-4');
    assert.ok(ttlDirect === -1 || ttl === -1, `expected TTL=-1, got direct=${ttlDirect} prefixed=${ttl}`);
  });

  it('different users have independent configs', async () => {
    await store.put('user-a', { ballPosition: { x: 1, y: 1 }, householdReadsAllowed: true });
    await store.put('user-b', { ballPosition: { x: 9, y: 9 }, householdReadsAllowed: false });
    assert.equal((await store.get('user-a')).householdReadsAllowed, true);
    assert.equal((await store.get('user-b')).householdReadsAllowed, false);
  });
});
