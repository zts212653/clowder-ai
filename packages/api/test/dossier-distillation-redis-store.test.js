/**
 * F208 Phase E: RedisDossierDistillationProposalStore integration test.
 *
 * Verifies Redis persistence (Iron Rule #5: TTL=0 user state).
 * Uses test Redis infrastructure (port 6398, never 6399).
 *
 * Covers: create + idempotency (sourceId), state transitions,
 * pending index cleanup on approve/reject, per-cat index.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Redis from 'ioredis';

const TEST_PREFIX = `test:distill:${Date.now()}:`;

describe('RedisDossierDistillationProposalStore', () => {
  /** @type {import('ioredis').default} */
  let redis;
  /** @type {import('../src/domains/cats/services/stores/redis/RedisDossierDistillationProposalStore.js').RedisDossierDistillationProposalStore} */
  let store;

  before(async () => {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6398';
    redis = new Redis(redisUrl, { keyPrefix: TEST_PREFIX, lazyConnect: true });
    try {
      await redis.connect();
    } catch {
      return; // Skip if Redis unavailable in CI
    }
    const { RedisDossierDistillationProposalStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisDossierDistillationProposalStore.js'
    );
    store = new RedisDossierDistillationProposalStore(redis);
  });

  after(async () => {
    if (redis?.status === 'ready') {
      const keys = await redis.keys(`${TEST_PREFIX}*`);
      if (keys.length) {
        const pipeline = redis.multi();
        for (const key of keys) {
          const logicalKey = key.startsWith(TEST_PREFIX) ? key.slice(TEST_PREFIX.length) : key;
          pipeline.del(logicalKey);
        }
        await pipeline.exec();
      }
      await redis.quit();
    }
  });

  const baseInput = (over = {}) => ({
    sourceEvent: 'feat-phase-close',
    sourceId: `test-source-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    targetCatId: 'opus',
    targetFields: ['nativePeakAbilities', 'blindSpots'],
    beforeSnapshot: '原生峰值: 深度思考',
    afterDraft: '原生峰值: 深度思考 + Redis 架构',
    rationale: 'Phase D Redis store 表现',
    evidenceRefs: [{ type: 'review', id: 'review-pr-2457', summary: 'PR review' }],
    baseHash: 'abc123',
    createdBy: 'opus',
    ...over,
  });

  it('create + get roundtrip preserves all fields', async () => {
    if (!store) return; // Redis unavailable
    const input = baseInput();
    const created = await store.create(input);

    assert.ok(created.proposalId);
    assert.equal(created.status, 'pending');
    assert.equal(created.sourceEvent, 'feat-phase-close');
    assert.equal(created.targetCatId, 'opus');

    const retrieved = await store.get(created.proposalId);
    assert.ok(retrieved);
    assert.equal(retrieved.proposalId, created.proposalId);
    assert.equal(retrieved.sourceId, input.sourceId);
    assert.deepEqual(retrieved.targetFields, ['nativePeakAbilities', 'blindSpots']);
    assert.equal(retrieved.evidenceRefs.length, 1);
    assert.equal(retrieved.evidenceRefs[0].type, 'review');
    assert.equal(retrieved.baseHash, 'abc123');
  });

  it('create fails with empty evidenceRefs (fail-closed)', async () => {
    if (!store) return;
    await assert.rejects(() => store.create(baseInput({ evidenceRefs: [] })), /evidenceRefs.*non-empty/i);
  });

  it('getBySourceId returns proposal by sourceId (idempotency)', async () => {
    if (!store) return;
    const input = baseInput({ sourceId: `idempotent-${Date.now()}` });
    const created = await store.create(input);

    const found = await store.getBySourceId(input.sourceId);
    assert.ok(found);
    assert.equal(found.proposalId, created.proposalId);
  });

  it('getBySourceId returns null for unknown sourceId', async () => {
    if (!store) return;
    const result = await store.getBySourceId('nonexistent-source');
    assert.equal(result, null);
  });

  it('listPending returns only pending proposals', async () => {
    if (!store) return;
    const p1 = await store.create(baseInput({ sourceId: `pending-1-${Date.now()}` }));
    const p2 = await store.create(baseInput({ sourceId: `pending-2-${Date.now()}` }));
    await store.markApproved(p2.proposalId, 'you');

    const pending = await store.listPending();
    const pendingIds = pending.map((p) => p.proposalId);
    assert.ok(pendingIds.includes(p1.proposalId), 'p1 should be in pending');
    assert.ok(!pendingIds.includes(p2.proposalId), 'approved p2 should not be in pending');
  });

  it('listByCat returns proposals for a specific cat', async () => {
    if (!store) return;
    await store.create(baseInput({ targetCatId: 'opus', sourceId: `cat-1-${Date.now()}` }));
    await store.create(baseInput({ targetCatId: 'codex', sourceId: `cat-2-${Date.now()}` }));

    const opusProposals = await store.listByCat('opus');
    assert.ok(opusProposals.length >= 1);
    assert.ok(opusProposals.every((p) => p.targetCatId === 'opus'));
  });

  it('markApproved: pending → approved + removes from pending index', async () => {
    if (!store) return;
    const created = await store.create(baseInput({ sourceId: `approve-${Date.now()}` }));

    const approved = await store.markApproved(created.proposalId, 'you');
    assert.ok(approved);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy, 'you');
    assert.ok(approved.approvedAt > 0);

    // Verify persisted
    const retrieved = await store.get(created.proposalId);
    assert.equal(retrieved.status, 'approved');

    // Verify removed from pending index
    const pending = await store.listPending();
    assert.ok(!pending.some((p) => p.proposalId === created.proposalId));
  });

  it('markApproved returns null if not pending', async () => {
    if (!store) return;
    const created = await store.create(baseInput({ sourceId: `double-approve-${Date.now()}` }));
    await store.markApproved(created.proposalId, 'you');
    const second = await store.markApproved(created.proposalId, 'you');
    assert.equal(second, null);
  });

  it('markRejected: pending → rejected + removes from pending index', async () => {
    if (!store) return;
    const created = await store.create(baseInput({ sourceId: `reject-${Date.now()}` }));

    const rejected = await store.markRejected(created.proposalId, 'you', 'not accurate');
    assert.ok(rejected);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectedBy, 'you');
    assert.equal(rejected.rejectionReason, 'not accurate');

    // Verify removed from pending index
    const pending = await store.listPending();
    assert.ok(!pending.some((p) => p.proposalId === created.proposalId));
  });

  it('markApplied: approved → applied with commitSha', async () => {
    if (!store) return;
    const created = await store.create(baseInput({ sourceId: `apply-${Date.now()}` }));
    await store.markApproved(created.proposalId, 'you');

    const applied = await store.markApplied(created.proposalId, 'opus', 'abc123def');
    assert.ok(applied);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.appliedBy, 'opus');
    assert.equal(applied.appliedCommitSha, 'abc123def');
    // approval fields preserved
    assert.equal(applied.approvedBy, 'you');

    // Verify persisted
    const retrieved = await store.get(created.proposalId);
    assert.equal(retrieved.status, 'applied');
    assert.equal(retrieved.appliedCommitSha, 'abc123def');
  });

  it('markApplied returns null if not approved', async () => {
    if (!store) return;
    const created = await store.create(baseInput({ sourceId: `apply-fail-${Date.now()}` }));
    const result = await store.markApplied(created.proposalId, 'opus', 'abc123');
    assert.equal(result, null);
  });

  it('full lifecycle: create → approve → apply (persisted)', async () => {
    if (!store) return;
    const created = await store.create(baseInput({ sourceId: `lifecycle-${Date.now()}` }));
    assert.equal(created.status, 'pending');

    await store.markApproved(created.proposalId, 'you');
    await store.markApplied(created.proposalId, 'opus', 'final-sha');

    const final = await store.get(created.proposalId);
    assert.equal(final.status, 'applied');
    assert.equal(final.approvedBy, 'you');
    assert.equal(final.appliedBy, 'opus');
    assert.equal(final.appliedCommitSha, 'final-sha');
  });
});
