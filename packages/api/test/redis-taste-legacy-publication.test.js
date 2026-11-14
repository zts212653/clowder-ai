import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { parse } from 'yaml';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { approveTasteProposal } from '../dist/domains/taste/services/approveTasteProposal.js';
import { tasteContentSnapshot } from '../dist/domains/taste/services/taste-decision-snapshot.js';
import { createVignetteWriter, deriveSlug } from '../dist/domains/taste/services/writeVignette.js';
import { RedisTasteProposalStore } from '../dist/domains/taste/stores/redis/RedisTasteProposalStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';
import { publicTasteApprovalEvidence } from './helpers/taste-source-fixture.js';
import { createRemoteFixture, remoteFile, remoteHead } from './taste-publication-fixtures.js';

async function fixture(t) {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'Taste legacy publication recovery');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `taste-legacy:${randomUUID()}:` });
  await redis.ping();
  const git = createRemoteFixture();
  t.after(async () => {
    await cleanupPrefixedRedisKeys(redis, ['*']);
    await redis.quit();
    rmSync(git.root, { recursive: true, force: true });
  });
  const store = new RedisTasteProposalStore(redis);
  const originRef = { kind: 'message', threadId: 'thread-legacy', messageId: 'source-legacy' };
  const draft = await store.create({
    userId: 'legacy-owner',
    catId: 'codex-astra',
    threadId: originRef.threadId,
    sourceMessageId: originRef.messageId,
    approvalOriginRef: originRef,
    scene: 'An ordinary scene without a final newline',
    quote: 'Keep the complete original text',
    dimension: 'cognitive-honesty',
    tags: ['recovery'],
    privacy: 'public',
  });
  await store.commitEnvelope(draft.id, {
    canonicalProposalId: draft.id,
    sourceFeatureId: 'F221',
    ownerUserId: draft.userId,
    requesterCatId: draft.catId,
    createdAt: draft.createdAt,
    originRef,
    approvalCardRef: { threadId: draft.threadId, messageId: 'card-legacy' },
  });
  const proposal = await store.get(draft.id);
  const writer = createVignetteWriter(git.runtime);
  const approve = (currentStore) =>
    approveTasteProposal(proposal.id, proposal.userId, {
      store: currentStore,
      ...publicTasteApprovalEvidence(proposal),
      lock: new SessionMutex(),
      lockKey: () => git.runtime,
      writeVignette: writer,
    });
  return { redis, git, store, proposal, writer, approve, path: `docs/taste/vignettes/${deriveSlug(proposal)}.md` };
}

test(
  'old public bytes survive proof binding, another lost checkpoint and a fresh Redis store',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    const f = await fixture(t);
    // Pre-upgrade claim has no exact-content digest. Its push succeeds before the process records a checkpoint.
    const oldClaim = await f.store.claimForApproval(f.proposal.id, f.proposal.userId);
    assert.equal(oldClaim.decisionDigest, undefined);
    await f.writer(oldClaim);
    const oldHead = remoteHead(f.git),
      oldBytes = remoteFile(f.git, f.path);
    assert.match(oldBytes, /scene: >\n/);
    const afterUpgrade = new RedisTasteProposalStore(f.redis);
    afterUpgrade.recordWriteCheckpoint = async () => {
      throw new Error('Checkpoint interrupted after legacy readback');
    };
    const interrupted = await f.approve(afterUpgrade);
    assert.equal(interrupted.error, 'Checkpoint interrupted after legacy readback');
    assert.equal((await afterUpgrade.get(f.proposal.id)).status, 'approving');
    const afterSecondRestart = new RedisTasteProposalStore(f.redis);
    assert.equal((await afterSecondRestart.get(f.proposal.id)).legacyPublicationRecovery, true);
    const resumed = await f.approve(afterSecondRestart);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.recovered, true);
    assert.equal(resumed.proposal.status, 'approved');
    assert.equal(remoteHead(f.git), oldHead);
    assert.equal(remoteFile(f.git, f.path), oldBytes);
  },
);

test(
  'a new exact-content approval refuses an existing legacy-format projection',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    const f = await fixture(t);
    await f.writer(f.proposal);
    const head = remoteHead(f.git);
    const result = await f.approve(f.store);
    assert.equal(result.ok, false);
    assert.match(result.error, /publication conflict/);
    assert.equal((await f.store.get(f.proposal.id)).legacyPublicationRecovery, undefined);
    assert.equal(remoteHead(f.git), head);
  },
);

test(
  'a legacy claim with no published file writes the newly confirmed exact content',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    const f = await fixture(t);
    await f.store.claimForApproval(f.proposal.id, f.proposal.userId);
    const result = await f.approve(new RedisTasteProposalStore(f.redis));
    assert.equal(result.ok, true, JSON.stringify(result));
    const bytes = remoteFile(f.git, f.path);
    const body = parse(bytes.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert.equal(body.scene, f.proposal.scene);
    assert.deepEqual(body.quotes, [f.proposal.quote]);
  },
);

test(
  'legacy recovery refuses changed published bytes and clears recovery eligibility on rollback',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    const f = await fixture(t);
    const oldClaim = await f.store.claimForApproval(f.proposal.id, f.proposal.userId);
    await f.writer({ ...oldClaim, scene: 'Different published material' });
    const head = remoteHead(f.git);
    const result = await f.approve(new RedisTasteProposalStore(f.redis));
    assert.equal(result.ok, false);
    assert.match(result.error, /publication conflict/);
    const pending = await f.store.get(f.proposal.id);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.legacyPublicationRecovery, undefined);
    assert.equal(remoteHead(f.git), head);
  },
);

test(
  'a stale proof read cannot grant legacy recovery to a newer exact-content claim',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    const f = await fixture(t);
    const oldClaim = await f.store.claimForApproval(f.proposal.id, f.proposal.userId);
    const snapshot = tasteContentSnapshot(oldClaim);
    const racing = new RedisTasteProposalStore(f.redis);
    racing.get = async () => {
      await f.store.rollbackClaim(f.proposal.id);
      await f.store.claimForApproval(f.proposal.id, f.proposal.userId, snapshot);
      return oldClaim;
    };
    const bound = await racing.recordApprovalProof(f.proposal.id, f.proposal.userId, snapshot);
    assert.equal(bound.decisionDigest, snapshot.digest);
    assert.equal(bound.legacyPublicationRecovery, undefined);
    assert.equal((await f.store.get(f.proposal.id)).legacyPublicationRecovery, undefined);
  },
);
