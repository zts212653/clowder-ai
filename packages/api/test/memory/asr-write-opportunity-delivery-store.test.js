import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f276-write-opportunity-delivery-test:';
const LINEAGE = `write_lineage_${'a'.repeat(32)}`;
const OPPORTUNITY = `write_opp_${'c'.repeat(32)}`;

describe('RedisWriteOpportunityDeliveryStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisWriteOpportunityDeliveryStore;
  let validateWriteOpportunityRef;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const record = (overrides = {}) => ({
    v: 1,
    opportunityId: OPPORTUNITY,
    dedupeLineage: LINEAGE,
    generation: 1,
    reflexId: 'asr-person-memory',
    reflexVersion: 1,
    ownerUserId: 'owner-1',
    threadId: 'thread-1',
    consumerCatId: 'codex-sol',
    invocationId: 'invocation-1',
    eligibleAt: 1_000,
    expiresAt: 9_000,
    rearmPredicate: 'next_eligible_owner_context_after_defer',
    destinationProposalContract: 'F276.CaptureCandidate.v1',
    sourceRefs: [
      {
        artifactId: 'meeting-intake-1',
        sourceRevision: `sha256:${'b'.repeat(64)}`,
        attributionRevision: `sha256:${'d'.repeat(64)}`,
        segmentStart: 0,
        segmentEnd: 128,
      },
    ],
    presentedAt: 1_500,
    generationId: `sha256:${'e'.repeat(64)}`,
    evidenceRef: `context-delivery:invocation-1:sha256:${'e'.repeat(64)}`,
    continuityDispositionRef: 'continuity:invocation-1',
    ...overrides,
  });

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisWriteOpportunityDeliveryStore');
    ({ RedisWriteOpportunityDeliveryStore } = await import(
      '../../dist/domains/memory/people/RedisWriteOpportunityDeliveryStore.js'
    ));
    ({ validateWriteOpportunityRef } = await import(
      '../../dist/domains/memory/people/WriteOpportunityDeliveryStore.js'
    ));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    store = new RedisWriteOpportunityDeliveryStore(redis);
  });

  const validate = async (ref, ctx = {}) =>
    validateWriteOpportunityRef({
      ref,
      record: await store.get(ctx.ownerUserId ?? 'owner-1', ref.opportunityId),
      ownerUserId: ctx.ownerUserId ?? 'owner-1',
      invocationId: ctx.invocationId ?? 'invocation-1',
      now: ctx.now ?? 2_000,
    });

  it('round-trips a delivered record and validates a matching ref', async () => {
    await store.recordDelivered(record());
    const result = await validate({ opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 });
    assert.equal(result.status, 'valid');
    assert.equal(result.record.invocationId, 'invocation-1');
    assert.deepEqual(await store.listInvocationOpportunityIds('owner-1', 'invocation-1'), [OPPORTUNITY]);
    assert.deepEqual(await store.listInvocationOpportunityIds('owner-1', 'invocation-other'), []);
  });

  it('stores delivery evidence with no TTL', async () => {
    await store.recordDelivered(record());
    const keys = await redis.keys('*write-opportunity-delivered:*');
    assert.ok(keys.length >= 1);
    for (const key of keys) {
      const bare = key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key;
      assert.equal(await redis.pttl(bare), -1);
    }
  });

  it('rejects a ref for an opportunity that was never delivered', async () => {
    const result = await validate({
      opportunityId: `write_opp_${'f'.repeat(32)}`,
      dedupeLineage: LINEAGE,
      generation: 1,
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'unknown_opportunity');
  });

  it('rejects a ref replayed from a different invocation', async () => {
    await store.recordDelivered(record());
    const result = await validate(
      { opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 },
      { invocationId: 'invocation-2' },
    );
    assert.equal(result.reason, 'invocation_mismatch');
  });

  it('rejects a forged ref pointing at another owner lineage', async () => {
    await store.recordDelivered(record());
    const result = await validate(
      { opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 },
      { ownerUserId: 'owner-2' },
    );
    // Another owner cannot even read the record, so it fails closed as unknown.
    assert.equal(result.reason, 'unknown_opportunity');
  });

  it('rejects lineage and generation drift', async () => {
    await store.recordDelivered(record());
    const lineageDrift = await validate({
      opportunityId: OPPORTUNITY,
      dedupeLineage: `write_lineage_${'9'.repeat(32)}`,
      generation: 1,
    });
    assert.equal(lineageDrift.reason, 'lineage_mismatch');
    const generationDrift = await validate({
      opportunityId: OPPORTUNITY,
      dedupeLineage: LINEAGE,
      generation: 2,
    });
    assert.equal(generationDrift.reason, 'generation_mismatch');
  });

  it('rejects a disposition that arrives after expiry', async () => {
    await store.recordDelivered(record());
    const result = await validate(
      { opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 },
      { now: 9_000 },
    );
    assert.equal(result.reason, 'expired');
  });

  it('is idempotent, safely rebinds an absent attempt, and refuses immutable source drift', async () => {
    await store.recordDelivered(record());
    await store.recordDelivered(record());
    assert.equal((await store.get('owner-1', OPPORTUNITY)).generationId, `sha256:${'e'.repeat(64)}`);

    await store.recordDelivered(
      record({
        invocationId: 'invocation-2',
        presentedAt: 1_600,
        generationId: `sha256:${'1'.repeat(64)}`,
        evidenceRef: `context-delivery:invocation-2:sha256:${'1'.repeat(64)}`,
        continuityDispositionRef: 'continuity:invocation-2',
      }),
    );
    assert.equal((await store.get('owner-1', OPPORTUNITY)).invocationId, 'invocation-2');
    assert.deepEqual(await store.listInvocationOpportunityIds('owner-1', 'invocation-1'), []);
    assert.deepEqual(await store.listInvocationOpportunityIds('owner-1', 'invocation-2'), [OPPORTUNITY]);
    assert.equal(
      (
        await validate(
          { opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 },
          { invocationId: 'invocation-1' },
        )
      ).reason,
      'invocation_mismatch',
    );

    await assert.rejects(
      () =>
        store.recordDelivered(
          record({
            invocationId: 'invocation-3',
            sourceRefs: [{ ...record().sourceRefs[0], sourceRevision: `sha256:${'9'.repeat(64)}` }],
          }),
        ),
      /delivered_record_conflict/,
    );
    assert.equal((await store.get('owner-1', OPPORTUNITY)).invocationId, 'invocation-2');
  });

  it('purges every generation of a lineage so an invalidated lineage cannot be dispositioned', async () => {
    const second = `write_opp_${'2'.repeat(32)}`;
    await store.recordDelivered(record());
    await store.recordDelivered(record({ opportunityId: second, generation: 2 }));

    const purged = await store.purgeLineage('owner-1', LINEAGE);
    assert.equal(purged, 2);
    assert.equal(await store.get('owner-1', OPPORTUNITY), null);
    assert.equal(await store.get('owner-1', second), null);
    assert.deepEqual(await store.listInvocationOpportunityIds('owner-1', 'invocation-1'), []);
  });
});
