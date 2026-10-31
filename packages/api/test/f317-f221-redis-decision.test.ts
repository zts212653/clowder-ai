import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { SessionMutex } from '../src/domains/cats/services/agents/invocation/SessionMutex.js';
import { CompanionF221SyntheticDecision } from '../src/domains/concierge/live/CompanionF221SyntheticDecision.js';
import { CompanionF221Trial } from '../src/domains/concierge/live/CompanionF221Trial.js';
import type { CompanionOwnerClient } from '../src/domains/concierge/live/companion-owner-client.js';
import { RedisTasteDecisionAuthority } from '../src/domains/taste/services/RedisTasteDecisionAuthority.js';
import { FileTasteRepository } from '../src/domains/taste/services/TasteRepository.js';
import { tasteDecisionSnapshot } from '../src/domains/taste/services/taste-decision-snapshot.js';
import { createVignetteWriter, deriveSlug } from '../src/domains/taste/services/writeVignette.js';
import { FencedRedisTasteProposalStore } from '../src/domains/taste/stores/redis/FencedRedisTasteProposalStore.js';
import { TasteProposalKeys } from '../src/domains/taste/stores/redis-keys/taste-proposal-keys.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';
import { createRemoteFixture, remoteFile, remoteHead } from './taste-publication-fixtures.js';

test(
  'isolated F221 Host receipt uses a durable Redis authority and settles one exact proposal',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    const redisUrl = process.env.REDIS_URL;
    assertRedisIsolationOrThrow(redisUrl, 'F317 Redis Host candidate');
    assert.ok(redisUrl);
    const redis = createRedisClient({ url: redisUrl, keyPrefix: `f317-host-decision:${randomUUID()}:` });
    try {
      const store = new FencedRedisTasteProposalStore(redis);
      const proposal = await store.create({
        userId: 'owner',
        catId: 'codex',
        threadId: 'home',
        sourceMessageId: 'source-1',
        scene: '讨论留白',
        quote: '不要塞满',
        tags: ['留白'],
        dimension: 'visual-quality',
        privacy: 'sensitive',
      });
      assert.match(proposal.id, /^proposal_/);
      await store.commitEnvelope(proposal.id, {
        canonicalProposalId: proposal.id,
        sourceFeatureId: 'F221',
        ownerUserId: 'owner',
        requesterCatId: 'codex',
        originRef: { kind: 'message', threadId: 'home', messageId: 'source-1' },
        approvalCardRef: { threadId: 'home', messageId: 'card-1' },
        createdAt: proposal.createdAt,
      });
      const context = { generation: 7, callId: randomUUID() };
      const client = {
        request: async () => {
          const current = await store.get(proposal.id);
          assert.ok(current);
          return tasteDecisionSnapshot(current);
        },
      } as unknown as CompanionOwnerClient;
      const authority = new RedisTasteDecisionAuthority(redis);
      const lock = new SessionMutex();
      const approvalCoordinator = { lock, lockKey: () => 'canonical:taste-publication' };
      const trial = new CompanionF221Trial(client, 'owner', () => context);
      let writes = 0;
      const authorized = true;
      const candidate = new CompanionF221SyntheticDecision(
        trial,
        'owner',
        () => context,
        () => authorized,
        store,
        approvalCoordinator,
        async () => {
          writes++;
          return { slug: 'isolated', path: 'docs/taste/vignettes/isolated.md' };
        },
        Date.now,
        authority,
      );
      const key = TasteProposalKeys.decisionAuthority('owner', proposal.id);
      const preview = await candidate.inspect(proposal.id);
      assert.ok(await redis.get(key), 'Host inspection must issue a durable, bounded authority token');
      const outcome = await candidate.decide(preview.snapshot.nonce, 'approve');
      assert.deepEqual(outcome, {
        state: 'applied',
        producerStatus: 'approved',
        effectPath: 'docs/taste/vignettes/isolated.md',
      });
      assert.equal(await redis.get(key), null, 'producer CAS consumes the one-shot authority');
      assert.equal(writes, 1);
      assert.equal((await store.get(proposal.id))?.status, 'approved');

      const delayed = await store.create({
        proposalId: randomUUID(),
        userId: 'owner',
        catId: 'codex',
        threadId: 'home',
        sourceMessageId: 'source-2',
        scene: '另一个场景',
        quote: '还没批准',
        tags: ['等待'],
        dimension: 'visual-quality',
        privacy: 'sensitive',
      });
      await store.commitEnvelope(delayed.id, {
        canonicalProposalId: delayed.id,
        sourceFeatureId: 'F221',
        ownerUserId: 'owner',
        requesterCatId: 'codex',
        originRef: { kind: 'message', threadId: 'home', messageId: 'source-2' },
        approvalCardRef: { threadId: 'home', messageId: 'card-2' },
        createdAt: delayed.createdAt,
      });
      let delayedReads = 0;
      let delayedAuthorized = true;
      const delayedClient = {
        request: async () => {
          delayedReads++;
          const current = await store.get(delayed.id);
          assert.ok(current);
          return tasteDecisionSnapshot(current);
        },
      } as unknown as CompanionOwnerClient;
      const delayedTrial = new CompanionF221Trial(delayedClient, 'owner', () => context);
      const delayedCandidate = new CompanionF221SyntheticDecision(
        delayedTrial,
        'owner',
        () => context,
        () => delayedAuthorized,
        store,
        approvalCoordinator,
        async () => {
          writes++;
          return { slug: 'late', path: 'docs/taste/vignettes/late.md' };
        },
        Date.now,
        authority,
      );
      const delayedPreview = await delayedCandidate.inspect(delayed.id);
      const release = await lock.acquire(approvalCoordinator.lockKey());
      const deciding = delayedCandidate.decide(delayedPreview.snapshot.nonce, 'approve');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(delayedReads, 2, 'confirmation reached the producer lock wait');
      delayedAuthorized = false;
      await delayedCandidate.reset();
      assert.equal(await redis.get(TasteProposalKeys.decisionAuthority('owner', delayed.id)), null);
      release();
      assert.deepEqual(await deciding, { state: 'stale' });
      assert.equal((await store.get(delayed.id))?.status, 'pending');
      assert.equal(writes, 1, 'revocation before the producer CAS cannot start a second effect');

      delayedAuthorized = true;
      const freshPreview = await delayedCandidate.inspect(delayed.id);
      assert.deepEqual(await delayedCandidate.decide(freshPreview.snapshot.nonce, 'reject'), {
        state: 'applied',
        producerStatus: 'rejected',
      });
      assert.equal((await store.get(delayed.id))?.status, 'rejected');
      assert.equal(await redis.get(TasteProposalKeys.decisionAuthority('owner', delayed.id)), null);
      assert.equal(writes, 1, 'a fresh explicit rejection has no vignette side effect');
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);

test(
  'isolated Redis authority fences the real Git publisher before one explicit re-confirmation',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    const redisUrl = process.env.REDIS_URL;
    assertRedisIsolationOrThrow(redisUrl, 'F317 Redis Git publication candidate');
    assert.ok(redisUrl);
    const fixture = createRemoteFixture();
    const redis = createRedisClient({ url: redisUrl, keyPrefix: `f317-git-decision:${randomUUID()}:` });
    try {
      const store = new FencedRedisTasteProposalStore(redis);
      const proposal = await store.create({
        userId: 'owner',
        catId: 'codex',
        threadId: 'home',
        sourceMessageId: 'source-1',
        scene: '一起看设计稿',
        quote: '保留一点呼吸感',
        tags: ['留白'],
        dimension: 'visual-quality',
        privacy: 'public',
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
      const context = { generation: 1, callId: randomUUID() };
      const client = {
        request: async () => {
          const current = await store.get(proposal.id);
          assert.ok(current);
          return tasteDecisionSnapshot(current);
        },
      } as unknown as CompanionOwnerClient;
      const lock = new SessionMutex();
      const tasteRepository = new FileTasteRepository(fixture.runtime);
      const approvalCoordinator = { lock, lockKey: () => tasteRepository.approvalLockKey() };
      const candidate = new CompanionF221SyntheticDecision(
        new CompanionF221Trial(client, 'owner', () => context),
        'owner',
        () => context,
        () => true,
        store,
        approvalCoordinator,
        createVignetteWriter(fixture.runtime),
        Date.now,
        new RedisTasteDecisionAuthority(redis),
      );
      const baseHead = remoteHead(fixture);
      const first = await candidate.inspect(proposal.id);
      const release = await lock.acquire(approvalCoordinator.lockKey());
      const stale = candidate.decide(first.snapshot.nonce, 'approve');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await candidate.reset();
      release();
      assert.deepEqual(await stale, { state: 'stale' });
      assert.equal((await store.get(proposal.id))?.status, 'pending');
      assert.equal(remoteHead(fixture), baseHead, 'revoked confirmation must not reach the Git publisher');

      const renewed = await candidate.inspect(proposal.id);
      const applied = await candidate.decide(renewed.snapshot.nonce, 'approve');
      const path = `docs/taste/vignettes/${deriveSlug(proposal)}.md`;
      assert.deepEqual(applied, { state: 'applied', producerStatus: 'approved', effectPath: path });
      assert.notEqual(remoteHead(fixture), baseHead);
      assert.match(remoteFile(fixture, path), new RegExp(`proposalId: ${proposal.id}`));
      assert.match(remoteFile(fixture, 'docs/taste/index.md'), new RegExp(`vignettes/${deriveSlug(proposal)}\\.md`));
      assert.equal(await redis.get(TasteProposalKeys.decisionAuthority('owner', proposal.id)), null);
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);
