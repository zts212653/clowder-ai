// @ts-check

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { InMemoryTasteProposalStore } from '../src/domains/taste/stores/InMemoryTasteProposalStore.ts';

/** @returns {import('../src/domains/taste/stores/ports/TasteProposalStore.ts').CreateTasteProposalInput} */
function makeInput(overrides = {}) {
  return {
    userId: 'user-1',
    catId: 'opus',
    threadId: 'thread-1',
    scene: 'operator said "太客服了" during review',
    quote: '太客服了，我要的是活人感',
    tags: ['authentic-expression', '活人感'],
    dimension: 'authentic-expression',
    privacy: 'public',
    ...overrides,
  };
}

describe('InMemoryTasteProposalStore', () => {
  /** @type {InMemoryTasteProposalStore} */
  let store;

  beforeEach(() => {
    store = new InMemoryTasteProposalStore();
  });

  // ── Create ──

  it('creates a proposal with status=pending, id, and createdAt', () => {
    const proposal = store.create(makeInput());
    assert.equal(proposal.status, 'pending');
    assert.ok(proposal.id, 'should have an id');
    assert.ok(proposal.createdAt > 0, 'should have createdAt');
    assert.equal(proposal.userId, 'user-1');
    assert.equal(proposal.catId, 'opus');
    assert.equal(proposal.scene, 'operator said "太客服了" during review');
    assert.equal(proposal.dimension, 'authentic-expression');
    assert.equal(proposal.privacy, 'public');
    assert.deepEqual(proposal.tags, ['authentic-expression', '活人感']);
  });

  it('creates proposals with unique ids', () => {
    const p1 = store.create(makeInput());
    const p2 = store.create(makeInput({ catId: 'sonnet' }));
    assert.notEqual(p1.id, p2.id);
  });

  // ── Get ──

  it('returns proposal by id', () => {
    const created = store.create(makeInput());
    const fetched = store.get(created.id);
    assert.ok(fetched);
    assert.equal(fetched.id, created.id);
  });

  it('returns null for unknown id', () => {
    assert.equal(store.get('nonexistent'), null);
  });

  // ── ListPending ──

  it('listPending returns only pending proposals for given user', () => {
    store.create(makeInput({ userId: 'user-1' }));
    store.create(makeInput({ userId: 'user-2' }));
    const p3 = store.create(makeInput({ userId: 'user-1' }));
    // reject one to ensure it's excluded
    store.markRejected(p3.id, 'not a taste signal', 'user-1');

    const pending = store.listPending('user-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'pending');
    assert.equal(pending[0].userId, 'user-1');
  });

  it('listPending returns results ordered by createdAt DESC', () => {
    const p1 = store.create(makeInput());
    const p2 = store.create(makeInput());
    const pending = store.listPending('user-1');
    assert.equal(pending.length, 2);
    assert.equal(pending[0].id, p2.id); // newer first
    assert.equal(pending[1].id, p1.id);
  });

  it('listActionable keeps approving proposals discoverable without changing listPending semantics', () => {
    const pending = store.create(makeInput());
    const approving = store.create(makeInput());
    store.claimForApproval(approving.id, 'user-1');

    assert.deepEqual(
      store.listPending('user-1').map((p) => p.id),
      [pending.id],
    );
    assert.deepEqual(new Set(store.listActionable('user-1').map((p) => p.id)), new Set([pending.id, approving.id]));
  });

  // ── Claim for Approval (CAS pending → approving) ──

  it('claimForApproval transitions pending → approving', () => {
    const created = store.create(makeInput());
    const claimed = store.claimForApproval(created.id, 'approver-1');
    assert.ok(claimed);
    assert.equal(claimed.status, 'approving');
  });

  it('claimForApproval on non-pending returns null (INV-3)', () => {
    const created = store.create(makeInput());
    // First claim succeeds
    store.claimForApproval(created.id, 'approver-1');
    // Second claim fails (already approving)
    const second = store.claimForApproval(created.id, 'approver-2');
    assert.equal(second, null);
  });

  it('claimForApproval on rejected returns null', () => {
    const created = store.create(makeInput());
    store.markRejected(created.id, 'wrong signal', 'user-1');
    assert.equal(store.claimForApproval(created.id, 'approver-1'), null);
  });

  it('records durable writer output while approval remains in progress', () => {
    const created = store.create(makeInput());
    store.claimForApproval(created.id, 'approver-1');

    const checkpointed = store.recordWriteCheckpoint(created.id, {
      vignetteSlug: 'authentic-expression-real',
      vignettePath: 'docs/taste/vignettes/real.md',
    });

    assert.equal(checkpointed.status, 'approving');
    assert.equal(checkpointed.vignetteSlug, 'authentic-expression-real');
    assert.equal(checkpointed.vignettePath, 'docs/taste/vignettes/real.md');
  });

  // ── Finalize Approval (CAS approving → approved) ──

  it('finalizeApproval transitions approving → approved with slug+path (INV-2)', () => {
    const created = store.create(makeInput());
    store.claimForApproval(created.id, 'approver-1');
    const approved = store.finalizeApproval(
      created.id,
      'approver-1',
      'authentic-expression-活人感',
      'docs/taste/vignettes/authentic-expression-活人感.md',
    );
    assert.ok(approved);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.vignetteSlug, 'authentic-expression-活人感');
    assert.equal(approved.vignettePath, 'docs/taste/vignettes/authentic-expression-活人感.md');
    assert.ok(approved.approvedAt > 0);
    assert.equal(approved.approvedBy, 'approver-1');
  });

  it('finalizeApproval on non-approving returns null (INV-2 guard)', () => {
    const created = store.create(makeInput());
    // Still pending, not approving
    const result = store.finalizeApproval(created.id, 'approver-1', 'slug', 'path');
    assert.equal(result, null);
  });

  it('finalizeApproval on already approved returns null', () => {
    const created = store.create(makeInput());
    store.claimForApproval(created.id, 'approver-1');
    store.finalizeApproval(created.id, 'approver-1', 'slug', 'path');
    // Try again
    assert.equal(store.finalizeApproval(created.id, 'approver-1', 'slug2', 'path2'), null);
  });

  // ── Rollback Claim (CAS approving → pending) ──

  it('rollbackClaim transitions approving → pending', () => {
    const created = store.create(makeInput());
    store.claimForApproval(created.id, 'approver-1');
    store.recordWriteCheckpoint(created.id, { vignetteSlug: 'slug', vignettePath: 'path' });
    const ok = store.rollbackClaim(created.id);
    assert.equal(ok, true);
    const fetched = store.get(created.id);
    assert.ok(fetched);
    assert.equal(fetched.status, 'pending');
    assert.equal(fetched.vignetteSlug, undefined);
    assert.equal(fetched.vignettePath, undefined);
  });

  it('rollbackClaim on non-approving returns false', () => {
    const created = store.create(makeInput());
    assert.equal(store.rollbackClaim(created.id), false); // still pending
  });

  // ── Mark Rejected (CAS pending → rejected) ──

  it('markRejected transitions pending → rejected with reason+decidedAt+decidedBy (INV-5)', () => {
    const created = store.create(makeInput());
    const rejected = store.markRejected(created.id, 'not a taste signal', 'rejector-1');
    assert.ok(rejected);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectionReason, 'not a taste signal');
    assert.ok(rejected.rejectedAt > 0);
    assert.equal(rejected.rejectedBy, 'rejector-1');
  });

  it('markRejected on approved returns null (INV-3)', () => {
    const created = store.create(makeInput());
    store.claimForApproval(created.id, 'approver-1');
    store.finalizeApproval(created.id, 'approver-1', 'slug', 'path');
    assert.equal(store.markRejected(created.id, 'too late', 'rejector-1'), null);
  });

  it('markRejected on approving returns null (must reject from pending)', () => {
    const created = store.create(makeInput());
    store.claimForApproval(created.id, 'approver-1');
    assert.equal(store.markRejected(created.id, 'nope', 'rejector-1'), null);
  });

  // ── ListSettledByUser ──

  it('listSettledByUser returns approved+rejected, ordered by decidedAt DESC (INV-4)', () => {
    const p1 = store.create(makeInput());
    const p2 = store.create(makeInput());
    const p3 = store.create(makeInput());

    store.markRejected(p1.id, 'wrong', 'user-1');
    store.claimForApproval(p2.id, 'user-1');
    store.finalizeApproval(p2.id, 'user-1', 'slug-2', 'path-2');
    // p3 stays pending — should NOT appear in settled

    const settled = store.listSettledByUser('user-1');
    assert.equal(settled.length, 2);
    // p2 approved after p1 rejected → p2 first (DESC)
    assert.equal(settled[0].id, p2.id);
    assert.equal(settled[1].id, p1.id);

    // Pending should NOT be in settled
    const pending = store.listPending('user-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, p3.id);
  });

  // ── Idempotency (ADV-4) ──

  it('idempotency: same clientRequestId returns same proposalId', () => {
    const reserved = store.reserveDedup('user-1', 'req-abc', 'proposal-xyz');
    assert.equal(reserved, 'proposal-xyz');

    // Reserve again with different proposalId → returns original
    const duplicate = store.reserveDedup('user-1', 'req-abc', 'proposal-different');
    assert.equal(duplicate, 'proposal-xyz');
  });

  it('getDedupProposalId returns null for unknown clientRequestId', () => {
    assert.equal(store.getDedupProposalId('user-1', 'nonexistent'), null);
  });

  it('getDedupProposalId returns reserved proposalId', () => {
    store.reserveDedup('user-1', 'req-abc', 'proposal-xyz');
    assert.equal(store.getDedupProposalId('user-1', 'req-abc'), 'proposal-xyz');
  });

  // ── P1-1 fix: create() uses pre-generated proposalId when provided ──

  it('create() uses provided proposalId instead of generating a new one', () => {
    const preGeneratedId = 'pre-generated-id-123';
    const created = store.create(makeInput({ proposalId: preGeneratedId }));
    assert.equal(created.id, preGeneratedId);

    // Verify the proposal is retrievable by the pre-generated ID
    const fetched = store.get(preGeneratedId);
    assert.ok(fetched);
    assert.equal(fetched.id, preGeneratedId);
  });

  it('dedup round-trip: reserve + create with same proposalId is consistent', () => {
    const proposalId = 'dedup-consistent-id';
    const clientRequestId = 'req-dedup-test';

    // Reserve the dedup entry
    const reserved = store.reserveDedup('user-1', clientRequestId, proposalId);
    assert.equal(reserved, proposalId);

    // Create with same proposalId
    const created = store.create(makeInput({ proposalId, clientRequestId }));
    assert.equal(created.id, proposalId);

    // Lookup via dedup cache → should find the real proposal
    const cachedId = store.getDedupProposalId('user-1', clientRequestId);
    assert.equal(cachedId, proposalId);

    const fetched = store.get(cachedId);
    assert.ok(fetched);
    assert.equal(fetched.id, proposalId);
  });

  // ── R2 P1: dedup loser path — winner reserved but not yet persisted ──

  it('dedup loser: reserveDedup returns winner ID, but get(winner) returns null before create', () => {
    const winnerId = 'winner-id';
    const loserId = 'loser-id';

    // Winner reserves first
    const reserved = store.reserveDedup('user-1', 'req-race', winnerId);
    assert.equal(reserved, winnerId);

    // Loser tries to reserve same clientRequestId — gets winner's ID back
    const loserResult = store.reserveDedup('user-1', 'req-race', loserId);
    assert.equal(loserResult, winnerId, 'loser should get winner ID');

    // Winner has NOT called create() yet — get returns null
    assert.equal(store.get(winnerId), null, 'winner proposal not yet persisted');

    // This is the race window: loser knows winner ID but winner hasn't persisted.
    // Route must return 503 retryable here, NOT fall through to create.
  });

  // ── ADV-1: Approving state survives, can rollback ──

  it('ADV-1: approving state can be recovered via rollback', () => {
    const created = store.create(makeInput());
    store.claimForApproval(created.id, 'approver-1');

    // Simulate "crash recovery" — read back approving proposal
    const stuck = store.get(created.id);
    assert.ok(stuck);
    assert.equal(stuck.status, 'approving');

    // Recovery: rollback to pending
    assert.equal(store.rollbackClaim(created.id), true);
    const recovered = store.get(created.id);
    assert.ok(recovered);
    assert.equal(recovered.status, 'pending');

    // Can re-claim
    const reclaimed = store.claimForApproval(created.id, 'approver-2');
    assert.ok(reclaimed);
    assert.equal(reclaimed.status, 'approving');
  });

  // ── ADV-2: Concurrent claim+reject, only one succeeds ──

  it('ADV-2: claim then reject same proposal — reject fails', () => {
    const created = store.create(makeInput());
    store.claimForApproval(created.id, 'approver-1');
    // Another "session" tries to reject — should fail (not pending anymore)
    assert.equal(store.markRejected(created.id, 'nope', 'rejector-1'), null);
  });

  // ── Clone isolation ──

  it('returned proposals are clones (mutations do not affect store)', () => {
    const created = store.create(makeInput());
    created.scene = 'MUTATED';
    const fetched = store.get(created.id);
    assert.ok(fetched);
    assert.notEqual(fetched.scene, 'MUTATED');
  });
});
