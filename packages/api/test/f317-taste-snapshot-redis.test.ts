import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { SessionMutex } from '../src/domains/cats/services/agents/invocation/SessionMutex.js';
import {
  type ApproveTasteProposalDeps,
  approveTasteProposal,
} from '../src/domains/taste/services/approveTasteProposal.js';
import { RedisTasteDecisionAuthority } from '../src/domains/taste/services/RedisTasteDecisionAuthority.js';
import { tasteDecisionSnapshot } from '../src/domains/taste/services/taste-decision-snapshot.js';
import { FencedRedisTasteProposalStore } from '../src/domains/taste/stores/redis/FencedRedisTasteProposalStore.js';
import { RedisTasteProposalStore } from '../src/domains/taste/stores/redis/RedisTasteProposalStore.js';
import { TasteProposalKeys } from '../src/domains/taste/stores/redis-keys/taste-proposal-keys.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

test(
  'F221 Redis decision CAS checks content and anchor in the same pending transition',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F317 taste snapshot');
    const redis = createRedisClient({ url: process.env.REDIS_URL!, keyPrefix: `f317-taste-snapshot:${randomUUID()}:` });
    try {
      const store = new RedisTasteProposalStore(redis);
      const create = () =>
        store.create({
          userId: 'owner',
          catId: 'codex',
          threadId: 'home',
          scene: '原场景',
          quote: '原话',
          tags: ['留白'],
          dimension: 'visual-quality',
          privacy: 'sensitive',
        });
      const approve = await create();
      const reject = await create();
      for (const proposal of [approve, reject])
        await store.commitEnvelope(proposal.id, {
          canonicalProposalId: proposal.id,
          sourceFeatureId: 'F221',
          ownerUserId: 'owner',
          requesterCatId: 'codex',
          originRef: { kind: 'message', threadId: 'home', messageId: 'source-1' },
          approvalCardRef: { threadId: 'home', messageId: `card-${proposal.id}` },
          createdAt: proposal.createdAt,
        });
      const approveSnapshot = tasteDecisionSnapshot((await store.get(approve.id))!)!;
      const rejectSnapshot = tasteDecisionSnapshot((await store.get(reject.id))!)!;
      const key = TasteProposalKeys.detail(approve.id);
      const originalGet = store.get.bind(store);
      let mutateOnRead = true;
      store.get = async (id) => {
        const seen = await originalGet(id);
        if (id === approve.id && mutateOnRead) {
          mutateOnRead = false;
          await redis.hset(key, 'quote', '并发改过的原话');
        }
        return seen;
      };
      assert.equal(await store.claimForApproval(approve.id, 'owner', approveSnapshot), null);
      store.get = originalGet;
      assert.equal((await store.get(approve.id))!.status, 'pending');
      await redis.hset(key, 'quote', '原话');
      const results = await Promise.all([
        store.claimForApproval(approve.id, 'owner', approveSnapshot),
        store.claimForApproval(approve.id, 'owner', approveSnapshot),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
      const rejectKey = TasteProposalKeys.detail(reject.id);
      mutateOnRead = true;
      store.get = async (id) => {
        const seen = await originalGet(id);
        if (id === reject.id && mutateOnRead) {
          mutateOnRead = false;
          await redis.hset(
            rejectKey,
            'publication',
            JSON.stringify({ state: 'legacy_unanchored', classifiedAt: Date.now() }),
          );
        }
        return seen;
      };
      assert.equal(await store.markRejected(reject.id, '不合适', 'owner', rejectSnapshot), null);
      store.get = originalGet;
      assert.equal((await store.get(reject.id))!.status, 'pending');
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);

test(
  'F221 candidate approval cannot start a vignette after its durable authority was revoked',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F317 fenced approval');
    const redis = createRedisClient({
      url: process.env.REDIS_URL!,
      keyPrefix: `f317-fenced-approval:${randomUUID()}:`,
    });
    try {
      const store = new FencedRedisTasteProposalStore(redis);
      const authority = new RedisTasteDecisionAuthority(redis);
      const proposal = await store.create({
        userId: 'owner',
        catId: 'codex',
        threadId: 'home',
        scene: '原场景',
        quote: '原话',
        tags: ['留白'],
        dimension: 'visual-quality',
        privacy: 'sensitive',
      });
      await store.commitEnvelope(proposal.id, {
        canonicalProposalId: proposal.id,
        sourceFeatureId: 'F221',
        ownerUserId: 'owner',
        requesterCatId: 'codex',
        originRef: { kind: 'message', threadId: 'home', messageId: 'source-1' },
        approvalCardRef: { threadId: 'home', messageId: 'card-1' },
        createdAt: proposal.createdAt,
      });
      const snapshot = tasteDecisionSnapshot((await store.get(proposal.id))!)!;
      const decisionFence = await authority.issue('owner', proposal.id);
      assert.equal(await authority.revoke(decisionFence), true);
      let writes = 0;
      const deps = {
        store,
        lock: new SessionMutex(),
        lockKey: () => 'f221-fenced-candidate',
        expectedSnapshot: snapshot,
        decisionFence,
        writeVignette: async () => {
          writes++;
          return { slug: 'must-not-write', path: 'docs/taste/vignettes/must-not-write.md' };
        },
      } as ApproveTasteProposalDeps & { decisionFence: typeof decisionFence };
      const result = await approveTasteProposal(proposal.id, 'owner', deps);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'claim_lost');
      assert.equal((await store.get(proposal.id))?.status, 'pending');
      assert.equal(writes, 0);
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);

test(
  'F221 fenced approval refuses a takeaway changed after preview before starting the writer',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F317 takeaway decision fence');
    const redis = createRedisClient({
      url: process.env.REDIS_URL!,
      keyPrefix: `f317-takeaway-fence:${randomUUID()}:`,
    });
    try {
      const store = new FencedRedisTasteProposalStore(redis);
      const authority = new RedisTasteDecisionAuthority(redis);
      const proposal = await store.create({
        userId: 'owner',
        catId: 'codex',
        threadId: 'home',
        scene: '原场景',
        quote: '原话',
        takeaway: 'ORIGINAL',
        tags: ['留白'],
        dimension: 'visual-quality',
        privacy: 'sensitive',
      });
      await store.commitEnvelope(proposal.id, {
        canonicalProposalId: proposal.id,
        sourceFeatureId: 'F221',
        ownerUserId: 'owner',
        requesterCatId: 'codex',
        originRef: { kind: 'message', threadId: 'home', messageId: 'source-1' },
        approvalCardRef: { threadId: 'home', messageId: 'card-1' },
        createdAt: proposal.createdAt,
      });
      const snapshot = tasteDecisionSnapshot((await store.get(proposal.id))!)!;
      const decisionFence = await authority.issue('owner', proposal.id);
      const read = store.get.bind(store);
      let reads = 0;
      store.get = async (id) => {
        const seen = await read(id);
        if (id === proposal.id && ++reads === 3)
          await redis.hset(TasteProposalKeys.detail(id), 'takeaway', 'MUTATED AFTER PREVIEW');
        return seen;
      };
      let writes = 0;
      const result = await approveTasteProposal(proposal.id, 'owner', {
        store,
        lock: new SessionMutex(),
        lockKey: () => 'f221-takeaway-fence',
        expectedSnapshot: snapshot,
        decisionFence,
        writeVignette: async () => {
          writes++;
          return { slug: 'must-not-write', path: 'docs/taste/vignettes/must-not-write.md' };
        },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'claim_lost');
      assert.equal((await read(proposal.id))?.status, 'pending');
      assert.equal(writes, 0);
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);

test(
  'F221 Redis candidate consumes one durable authority token in the same approval or rejection CAS',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F317 durable taste authority');
    const redis = createRedisClient({
      url: process.env.REDIS_URL!,
      keyPrefix: `f317-taste-authority:${randomUUID()}:`,
    });
    try {
      const store = new FencedRedisTasteProposalStore(redis);
      const authority = new RedisTasteDecisionAuthority(redis);
      const create = async () => {
        const proposal = await store.create({
          userId: 'owner',
          catId: 'codex',
          threadId: 'home',
          scene: '原场景',
          quote: '原话',
          tags: ['留白'],
          dimension: 'visual-quality',
          privacy: 'sensitive',
        });
        await store.commitEnvelope(proposal.id, {
          canonicalProposalId: proposal.id,
          sourceFeatureId: 'F221',
          ownerUserId: 'owner',
          requesterCatId: 'codex',
          originRef: { kind: 'message', threadId: 'home', messageId: 'source-1' },
          approvalCardRef: { threadId: 'home', messageId: `card-${proposal.id}` },
          createdAt: proposal.createdAt,
        });
        return { proposal, snapshot: tasteDecisionSnapshot((await store.get(proposal.id))!)! };
      };
      const candidate = store;
      const grant = async (proposalId: string, ttlMs = 120_000) => ({
        key: TasteProposalKeys.decisionAuthority('owner', proposalId),
        fence: await authority.issue('owner', proposalId, ttlMs),
      });

      const revoked = await create();
      const oldGrant = await grant(revoked.proposal.id);
      const read = store.get.bind(store);
      store.get = async (id) => {
        const seen = await read(id);
        if (id === revoked.proposal.id) assert.equal(await authority.revoke(oldGrant.fence), true);
        return seen;
      };
      assert.equal(
        await candidate.claimForApprovalFenced(revoked.proposal.id, 'owner', revoked.snapshot, oldGrant.fence),
        null,
      );
      store.get = read;
      assert.equal((await store.get(revoked.proposal.id))?.status, 'pending');

      const approved = await create();
      const approvalGrant = await grant(approved.proposal.id);
      assert.equal(
        (
          (await candidate.claimForApprovalFenced(
            approved.proposal.id,
            'owner',
            approved.snapshot,
            approvalGrant.fence,
          )) as { status: string }
        )?.status,
        'approving',
      );
      assert.equal(await redis.get(approvalGrant.key), null, 'the one-shot authority is consumed with the claim');
      assert.equal(
        await candidate.claimForApprovalFenced(approved.proposal.id, 'owner', approved.snapshot, approvalGrant.fence),
        null,
      );

      const rejected = await create();
      const rejectionGrant = await grant(rejected.proposal.id);
      assert.equal(
        (
          (await candidate.markRejectedFenced(
            rejected.proposal.id,
            '不合适',
            'owner',
            rejected.snapshot,
            rejectionGrant.fence,
          )) as { status: string }
        )?.status,
        'rejected',
      );
      assert.equal(await redis.get(rejectionGrant.key), null, 'the one-shot authority is consumed with rejection');
      assert.equal(
        await candidate.markRejectedFenced(
          rejected.proposal.id,
          '不合适',
          'owner',
          rejected.snapshot,
          rejectionGrant.fence,
        ),
        null,
      );

      const rotated = await create();
      const first = await grant(rotated.proposal.id);
      const second = await grant(rotated.proposal.id);
      assert.equal(await authority.revoke(first.fence), false, 'an old Host cannot revoke the replacement grant');
      assert.equal(
        (await candidate.claimForApprovalFenced(rotated.proposal.id, 'owner', rotated.snapshot, second.fence))?.status,
        'approving',
      );

      const expired = await create();
      const expiring = await grant(expired.proposal.id, 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(
        await candidate.claimForApprovalFenced(expired.proposal.id, 'owner', expired.snapshot, expiring.fence),
        null,
      );
      assert.equal((await store.get(expired.proposal.id))?.status, 'pending');
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
