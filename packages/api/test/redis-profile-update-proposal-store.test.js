/**
 * RedisProfileUpdateProposalStore tests (F231 Phase C Task1 — Redis-backed).
 * 有 Redis → 测全量；无 Redis → skip。
 * 重点（砚砚 feedback_inmemory）：serialize/hydrate 往返不丢字段；CAS claim 真并发
 * （Promise.all）证 Lua 原子性；INV-2/7 崩溃恢复用 fresh store 读同一 Redis（无内存态）。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const PATTERNS = ['profile-update:*', 'dedup:profile-update:*'];

describe('RedisProfileUpdateProposalStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisProfileUpdateProposalStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisProfileUpdateProposalStore');
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisProfileUpdateProposalStore.js');
    RedisProfileUpdateProposalStore = storeModule.RedisProfileUpdateProposalStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-profile-update-proposal-store.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (connected) {
      await cleanupPrefixedRedisKeys(redis, PATTERNS);
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async () => {
    if (connected) await cleanupPrefixedRedisKeys(redis, PATTERNS);
    store = new RedisProfileUpdateProposalStore(redis);
  });

  const baseInput = (over = {}) => ({
    sourceThreadId: 'thread_1',
    sourceInvocationId: 'inv_1',
    sourceCatId: 'codex',
    targetLayer: 'primer',
    targetPath: 'relationship/codex-primer.md',
    beforeContent: 'OLD',
    baseContentHash: 'hash_old',
    afterContent: 'NEW',
    rationale: 'landy prefers blue',
    signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1', sourceMessageId: 'msg_1' },
    createdBy: 'user_landy',
    ...over,
  });

  it('serialize/hydrate round-trip preserves all profile fields', async () => {
    const p = await store.create(baseInput());
    const got = await store.get(p.proposalId);
    assert.equal(got.status, 'pending');
    assert.equal(got.targetPath, 'relationship/codex-primer.md');
    assert.equal(got.baseContentHash, 'hash_old');
    assert.equal(got.beforeContent, 'OLD');
    assert.equal(got.afterContent, 'NEW');
    assert.equal(got.rationale, 'landy prefers blue');
    assert.equal(got.signalProvenance.kind, 'cat-declared');
    assert.equal(got.signalProvenance.sourceThreadId, 'thread_1');
    assert.equal(got.signalProvenance.sourceMessageId, 'msg_1');
  });

  it('CAS claim: real concurrent claim — exactly one wins (Lua atomicity)', async () => {
    const p = await store.create(baseInput());
    const [a, b] = await Promise.all([
      store.claimForApproval(p.proposalId, 'you'),
      store.claimForApproval(p.proposalId, 'you'),
    ]);
    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one claim wins under real concurrency');
    assert.equal(winners[0].status, 'approving');
  });

  it('INV-2/7 crash recovery: checkpoints survive re-read by a fresh store (no in-memory state)', async () => {
    const p = await store.create(baseInput());
    await store.claimForApproval(p.proposalId, 'you');
    await store.recordCheckpoint(p.proposalId, { writtenPath: '/primer.md' });
    // crash: a fresh store reads the same Redis (persistent — Iron law#5 TTL=0)
    const fresh = new RedisProfileUpdateProposalStore(redis);
    const recovered = await fresh.get(p.proposalId);
    assert.equal(recovered.status, 'approving');
    assert.equal(recovered.writtenPath, '/primer.md');
    assert.equal(recovered.provenancePath, undefined, 'primer-written / provenance-pending window');
    // resume: checkpoint provenance + finalize
    await fresh.recordCheckpoint(p.proposalId, { provenancePath: '/prov.md' });
    const final = await fresh.finalizeApproval(p.proposalId);
    assert.equal(final.status, 'approved');
    assert.equal(final.writtenPath, '/primer.md');
    assert.equal(final.provenancePath, '/prov.md');
    // P2 (codex re-review): finalize clears claimedAt in Redis — fresh read matches InMemory/F128
    const afterFinalize = await fresh.get(p.proposalId);
    assert.equal(afterFinalize.claimedAt, undefined, 'finalize clears claimedAt in Redis (P2)');
  });

  it('finalize only from approving; checkpoint no-op when pending; reject blocks claim', async () => {
    const p = await store.create(baseInput());
    assert.equal(await store.finalizeApproval(p.proposalId), null, 'cannot finalize pending');
    assert.equal(await store.recordCheckpoint(p.proposalId, { writtenPath: 'x' }), null, 'checkpoint no-op pending');
    assert.equal((await store.get(p.proposalId)).writtenPath, undefined);
    const r = await store.markRejected(p.proposalId, 'you', 'inaccurate');
    assert.equal(r.status, 'rejected');
    assert.equal((await store.get(p.proposalId)).rejectionReason, 'inaccurate');
    assert.equal(await store.claimForApproval(p.proposalId, 'you'), null, 'cannot claim rejected');
  });

  it('rollbackClaim returns to pending + re-adds to pending index; dedup reserve idempotent', async () => {
    const p = await store.create(baseInput());
    await store.claimForApproval(p.proposalId, 'you');
    assert.equal(await store.rollbackClaim(p.proposalId), true);
    const back = await store.get(p.proposalId);
    assert.equal(back.status, 'pending');
    assert.equal(back.approvedBy, undefined);
    const pending = await store.listPending('user_landy');
    assert.ok(
      pending.some((x) => x.proposalId === p.proposalId),
      'rolled-back proposal back in pending index',
    );
    // dedup
    assert.equal(await store.reserveDedup('user_landy', 'req_1', 'prop_A'), 'prop_A');
    assert.equal(await store.reserveDedup('user_landy', 'req_1', 'prop_B'), 'prop_A', 'retry returns winner id');
  });
});
