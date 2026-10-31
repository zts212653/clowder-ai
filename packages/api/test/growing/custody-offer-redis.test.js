import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F310 custody offer Redis source-record CAS', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let RedisMessageStore;
  let CustodyOfferService;
  let deriveGrowingSourceMessageRevision;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F310 custody offer Redis source-record CAS');
    const [{ createRedisClient }, redisModule, serviceModule, portModule] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../../dist/domains/growing/CustodyOfferService.js'),
      import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
    ]);
    RedisMessageStore = redisModule.RedisMessageStore;
    CustodyOfferService = serviceModule.CustodyOfferService;
    deriveGrowingSourceMessageRevision = portModule.deriveGrowingSourceMessageRevision;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
    await redis.quit();
  });

  test('persists custody on the exact message hash and atomically fences concurrent dispositions', async () => {
    const firstStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const secondStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const source = await firstStore.append({
      userId: 'owner-redis',
      catId: null,
      content: 'Hold tomorrow presentation',
      contentBlocks: [{ type: 'text', text: 'Hold tomorrow presentation' }],
      mentions: [],
      timestamp: 1_788_168_400_000,
      threadId: 'thread-redis-source',
    });
    const sourceMessageRevision = deriveGrowingSourceMessageRevision(source);
    const first = new CustodyOfferService(firstStore);
    const second = new CustodyOfferService(secondStore);
    await first.recordPendingOffer({
      sourceMessageId: source.id,
      sourceMessageRevision,
      offerId: 'offer-redis',
      policyVersion: 'custody-recognition-v1',
      reasonCode: 'future_deliverable',
    });

    const [accepted, declined] = await Promise.all([
      first.acceptOffer({
        sourceMessageId: source.id,
        sourceMessageRevision,
        offerId: 'offer-redis',
        actorRef: 'user:owner-redis',
        dispositionAt: source.timestamp + 1,
        idempotencyKey: 'custody:offer-redis',
      }),
      second.refuseOffer({
        sourceMessageId: source.id,
        sourceMessageRevision,
        offerId: 'offer-redis',
        disposition: 'declined',
        actorRef: 'user:owner-redis',
        dispositionAt: source.timestamp + 1,
      }),
    ]);

    assert.equal([accepted, declined].filter((result) => result.transitioned === true).length, 1);
    const rawCustody = await redis.hget(`msg:${source.id}`, 'custodyOfferV1');
    const rawExtra = await redis.hget(`msg:${source.id}`, 'extra');
    assert.ok(rawCustody, 'custody must live on the exact source message hash');
    assert.equal(JSON.parse(rawCustody).offerId, 'offer-redis');
    assert.equal(rawExtra ? JSON.parse(rawExtra).custodyOfferV1 : undefined, undefined);

    const laterInvocation = new CustodyOfferService(new RedisMessageStore(redis, { ttlSeconds: 0 }));
    const reconstructed = await laterInvocation.readOffer(source.id);
    assert.equal(reconstructed.kind, 'found');
    assert.ok(['accepted', 'declined'].includes(reconstructed.offer.disposition));
  });

  test('updateExtra preserves custody and a changed source body invalidates a stale transition', async () => {
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const source = await store.append({
      userId: 'owner-redis',
      catId: null,
      content: 'Original delegation',
      mentions: [],
      timestamp: 1_788_168_500_000,
      threadId: 'thread-redis-stale',
    });
    const sourceMessageRevision = deriveGrowingSourceMessageRevision(source);
    const service = new CustodyOfferService(store);
    await service.recordPendingOffer({
      sourceMessageId: source.id,
      sourceMessageRevision,
      offerId: 'offer-stale',
      policyVersion: 'custody-recognition-v1',
      reasonCode: 'future_deliverable',
    });
    const pending = (await store.getById(source.id)).extra.custodyOfferV1;

    await store.updateExtra(source.id, {
      custodyOfferV1: {
        ...pending,
        disposition: 'declined',
        actorRef: 'forged',
        dispositionAt: source.timestamp + 1,
      },
      tracing: { traceId: 'trace-redis', spanId: 'span-redis' },
    });
    assert.equal((await store.getById(source.id)).extra.custodyOfferV1.disposition, 'pending');

    await redis.hset(`msg:${source.id}`, 'content', 'Concurrently changed source');
    const stale = await store.compareAndTransitionCustodyOffer(source.id, {
      expectedSourceMessageRevision: sourceMessageRevision,
      expectedOffer: pending,
      nextOffer: {
        ...pending,
        disposition: 'declined',
        actorRef: 'user:owner-redis',
        dispositionAt: source.timestamp + 2,
      },
    });
    assert.equal(stale.kind, 'source_revision_mismatch');
    assert.equal((await store.getById(source.id)).extra.custodyOfferV1.disposition, 'pending');
  });

  test('malformed dedicated custody state is not reinterpreted as an absent offer', async () => {
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const source = await store.append({
      userId: 'owner-redis',
      catId: null,
      content: 'Source with corrupted custody',
      mentions: [],
      timestamp: 1_788_168_600_000,
      threadId: 'thread-redis-corrupt',
    });
    await redis.hset(`msg:${source.id}`, 'custodyOfferV1', '{"disposition":"pending"}');
    const service = new CustodyOfferService(store);
    const read = await service.readOffer(source.id);
    const attemptedCreate = await service.recordPendingOffer({
      sourceMessageId: source.id,
      sourceMessageRevision: deriveGrowingSourceMessageRevision(source),
      offerId: 'offer-corrupt',
      policyVersion: 'custody-recognition-v1',
      reasonCode: 'future_deliverable',
    });

    assert.equal(read.kind, 'invalid_source');
    assert.equal(attemptedCreate.kind, 'invalid_source');
    assert.equal(await redis.hget(`msg:${source.id}`, 'custodyOfferV1'), '{"disposition":"pending"}');
  });
});
