import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f276-defer-receipt-lineage-test:';

const LINEAGE = {
  reflexId: 'asr-person-memory',
  reflexVersion: 1,
  opportunityId: `write_opp_${'c'.repeat(32)}`,
  dedupeLineage: `write_lineage_${'a'.repeat(32)}`,
  generation: 1,
};
const WRITE_RECEIPT = {
  v: 1,
  receiptId: `deferred_person_${'a'.repeat(32)}`,
  ...LINEAGE,
  sourceRefs: [
    {
      artifactId: 'meeting-intake-1',
      sourceRevision: `sha256:${'b'.repeat(64)}`,
      attributionRevision: `sha256:${'d'.repeat(64)}`,
      segmentStart: 0,
      segmentEnd: 128,
    },
  ],
  eligibleAt: 101,
  expiresAt: 10_000,
  rearmPredicate: 'next_eligible_owner_context_after_defer',
  destinationProposalContract: 'F276.CaptureCandidate.v1',
  state: 'deferred',
};

describe('deferred receipt carries write-opportunity lineage', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
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
    originMessageRef: { kind: 'message', threadId: 'thread-1', messageId: 'message-1' },
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
    assertRedisIsolationOrThrow(REDIS_URL, 'deferred receipt lineage');
    ({ RedisDeferredPersonMemoryReceiptStore } = await import(
      '../../dist/domains/memory/RedisDeferredPersonMemoryReceiptStore.js'
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

  it('stages a receipt carrying the write-opportunity lineage', async () => {
    const staged = await store.stage(
      stageInput({ writeOpportunityLineage: LINEAGE, writeOpportunityReceipt: WRITE_RECEIPT }),
    );
    assert.equal(staged.outcome, 'created');
    assert.deepEqual(staged.receipt.writeOpportunityLineage, LINEAGE);
    assert.deepEqual(staged.receipt.writeOpportunityReceipt, WRITE_RECEIPT);

    const reread = await store.get('owner-1', staged.receipt.receiptId);
    assert.deepEqual(reread.writeOpportunityLineage, LINEAGE);
    assert.deepEqual(reread.writeOpportunityReceipt, WRITE_RECEIPT);

    await assert.rejects(
      store.stage(
        stageInput({
          receiptId: `deferred_person_${'f'.repeat(32)}`,
          writeOpportunityLineage: LINEAGE,
          writeOpportunityReceipt: WRITE_RECEIPT,
        }),
      ),
      /write-opportunity receipt must exactly bind/,
    );
  });

  it('keeps lineage across the terminal payload purge', async () => {
    // This is the load-bearing behavior: the receipt purges subject/coordinates on reaching a
    // terminal state, but the lineage must survive -- retaining it is what proves a deferred
    // opportunity actually reached the same F276 destination (SR:126-127, SR:174-176).
    const staged = await store.stage(
      stageInput({ writeOpportunityLineage: LINEAGE, writeOpportunityReceipt: WRITE_RECEIPT }),
    );
    const withdrawn = await store.withdraw('owner-1', staged.receipt.receiptId, 500);
    assert.equal(withdrawn.outcome, 'withdrawn');
    assert.equal(withdrawn.receipt.state, 'withdrawn');

    // payload purged
    assert.equal(withdrawn.receipt.subject, undefined);
    assert.equal(withdrawn.receipt.sourceCoordinates, undefined);
    assert.equal(withdrawn.receipt.originMessageRef, undefined);
    assert.equal(withdrawn.receipt.writeOpportunityReceipt, undefined);
    // lineage survives
    assert.deepEqual(withdrawn.receipt.writeOpportunityLineage, LINEAGE);
  });

  it('still stages receipts with no lineage so the ordinary F276 defer path is unchanged', async () => {
    const staged = await store.stage(stageInput());
    assert.equal(staged.outcome, 'created');
    assert.equal(staged.receipt.writeOpportunityLineage, undefined);
    const withdrawn = await store.withdraw('owner-1', staged.receipt.receiptId, 500);
    assert.equal(withdrawn.receipt.writeOpportunityLineage, undefined);
  });

  it('does not close an attributed defer by replaying a lineage-free receipt', async () => {
    const original = await store.stage(stageInput());
    assert.equal(original.outcome, 'created');

    const attributedReplay = await store.stage(
      stageInput({ writeOpportunityLineage: LINEAGE, writeOpportunityReceipt: WRITE_RECEIPT }),
    );
    assert.equal(attributedReplay.outcome, 'conflict');

    const duplicateReceiptId = `deferred_person_${'9'.repeat(32)}`;
    const attributedDuplicate = await store.stage(
      stageInput({
        receiptId: duplicateReceiptId,
        invocationId: 'invocation-2',
        writeOpportunityLineage: LINEAGE,
        writeOpportunityReceipt: { ...WRITE_RECEIPT, receiptId: duplicateReceiptId },
      }),
    );
    assert.equal(attributedDuplicate.outcome, 'conflict');
  });

  it('promotes an attributed awaiting-confirmation receipt from a later owner confirmation', async () => {
    const awaiting = await store.stage(
      stageInput({ ready: false, writeOpportunityLineage: LINEAGE, writeOpportunityReceipt: WRITE_RECEIPT }),
    );
    assert.equal(awaiting.outcome, 'created');
    assert.equal(awaiting.receipt.state, 'awaiting_confirmation');

    const confirmed = await store.stage(
      stageInput({
        receiptId: `deferred_person_${'f'.repeat(32)}`,
        invocationId: 'owner-confirmation-invocation',
        ready: true,
        createdAt: 500,
      }),
    );
    assert.equal(confirmed.outcome, 'confirmed');
    assert.equal(confirmed.receipt.receiptId, awaiting.receipt.receiptId);
    assert.equal(confirmed.receipt.state, 'deferred');
    assert.deepEqual(confirmed.receipt.writeOpportunityLineage, LINEAGE);
    assert.deepEqual(confirmed.receipt.writeOpportunityReceipt, WRITE_RECEIPT);
  });

  it('never lets lineage smuggle transcript payload into the receipt', async () => {
    const staged = await store.stage(
      stageInput({ writeOpportunityLineage: LINEAGE, writeOpportunityReceipt: WRITE_RECEIPT }),
    );
    const serialized = JSON.stringify(staged.receipt.writeOpportunityLineage);
    assert.doesNotMatch(serialized, /黄挺|Alden|speaker/);
  });

  it('atomically replaces the claimed generation without creating a second receipt', async () => {
    const staged = await store.stage(
      stageInput({ writeOpportunityLineage: LINEAGE, writeOpportunityReceipt: WRITE_RECEIPT }),
    );
    const claimed = await store.claim({
      ownerUserId: 'owner-1',
      receiptId: staged.receipt.receiptId,
      claimId: 'claim-gen-2',
      now: 500,
      leaseMs: 1_000,
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
    });
    assert.equal(claimed.outcome, 'claimed');
    await store.bindProcessingMessage({
      ownerUserId: 'owner-1',
      receiptId: staged.receipt.receiptId,
      claimId: 'claim-gen-2',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processingMessageId: 'message-gen-2',
      now: 500,
    });
    await store.bindProcessorInvocation({
      ownerUserId: 'owner-1',
      receiptId: staged.receipt.receiptId,
      claimId: 'claim-gen-2',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processingMessageId: 'message-gen-2',
      processorInvocationId: 'invocation-gen-2',
      now: 500,
    });
    const nextLineage = { ...LINEAGE, opportunityId: `write_opp_${'9'.repeat(32)}`, generation: 2 };
    const nextReceipt = {
      ...WRITE_RECEIPT,
      ...nextLineage,
      eligibleAt: 501,
    };
    const wrongInvocation = await store.rearmWriteOpportunity({
      ownerUserId: 'owner-1',
      receiptId: staged.receipt.receiptId,
      claimId: 'claim-gen-2',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processorInvocationId: 'invocation-successor',
      dedupeHash: staged.receipt.dedupeHash,
      writeOpportunityLineage: nextLineage,
      writeOpportunityReceipt: nextReceipt,
      now: 500,
    });
    assert.equal(wrongInvocation.outcome, 'conflict');
    const expiredClaim = await store.rearmWriteOpportunity({
      ownerUserId: 'owner-1',
      receiptId: staged.receipt.receiptId,
      claimId: 'claim-gen-2',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processorInvocationId: 'invocation-gen-2',
      dedupeHash: staged.receipt.dedupeHash,
      writeOpportunityLineage: nextLineage,
      writeOpportunityReceipt: nextReceipt,
      now: 1_500,
    });
    assert.equal(expiredClaim.outcome, 'conflict');
    const result = await store.rearmWriteOpportunity({
      ownerUserId: 'owner-1',
      receiptId: staged.receipt.receiptId,
      claimId: 'claim-gen-2',
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processorInvocationId: 'invocation-gen-2',
      dedupeHash: staged.receipt.dedupeHash,
      writeOpportunityLineage: nextLineage,
      writeOpportunityReceipt: nextReceipt,
      now: 500,
    });

    assert.equal(result.outcome, 'rearmed');
    assert.equal(result.receipt.receiptId, staged.receipt.receiptId);
    assert.equal(result.receipt.state, 'deferred');
    assert.equal(result.receipt.claimId, undefined);
    assert.equal(result.receipt.writeOpportunityLineage.generation, 2);
    assert.equal(result.receipt.writeOpportunityReceipt.generation, 2);
    assert.deepEqual(
      (await store.listReady('owner-1', 8, 500)).map((receipt) => receipt.receiptId),
      [staged.receipt.receiptId],
    );
  });
});
