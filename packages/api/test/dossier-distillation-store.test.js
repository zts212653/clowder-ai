/**
 * F208 Phase E: DossierDistillationProposalStore — 画像蒸馏 proposal 的存储层。
 *
 * AC-E1: DossierDistillationProposal schema + store, 幂等（同 sourceId 不重复创建）。
 * KD-16: 不复用 F231 propose_profile_update（语义不同）。
 * KD-17: 契约 schema（sourceEvent, sourceId, evidenceRefs fail-closed, baseHash）。
 * KD-18: v1 不自动 commit — operator approve 后猫 apply。
 *
 * State machine:
 *   pending → approved → applied
 *   pending → rejected
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('DossierDistillationProposalStore (in-memory)', () => {
  let store;

  beforeEach(async () => {
    const { InMemoryDossierDistillationProposalStore } = await import(
      '../dist/domains/cats/services/stores/ports/DossierDistillationProposalStore.js'
    );
    store = new InMemoryDossierDistillationProposalStore();
  });

  const baseInput = (over = {}) => ({
    sourceEvent: 'feat-phase-close',
    sourceId: 'feat-phase-close:F208:D',
    targetCatId: 'opus',
    targetFields: ['nativePeakAbilities', 'blindSpots'],
    beforeSnapshot: '原生峰值: 深度思考和系统设计',
    afterDraft: '原生峰值: 深度思考、系统设计、Redis store 架构',
    rationale: 'F208 Phase D 实现展示 Redis store 架构能力',
    evidenceRefs: [
      { type: 'review', id: 'review-pr-2457', summary: 'PR #2457 review 通过' },
      { type: 'observation', id: 'obs_abc123', summary: 'operator 观察: Redis 架构设计强' },
    ],
    baseHash: 'abc123def456',
    createdBy: 'opus',
    ...over,
  });

  // ===== create =====

  it('create → returns proposal with generated id, pending status, and all fields', () => {
    const p = store.create(baseInput());
    assert.ok(p.proposalId, 'should generate proposalId');
    assert.match(p.proposalId, /^proposal_/, 'proposalId should have proposal_ prefix');
    assert.equal(p.status, 'pending');
    assert.equal(p.sourceEvent, 'feat-phase-close');
    assert.equal(p.sourceId, 'feat-phase-close:F208:D');
    assert.equal(p.targetCatId, 'opus');
    assert.deepEqual(p.targetFields, ['nativePeakAbilities', 'blindSpots']);
    assert.equal(p.beforeSnapshot, '原生峰值: 深度思考和系统设计');
    assert.equal(p.afterDraft, '原生峰值: 深度思考、系统设计、Redis store 架构');
    assert.equal(p.rationale, 'F208 Phase D 实现展示 Redis store 架构能力');
    assert.equal(p.evidenceRefs.length, 2);
    assert.equal(p.baseHash, 'abc123def456');
    assert.equal(p.createdBy, 'opus');
    assert.ok(p.createdAt > 0, 'should have createdAt timestamp');
  });

  it('create → fails if evidenceRefs is empty (KD-17 fail-closed)', () => {
    assert.throws(() => store.create(baseInput({ evidenceRefs: [] })), /evidenceRefs.*non-empty/i);
  });

  it('create → returns deep clone (mutations do not affect store)', () => {
    const p = store.create(baseInput());
    p.targetFields.push('MUTATED');
    p.evidenceRefs.push({ type: 'review', id: 'fake' });
    const retrieved = store.get(p.proposalId);
    assert.equal(retrieved.targetFields.length, 2, 'targetFields should not be mutated');
    assert.equal(retrieved.evidenceRefs.length, 2, 'evidenceRefs should not be mutated');
  });

  it('create → accepts explicit proposalId', () => {
    const p = store.create(baseInput({ proposalId: 'proposal_custom123' }));
    assert.equal(p.proposalId, 'proposal_custom123');
  });

  // ===== get =====

  it('get → returns null for unknown proposalId', () => {
    assert.equal(store.get('proposal_nonexistent'), null);
  });

  it('get → returns proposal by id', () => {
    const created = store.create(baseInput());
    const retrieved = store.get(created.proposalId);
    assert.equal(retrieved.proposalId, created.proposalId);
    assert.equal(retrieved.status, 'pending');
  });

  // ===== getBySourceId (idempotency) =====

  it('getBySourceId → returns null for unknown sourceId', () => {
    assert.equal(store.getBySourceId('nonexistent'), null);
  });

  it('getBySourceId → returns existing proposal by sourceId', () => {
    const created = store.create(baseInput());
    const found = store.getBySourceId('feat-phase-close:F208:D');
    assert.equal(found.proposalId, created.proposalId);
  });

  // ===== listPending =====

  it('listPending → returns only pending proposals, newest first', () => {
    store.create(baseInput({ sourceId: 'a' }));
    store.create(baseInput({ sourceId: 'b' }));
    const approved = store.create(baseInput({ sourceId: 'c' }));
    store.markApproved(approved.proposalId, 'you');

    const pending = store.listPending();
    assert.equal(pending.length, 2);
    // newest first
    assert.ok(pending[0].createdAt >= pending[1].createdAt);
  });

  it('listPending → respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.create(baseInput({ sourceId: `s${i}` }));
    }
    const limited = store.listPending(3);
    assert.equal(limited.length, 3);
  });

  // ===== listByCat =====

  it('listByCat → returns proposals for specific cat across all statuses', () => {
    store.create(baseInput({ targetCatId: 'opus', sourceId: 'a' }));
    store.create(baseInput({ targetCatId: 'codex', sourceId: 'b' }));
    store.create(baseInput({ targetCatId: 'opus', sourceId: 'c' }));

    const opusProposals = store.listByCat('opus');
    assert.equal(opusProposals.length, 2);
    assert.ok(opusProposals.every((p) => p.targetCatId === 'opus'));
  });

  // ===== markApproved =====

  it('markApproved → transitions pending → approved', () => {
    const created = store.create(baseInput());
    const approved = store.markApproved(created.proposalId, 'you');
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy, 'you');
    assert.ok(approved.approvedAt > 0, 'should have approvedAt timestamp');
  });

  it('markApproved → returns null if not pending', () => {
    const created = store.create(baseInput());
    store.markApproved(created.proposalId, 'you');
    // second approve should fail — already approved
    const secondApprove = store.markApproved(created.proposalId, 'you');
    assert.equal(secondApprove, null);
  });

  it('markApproved → returns null for rejected proposal', () => {
    const created = store.create(baseInput());
    store.markRejected(created.proposalId, 'you', 'not accurate');
    const result = store.markApproved(created.proposalId, 'you');
    assert.equal(result, null);
  });

  // ===== markRejected =====

  it('markRejected → transitions pending → rejected', () => {
    const created = store.create(baseInput());
    const rejected = store.markRejected(created.proposalId, 'you', 'evidence insufficient');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectedBy, 'you');
    assert.equal(rejected.rejectionReason, 'evidence insufficient');
    assert.ok(rejected.rejectedAt > 0);
  });

  it('markRejected → returns null if not pending', () => {
    const created = store.create(baseInput());
    store.markApproved(created.proposalId, 'you');
    const result = store.markRejected(created.proposalId, 'you');
    assert.equal(result, null);
  });

  it('markRejected → works without rejection reason', () => {
    const created = store.create(baseInput());
    const rejected = store.markRejected(created.proposalId, 'you');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectedBy, 'you');
    assert.equal(rejected.rejectionReason, undefined);
  });

  // ===== markApplied =====

  it('markApplied → transitions approved → applied', () => {
    const created = store.create(baseInput());
    store.markApproved(created.proposalId, 'you');
    const applied = store.markApplied(created.proposalId, 'opus', 'abc123');
    assert.equal(applied.status, 'applied');
    assert.equal(applied.appliedBy, 'opus');
    assert.equal(applied.appliedCommitSha, 'abc123');
    assert.ok(applied.appliedAt > 0);
    // approval fields preserved
    assert.equal(applied.approvedBy, 'you');
    assert.ok(applied.approvedAt > 0);
  });

  it('markApplied → returns null if not approved (pending)', () => {
    const created = store.create(baseInput());
    const result = store.markApplied(created.proposalId, 'opus', 'abc123');
    assert.equal(result, null);
  });

  it('markApplied → returns null if rejected', () => {
    const created = store.create(baseInput());
    store.markRejected(created.proposalId, 'you');
    const result = store.markApplied(created.proposalId, 'opus', 'abc123');
    assert.equal(result, null);
  });

  it('markApplied → returns null for already applied', () => {
    const created = store.create(baseInput());
    store.markApproved(created.proposalId, 'you');
    store.markApplied(created.proposalId, 'opus', 'abc123');
    const secondApply = store.markApplied(created.proposalId, 'opus', 'def456');
    assert.equal(secondApply, null);
  });

  // ===== full lifecycle =====

  it('full lifecycle: create → approve → apply', () => {
    // 1. Cat proposes distillation
    const proposal = store.create(baseInput());
    assert.equal(proposal.status, 'pending');

    // 2. operator approves
    const approved = store.markApproved(proposal.proposalId, 'you');
    assert.equal(approved.status, 'approved');

    // 3. Cat applies to dossier + commits
    const applied = store.markApplied(proposal.proposalId, 'opus', 'abc123def');
    assert.equal(applied.status, 'applied');
    assert.equal(applied.appliedCommitSha, 'abc123def');

    // 4. Verify final state
    const final = store.get(proposal.proposalId);
    assert.equal(final.status, 'applied');
    assert.equal(final.approvedBy, 'you');
    assert.equal(final.appliedBy, 'opus');
  });

  it('full lifecycle: create → reject', () => {
    const proposal = store.create(baseInput());
    const rejected = store.markRejected(proposal.proposalId, 'you', 'not accurate enough');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectionReason, 'not accurate enough');

    // Cannot transition from rejected
    assert.equal(store.markApproved(proposal.proposalId, 'you'), null);
    assert.equal(store.markApplied(proposal.proposalId, 'opus', 'abc'), null);
  });
});
