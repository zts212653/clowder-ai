import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const REVIEWED_HEAD = '6a907b316a907b316a907b316a907b316a907b31';

describe(
  'F167 legacy local-review continuation Redis cold recovery',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  () => {
    let redis;
    let connected = false;
    let RedisMessageStore;
    let RedisActionSuccessorLeaseStore;
    let InvocationQueue;
    let QueuedMessageCustodyStartupReconciler;
    let canonicalizeActionTerminalPredicate;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'F167 legacy local-review continuation Redis cold recovery');
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      ({ RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'));
      ({ RedisActionSuccessorLeaseStore } = await import(
        '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js'
      ));
      ({ InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'));
      ({ QueuedMessageCustodyStartupReconciler } = await import(
        '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js'
      ));
      ({ canonicalizeActionTerminalPredicate } = await import(
        '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
      ));
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
      await cleanupPrefixedRedisKeys(redis, ['msg:*', 'action:successor:*']);
    });

    after(async () => {
      if (!connected) return;
      await cleanupPrefixedRedisKeys(redis, ['msg:*', 'action:successor:*']);
      await redis.quit();
    });

    test('cold stores admit the exact settled decision once without another lease CAS', async () => {
      const writerMessageStore = new RedisMessageStore(redis);
      const writerLeaseStore = new RedisActionSuccessorLeaseStore(redis);
      const disposition = {
        sourceMessageId: 'review-terminal-redis-post-cas',
        leaseId: 'lease-review-redis-post-cas',
        generation: 1,
        subjectRef: 'pr:owner/repo#4074',
        reviewerCatId: 'codex-terra',
        predecessorCatId: 'codex-sol',
        reviewedHeadSha: REVIEWED_HEAD,
        verdict: 'changes_requested',
        decisionId: 'decision-review-redis-post-cas',
      };
      const decision = await writerMessageStore.append({
        userId: 'owner-f167-redis',
        catId: null,
        threadId: 'thread-author-redis',
        content: 'operator 对旧 Review 的结算选择为“需要修改”。',
        mentions: ['codex-sol'],
        timestamp: 200,
        extra: { targetCats: ['codex-sol'], legacyLocalReviewDisposition: disposition },
      });
      const predicate = canonicalizeActionTerminalPredicate({
        actionFamily: 'review',
        subjectRef: disposition.subjectRef,
        predicate: { kind: 'review_delivered', headSha: REVIEWED_HEAD },
      });
      const claimed = await writerLeaseStore.claim({
        leaseId: disposition.leaseId,
        tenantScope: 'owner-f167-redis',
        subjectRef: disposition.subjectRef,
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        holderCatIds: [disposition.reviewerCatId],
        dispatchId: 'dispatch-review-redis-post-cas',
        claimOrigin: 'structured_transfer',
        holderThreadId: 'thread-reviewer-redis',
        predecessorCatId: disposition.predecessorCatId,
        predecessorThreadId: 'thread-author-redis',
        issuerStandingEvidenceRef: 'task:review-redis-post-cas',
        evidenceRefs: ['dispatch:review-redis-post-cas'],
        terminalPredicate: predicate,
        now: 100,
      });
      assert.equal(claimed.outcome, 'claimed');
      const recovered = await writerLeaseStore.recoverLocalReviewVerdict(disposition.leaseId, {
        expectedGeneration: disposition.generation,
        reviewerCatId: disposition.reviewerCatId,
        predecessorCatId: disposition.predecessorCatId,
        predecessorThreadId: 'thread-author-redis',
        tenantScope: 'owner-f167-redis',
        headSha: REVIEWED_HEAD,
        evidenceRef: `legacy-local-review-disposition:${decision.id}:source:${disposition.sourceMessageId}:g1:changes_requested`,
        now: 220,
      });
      assert.equal(recovered.outcome, 'recovered');
      const settledLease = await writerLeaseStore.get(disposition.leaseId);

      const recoveryMessageStore = new RedisMessageStore(redis);
      const recoveryLeaseStore = new RedisActionSuccessorLeaseStore(redis);
      const invocationQueue = new InvocationQueue();
      const reconciler = new QueuedMessageCustodyStartupReconciler({
        messageStore: recoveryMessageStore,
        legacyLocalReviewDispositionLeaseStore: recoveryLeaseStore,
        invocationQueue,
        invocationRecordStore: {
          async get() {
            return null;
          },
        },
        now: () => 500,
        log: { info() {}, warn() {} },
      });

      const firstRestart = await reconciler.reconcile();
      const replay = await reconciler.reconcile();

      assert.equal(firstRestart.entriesRestored, 1);
      assert.equal(replay.entriesRestored, 0);
      const restored = invocationQueue.list('thread-author-redis', 'owner-f167-redis');
      assert.equal(restored.length, 1);
      assert.equal(restored[0].messageId, decision.id);
      assert.deepEqual(restored[0].targetCats, ['codex-sol']);
      assert.equal(restored[0].targetCats.includes('codex-terra'), false);
      const persisted = await recoveryMessageStore.getById(decision.id);
      assert.equal(persisted?.deliveryStatus, 'queued');
      assert.equal(persisted?.queueCustody?.status, 'queued');
      assert.deepEqual(await recoveryMessageStore.scanPendingLegacyLocalReviewDispositions(), []);
      assert.deepEqual(await recoveryLeaseStore.get(disposition.leaseId), settledLease);
    });
  },
);
