import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f276-deferred-person-memory-test:';

describe('RedisDeferredPersonMemoryReceiptStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisDeferredPersonMemoryReceiptStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const stageInput = (overrides = {}) => ({
    receiptId: `deferred_person_${'a'.repeat(32)}`,
    ownerUserId: 'owner-1',
    requesterCatId: 'codex-sol',
    invocationId: 'invocation-1',
    originMessageRef: { kind: 'message', threadId: 'thread-current', messageId: 'message-current' },
    subject: '黄挺',
    normalizedSubject: '黄挺',
    registryBinding: { kind: 'registered_person', ref: 'person-1' },
    sourceCoordinates: [
      {
        kind: 'message',
        sourceRef: { kind: 'message', threadId: 'thread-history', messageId: 'message-history' },
        resolvedDigest: 'b'.repeat(64),
      },
    ],
    sourceBundleDigest: 'c'.repeat(64),
    dedupeHash: 'd'.repeat(64),
    clientRequestId: 'request-1',
    ready: true,
    createdAt: 100,
    ...overrides,
  });

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisDeferredPersonMemoryReceiptStore');
    ({ RedisDeferredPersonMemoryReceiptStore } = await import(
      '../dist/domains/memory/RedisDeferredPersonMemoryReceiptStore.js'
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
    store = new RedisDeferredPersonMemoryReceiptStore(redis);
  });

  it('stages one TTL=0 owner-scoped receipt and dedupes exact delta replays', async () => {
    const first = await store.stage(stageInput());
    const replay = await store.stage(stageInput());
    const deduped = await store.stage(
      stageInput({
        receiptId: `deferred_person_${'e'.repeat(32)}`,
        invocationId: 'invocation-2',
        clientRequestId: 'request-2',
      }),
    );

    assert.equal(first.outcome, 'created');
    assert.equal(replay.outcome, 'replayed');
    assert.equal(deduped.outcome, 'deduped');
    assert.equal(deduped.receipt.receiptId, first.receipt.receiptId);
    assert.equal(await store.get('other-owner', first.receipt.receiptId), null);
    assert.equal((await store.listReady('owner-1', 10)).length, 1);
    assert.equal(await redis.ttl(store.keys.receipt('owner-1', first.receipt.receiptId)), -1);
    assert.equal(
      await redis.sismember(store.keys.binding('owner-1', 'registered_person', 'person-1'), first.receipt.receiptId),
      1,
    );
  });

  it('lists ready receipts only from the requested owner queue', async () => {
    const first = await store.stage(stageInput());
    const second = await store.stage(
      stageInput({
        receiptId: `deferred_person_${'2'.repeat(32)}`,
        ownerUserId: 'owner-2',
        invocationId: 'invocation-owner-2',
        dedupeHash: '3'.repeat(64),
      }),
    );

    assert.deepEqual(
      (await store.listReady('owner-1', 10)).map((receipt) => receipt.receiptId),
      [first.receipt.receiptId],
    );
    assert.deepEqual(
      (await store.listReady('owner-2', 10)).map((receipt) => receipt.receiptId),
      [second.receipt.receiptId],
    );
  });

  it('fences daily claims and returns expired claims to the bounded queue', async () => {
    const created = await store.stage(stageInput());
    const first = await store.claim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-1',
      now: 200,
      leaseMs: 50,
    });
    const blocked = await store.claim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-2',
      now: 220,
      leaseMs: 50,
    });
    const recovered = await store.claim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-3',
      now: 251,
      leaseMs: 50,
    });

    assert.equal(first.outcome, 'claimed');
    assert.equal(blocked.outcome, 'claimed_elsewhere');
    assert.equal(recovered.outcome, 'claimed');
    assert.equal(recovered.receipt.claimId, 'claim-3');
  });

  it('withdraws with payload purge and hard-forgets every receipt index', async () => {
    const created = await store.stage(stageInput());
    const withdrawn = await store.withdraw('owner-1', created.receipt.receiptId, 200);
    assert.equal(withdrawn.outcome, 'withdrawn');
    assert.equal(withdrawn.receipt.subject, undefined);
    assert.equal(withdrawn.receipt.sourceCoordinates, undefined);
    assert.equal(withdrawn.receipt.sourceBundleDigest, undefined);
    assert.deepEqual(await store.listReady('owner-1', 10), []);
    assert.equal(
      await redis.sismember(store.keys.binding('owner-1', 'registered_person', 'person-1'), created.receipt.receiptId),
      0,
    );
    assert.equal((await store.withdraw('other-owner', created.receipt.receiptId, 210)).outcome, 'not_available');

    assert.equal((await store.hardForget('owner-1', created.receipt.receiptId)).outcome, 'purged');
    assert.equal(await store.get('owner-1', created.receipt.receiptId), null);
    assert.equal((await store.hardForget('owner-1', created.receipt.receiptId)).outcome, 'already_absent');
  });

  it('preflights a poisoned binding index before exact receipt hard-forget mutates anything', async () => {
    const created = await store.stage(stageInput());
    const receiptId = created.receipt.receiptId;
    const bindingKey = store.keys.binding('owner-1', 'registered_person', 'person-1');
    await redis.del(bindingKey);
    await redis.hset(bindingKey, 'poisoned', 'wrong-type');

    await assert.rejects(store.hardForget('owner-1', receiptId));

    assert.notEqual(await store.get('owner-1', receiptId), null);
    assert.equal(await redis.get(store.keys.owner(receiptId)), 'owner-1');
    assert.equal(await redis.get(store.keys.dedupe('owner-1', created.receipt.dedupeHash)), `receipt:${receiptId}`);
    assert.notEqual(await redis.zscore(store.keys.ready('owner-1'), receiptId), null);
  });
});
