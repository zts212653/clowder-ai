import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f285-pairing-test:';

describe('RedisApprovedLimbPairingPersistence', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let ApprovedLimbPairingRedisKeys;
  let LimbPairingStore;
  let RedisApprovedLimbPairingPersistence;
  let redis;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisApprovedLimbPairingPersistence');
    const persistenceModule = await import('../dist/domains/limb/ApprovedLimbPairingPersistence.js');
    ({ ApprovedLimbPairingRedisKeys, RedisApprovedLimbPairingPersistence } = persistenceModule);
    ({ LimbPairingStore } = await import('../dist/domains/limb/LimbPairingStore.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) {
      t.skip('Redis not connected');
      return;
    }
    await redis.del(ApprovedLimbPairingRedisKeys.approved);
  });

  after(async () => {
    if (!connected) return;
    await redis.del(ApprovedLimbPairingRedisKeys.approved);
    await redis.quit();
  });

  it('survives service reconstruction and keeps the approved hash at TTL=0', async () => {
    const persistence = new RedisApprovedLimbPairingPersistence(redis);
    const first = await LimbPairingStore.restore(persistence);
    const pending = first.createRequest({
      nodeId: 'stackchan-yanyan-01',
      displayName: '砚砚的小身体',
      platform: 'stackchan',
      endpointUrl: 'http://127.0.0.1:8770',
      capabilities: [{ cap: 'limb.observe.touch', commands: [], authLevel: 'free' }],
    });
    await first.approve(pending.requestId, 'user-landy');

    const restarted = await LimbPairingStore.restore(new RedisApprovedLimbPairingPersistence(redis));
    const approved = restarted.findApprovedByNodeId(pending.nodeId);

    assert.equal(approved.requestId, pending.requestId);
    assert.equal(approved.apiKey, pending.apiKey);
    assert.equal(approved.approvedByUserId, 'user-landy');
    assert.equal(await redis.ttl(ApprovedLimbPairingRedisKeys.approved), -1);
  });

  it('fails startup closed instead of hydrating corrupt Redis state', async () => {
    await redis.hset(ApprovedLimbPairingRedisKeys.approved, 'stackchan-yanyan-01', '{not-json');

    await assert.rejects(
      () => LimbPairingStore.restore(new RedisApprovedLimbPairingPersistence(redis)),
      /corrupt approved limb pairing/i,
    );
  });
});
