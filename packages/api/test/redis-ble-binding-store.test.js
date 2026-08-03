import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisBleBindingStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let RedisBleBindingStore;
  let bleBindingKey;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisBleBindingStore');
    ({ RedisBleBindingStore, bleBindingKey } = await import('../dist/domains/limb/ble/BleBindingStore.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (context) => {
    if (!connected) return context.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['limb:ble:bindings:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['limb:ble:bindings:*']);
    await redis.quit();
  });

  it('persists a binding with TTL=0 semantics and rehydrates it', async () => {
    const binding = {
      bindingId: 'binding-redis',
      scopeId: 'instance',
      platformDeviceId: 'device-private',
      displayName: 'Redis Sensor',
      adapterId: 'standard.environmental',
      commands: ['ble.temperature.read'],
      nodeId: 'ble:binding-redis',
      createdAt: 100,
      lastConnectedAt: null,
    };
    const store = new RedisBleBindingStore(redis);
    await store.put(binding);

    assert.equal(await redis.ttl(bleBindingKey('instance', 'binding-redis')), -1);
    const rehydrated = new RedisBleBindingStore(redis);
    assert.deepEqual(await rehydrated.get('instance', 'binding-redis'), binding);
  });
});
