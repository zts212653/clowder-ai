import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f100-request-review-owner-ledger-test:';

const assetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};

function dispatchEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: 'dispatch:f266-repair-1',
    type: 'dispatch_reserved',
    occurredAt: '2026-09-12T10:00:00.000Z',
    dispatchId: 'f266-repair-1',
    proposalId: 'proposal-1',
    assetVersionRef,
    ...overrides,
  };
}

describe('F100 request-review durable owner ledger', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisRequestReviewOwnerLedger;
  let RequestReviewOwnerLedgerKeys;
  let redis;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RequestReviewOwnerLedger');
    ({ RedisRequestReviewOwnerLedger, RequestReviewOwnerLedgerKeys } = await import(
      '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.js'
    ));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  beforeEach(async () => cleanupClientKeyspace(redis));

  it('persists exact F100 refs across service restart without expiry', async () => {
    const ledger = new RedisRequestReviewOwnerLedger(redis);
    const event = dispatchEvent();
    assert.deepEqual(await ledger.append(event), { outcome: 'appended' });

    const restarted = new RedisRequestReviewOwnerLedger(redis);
    assert.deepEqual(await restarted.read(), [event]);
    assert.equal(await redis.ttl(RequestReviewOwnerLedgerKeys.events), -1);
    assert.equal(await redis.ttl(RequestReviewOwnerLedgerKeys.eventDigests), -1);
  });

  it('distinguishes exact replay from an idempotency collision', async () => {
    const ledger = new RedisRequestReviewOwnerLedger(redis);
    const event = dispatchEvent();
    assert.deepEqual(await ledger.append(event), { outcome: 'appended' });
    assert.deepEqual(await ledger.append(event), { outcome: 'duplicate' });
    assert.deepEqual(
      await ledger.append(dispatchEvent({ occurredAt: '2026-09-12T10:05:00.000Z' })),
      { outcome: 'duplicate' },
      'a crash retry must not collide merely because wall-clock time advanced',
    );
    assert.deepEqual(await ledger.append(dispatchEvent({ proposalId: 'proposal-other' })), {
      outcome: 'idempotency_collision',
    });
    assert.deepEqual(await ledger.read(), [event]);
  });

  it('linearizes conflicting terminal use facts on one reservation', async () => {
    const ledger = new RedisRequestReviewOwnerLedger(redis);
    const base = {
      schemaVersion: 1,
      eventId: 'use-terminal:reservation-1',
      type: 'use_recorded',
      occurredAt: '2026-09-12T10:05:00.000Z',
      reservationId: 'reservation-1',
      reviewMessageId: 'message-1',
      use: 'applied',
      proofRef: { ownerFeatureId: 'F100', ownerStateRef: 'request-review-use:reservation-1' },
    };
    const conflict = { ...base, reviewMessageId: 'message-2', use: 'unconfirmed' };
    const outcomes = await Promise.all([ledger.append(base), ledger.append(conflict)]);
    assert.deepEqual(outcomes.map((result) => result.outcome).sort(), ['appended', 'idempotency_collision']);
    assert.equal((await ledger.read()).length, 1);
  });
});
