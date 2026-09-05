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
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
    });
    assert.equal(
      (
        await store.bindProcessingMessage({
          ownerUserId: 'owner-1',
          receiptId: created.receipt.receiptId,
          claimId: 'claim-1',
          processorCatId: 'codex-terra',
          processingThreadId: 'thread_memory_operations',
          processingMessageId: 'message-daily-a',
          now: 201,
        })
      ).outcome,
      'bound',
    );
    assert.equal(
      (
        await store.bindProcessorInvocation({
          ownerUserId: 'owner-1',
          receiptId: created.receipt.receiptId,
          claimId: 'claim-1',
          processorCatId: 'codex-terra',
          processingThreadId: 'thread_memory_operations',
          processingMessageId: 'message-daily-a',
          processorInvocationId: 'invocation-daily-a',
          now: 202,
        })
      ).outcome,
      'bound',
    );
    assert.equal(
      (
        await store.bindProcessorInvocation({
          ownerUserId: 'owner-1',
          receiptId: created.receipt.receiptId,
          claimId: 'claim-1',
          processorCatId: 'codex-terra',
          processingThreadId: 'thread_memory_operations',
          processingMessageId: 'message-daily-a',
          processorInvocationId: 'invocation-successor',
          now: 203,
        })
      ).outcome,
      'conflict',
    );
    const blocked = await store.claim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-2',
      now: 220,
      leaseMs: 50,
      processorCatId: 'codex-sol',
      processingThreadId: 'thread_memory_operations',
    });
    const recovered = await store.claim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-3',
      now: 251,
      leaseMs: 50,
      processorCatId: 'codex-sol',
      processingThreadId: 'thread_memory_operations',
    });

    assert.equal(first.outcome, 'claimed');
    assert.equal(blocked.outcome, 'claimed_elsewhere');
    assert.equal(recovered.outcome, 'claimed');
    assert.equal(recovered.receipt.claimId, 'claim-3');
    assert.equal(recovered.receipt.processorCatId, 'codex-sol');
    assert.equal(recovered.receipt.processingThreadId, 'thread_memory_operations');
    assert.equal(recovered.receipt.processingMessageId, undefined);
    assert.equal(recovered.receipt.processorInvocationId, undefined);
  });

  it('disposes only the exact live processor grant and terminalizes stale attempts', async () => {
    const created = await store.stage(stageInput());
    const claimed = await store.claim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-disposition',
      now: 200,
      leaseMs: 50,
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
    });
    assert.equal(claimed.outcome, 'claimed');
    await store.bindProcessingMessage({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-disposition',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processingMessageId: 'message-disposition',
      now: 201,
    });
    await store.bindProcessorInvocation({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-disposition',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processingMessageId: 'message-disposition',
      processorInvocationId: 'invocation-disposition',
      now: 202,
    });

    const wrongProcessor = await store.disposeClaim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-disposition',
      processorCatId: 'codex-sol',
      processingThreadId: 'thread_memory_operations',
      processorInvocationId: 'invocation-disposition',
      disposition: 'insufficient_evidence',
      now: 220,
    });
    assert.equal(wrongProcessor.outcome, 'conflict');
    const wrongInvocation = await store.disposeClaim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-disposition',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processorInvocationId: 'invocation-successor',
      disposition: 'insufficient_evidence',
      now: 220,
    });
    assert.equal(wrongInvocation.outcome, 'conflict');

    const expired = await store.expireClaim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-disposition',
      now: 251,
    });
    assert.equal(expired.outcome, 'not_actionable');
    assert.equal(expired.receipt.resolution, 'unresolved_after_clerk_attempt');
    assert.equal(expired.receipt.subject, undefined);
    assert.deepEqual(await store.listReady('owner-1', 10, 251), []);
    const duplicate = await store.stage(
      stageInput({ receiptId: `deferred_person_${'6'.repeat(32)}`, invocationId: 'later-capture' }),
    );
    assert.equal(duplicate.outcome, 'deduped');
    assert.equal(duplicate.receipt.receiptId, created.receipt.receiptId);
    assert.equal(duplicate.receipt.state, 'not_actionable');
  });

  it('moves a live claim to awaiting confirmation without leaving a processor lease', async () => {
    const created = await store.stage(stageInput());
    await store.claim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-confirmation',
      now: 200,
      leaseMs: 100,
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
    });
    await store.bindProcessingMessage({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-confirmation',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processingMessageId: 'message-confirmation',
      now: 201,
    });
    await store.bindProcessorInvocation({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-confirmation',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processingMessageId: 'message-confirmation',
      processorInvocationId: 'invocation-confirmation',
      now: 202,
    });
    const disposed = await store.disposeClaim({
      ownerUserId: 'owner-1',
      receiptId: created.receipt.receiptId,
      claimId: 'claim-confirmation',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processorInvocationId: 'invocation-confirmation',
      disposition: 'awaiting_confirmation',
      now: 220,
    });
    assert.equal(disposed.outcome, 'awaiting_confirmation');
    assert.equal(disposed.receipt.claimId, undefined);
    assert.equal(disposed.receipt.processorCatId, undefined);
    assert.deepEqual(await store.listReady('owner-1', 10, 220), []);
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
