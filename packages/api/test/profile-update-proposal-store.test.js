import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// F231 Phase C Task1: ProfileUpdateProposalStore — CAS state machine + P1-1 two-path checkpoint.
describe('ProfileUpdateProposalStore (in-memory)', () => {
  let store;

  beforeEach(async () => {
    const { InMemoryProfileUpdateProposalStore } = await import(
      '../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js'
    );
    store = new InMemoryProfileUpdateProposalStore();
  });

  const baseInput = (over = {}) => ({
    sourceThreadId: 'thread_1',
    sourceInvocationId: 'inv_1',
    sourceCatId: 'codex',
    targetLayer: 'primer',
    targetPath: 'relationship/codex-primer.md',
    beforeContent: 'old primer',
    baseContentHash: 'hash_old',
    afterContent: 'new primer',
    rationale: 'landy said he prefers X',
    signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1' },
    createdBy: 'user_landy',
    ...over,
  });

  it('create → status pending with payload', () => {
    const p = store.create(baseInput());
    assert.equal(p.status, 'pending');
    assert.ok(p.proposalId);
    assert.equal(p.targetLayer, 'primer');
    assert.equal(p.baseContentHash, 'hash_old');
    assert.equal(p.signalProvenance.kind, 'cat-declared');
    assert.deepEqual(store.get(p.proposalId), p);
  });

  it('INV-3: concurrent claim — only one wins (CAS pending→approving)', () => {
    const p = store.create(baseInput());
    const first = store.claimForApproval(p.proposalId, 'you');
    const second = store.claimForApproval(p.proposalId, 'you');
    assert.ok(first, 'first claim wins');
    assert.equal(first.status, 'approving');
    assert.ok(first.claimedAt);
    assert.equal(second, null, 'second claim loses (not pending)');
  });

  it('recordCheckpoint persists BOTH paths without changing status (P1-1)', () => {
    const p = store.create(baseInput());
    store.claimForApproval(p.proposalId, 'you');
    const patched = store.recordCheckpoint(p.proposalId, {
      writtenPath: 'codex-primer.md',
      provenancePath: 'prov/2026-codex.md',
    });
    assert.equal(patched.status, 'approving', 'checkpoint does not change status');
    assert.equal(patched.writtenPath, 'codex-primer.md');
    assert.equal(patched.provenancePath, 'prov/2026-codex.md');
    assert.equal(store.get(p.proposalId).provenancePath, 'prov/2026-codex.md');
  });

  it('recordCheckpoint is a no-op when not approving', () => {
    const p = store.create(baseInput());
    // still pending — checkpoint must not persist
    assert.equal(store.recordCheckpoint(p.proposalId, { writtenPath: 'x' }), null);
    assert.equal(store.get(p.proposalId).writtenPath, undefined);
  });

  it('INV-1: finalize only from approving (null from pending)', () => {
    const p = store.create(baseInput());
    assert.equal(store.finalizeApproval(p.proposalId), null, 'cannot finalize pending');
    store.claimForApproval(p.proposalId, 'you');
    const final = store.finalizeApproval(p.proposalId);
    assert.equal(final.status, 'approved');
    assert.ok(final.approvedAt);
    assert.equal(final.claimedAt, undefined, 'claimedAt cleared on finalize');
  });

  it('rollbackClaim: approving→pending (write failure path)', () => {
    const p = store.create(baseInput());
    store.claimForApproval(p.proposalId, 'you');
    assert.equal(store.rollbackClaim(p.proposalId), true);
    assert.equal(store.get(p.proposalId).status, 'pending');
    assert.equal(store.get(p.proposalId).approvedBy, undefined);
    // rollback on non-approving is false
    assert.equal(store.rollbackClaim(p.proposalId), false);
  });

  it('markRejected: pending→rejected (null if already approving)', () => {
    const p = store.create(baseInput());
    assert.equal(store.markRejected(p.proposalId, 'you', 'not accurate').status, 'rejected');
    assert.equal(store.get(p.proposalId).rejectionReason, 'not accurate');
    const p2 = store.create(baseInput());
    store.claimForApproval(p2.proposalId, 'you');
    assert.equal(store.markRejected(p2.proposalId, 'you'), null, 'cannot reject approving');
  });

  it('ADV-5: reject then approve — claim returns null', () => {
    const p = store.create(baseInput());
    store.markRejected(p.proposalId, 'you');
    assert.equal(store.claimForApproval(p.proposalId, 'you'), null, 'cannot claim rejected');
  });

  it('INV-4 / ADV-4: dedup — same clientRequestId returns same proposalId', () => {
    assert.equal(store.reserveDedup('user_landy', 'req_1', 'prop_A'), 'prop_A');
    assert.equal(store.reserveDedup('user_landy', 'req_1', 'prop_B'), 'prop_A', 'concurrent loser gets winner id');
    assert.equal(store.getDedupProposalId('user_landy', 'req_1'), 'prop_A');
    // releaseDedup only clears when it points at expected
    store.releaseDedup('user_landy', 'req_1', 'prop_B');
    assert.equal(store.getDedupProposalId('user_landy', 'req_1'), 'prop_A', 'wrong-id release is a no-op');
    store.releaseDedup('user_landy', 'req_1', 'prop_A');
    assert.equal(store.getDedupProposalId('user_landy', 'req_1'), null, 'correct-id release clears');
  });

  it('listPending returns only pending for the user (newest first)', () => {
    const p1 = store.create(baseInput());
    const p2 = store.create(baseInput());
    store.markRejected(p2.proposalId, 'you');
    const pending = store.listPending('user_landy');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].proposalId, p1.proposalId);
  });
});
