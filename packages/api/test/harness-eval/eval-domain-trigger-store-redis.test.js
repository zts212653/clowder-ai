import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Redis from 'ioredis';
import {
  EvalDomainTriggerKeys,
  RedisEvalDomainTriggerStore,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-trigger-store.js';

const redisUrl = process.env.REDIS_URL;
const isolatedRedis = redisUrl?.includes(':6398') ? describe : describe.skip;

isolatedRedis('Redis eval-domain trigger receipts (6398 isolated)', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const domainId = `eval:trigger-store-${suffix}`;
  const prefix = `f192-trigger-test:${suffix}:`;
  const windowOne = 'weekly:2026-08-23T03:00:00.000Z';
  const windowTwo = 'weekly:2026-08-30T03:00:00.000Z';
  const eventId = 'design-gate-source-map:test-twenty';
  let redis;

  before(async () => {
    redis = new Redis(redisUrl, { keyPrefix: prefix, lazyConnect: true, retryStrategy: () => null });
    await redis.connect();
  });

  after(async () => {
    await redis.del(
      EvalDomainTriggerKeys.receipt('window', domainId, windowOne),
      EvalDomainTriggerKeys.receipt('window', domainId, windowTwo),
      EvalDomainTriggerKeys.receipt('event', domainId, eventId),
      EvalDomainTriggerKeys.cooldown(domainId),
    );
    await redis.quit();
  });

  it('persists no-TTL receipts across store instances with overlap, expiry, dedupe, and cooldown CAS', async () => {
    const firstStore = new RedisEvalDomainTriggerStore(redis);
    const restartedStore = new RedisEvalDomainTriggerStore(redis);
    const nowMs = Date.parse('2026-08-24T08:00:00Z');
    const firstClaim = {
      kind: 'window',
      domainId,
      receiptId: windowOne,
      token: 'owner-one',
      nowMs,
      leaseMs: 1_000,
    };

    assert.deepEqual(await firstStore.claim(firstClaim), { outcome: 'claimed' });
    assert.deepEqual(await restartedStore.claim({ ...firstClaim, token: 'owner-two' }), { outcome: 'overlap' });
    assert.equal(
      await restartedStore.complete({
        kind: 'window',
        domainId,
        receiptId: windowOne,
        token: 'owner-one',
        channel: 'threshold_event',
        nowMs,
        cooldownUntilMs: nowMs + 24 * 60 * 60 * 1_000,
      }),
      true,
    );
    assert.deepEqual(await restartedStore.claim({ ...firstClaim, token: 'owner-three' }), { outcome: 'deduped' });
    assert.equal(await redis.ttl(EvalDomainTriggerKeys.receipt('window', domainId, windowOne)), -1);

    assert.deepEqual(
      await restartedStore.claim({
        ...firstClaim,
        receiptId: windowTwo,
        token: 'next-window',
        nowMs: nowMs + 60 * 60 * 1_000,
      }),
      { outcome: 'cooldown' },
    );
    assert.deepEqual(
      await restartedStore.claim({
        ...firstClaim,
        receiptId: windowTwo,
        token: 'late-next-window-retry',
        nowMs: nowMs + 25 * 60 * 60 * 1_000,
      }),
      { outcome: 'deduped' },
    );

    const eventClaim = {
      kind: 'event',
      domainId,
      receiptId: eventId,
      token: 'crashed-event-owner',
      nowMs,
      leaseMs: 10,
    };
    assert.deepEqual(await firstStore.claim(eventClaim), { outcome: 'claimed' });
    assert.deepEqual(await restartedStore.claim({ ...eventClaim, token: 'replay-owner', nowMs: nowMs + 11 }), {
      outcome: 'claimed',
    });
    assert.equal(
      await restartedStore.complete({
        kind: 'event',
        domainId,
        receiptId: eventId,
        token: 'replay-owner',
        channel: 'threshold_event',
        nowMs: nowMs + 11,
      }),
      true,
    );
    assert.equal(await redis.ttl(EvalDomainTriggerKeys.receipt('event', domainId, eventId)), -1);
  });
});
