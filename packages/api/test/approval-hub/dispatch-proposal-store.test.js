import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('DispatchProposalStore (in-memory)', () => {
  let InMemoryDispatchProposalStore;

  beforeEach(async () => {
    ({ InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    ));
  });

  const createInput = (overrides = {}) => ({
    proposalId: 'dp-001',
    sourceInvocationId: 'invocation-001',
    sourceThreadId: 'thread-sender',
    targetThreadId: 'thread-target',
    senderCatId: 'opus',
    ownerUserId: 'user-1',
    content: 'Fix the bug in package X',
    targetCats: ['sonnet'],
    createdAt: Date.now(),
    ...overrides,
  });

  async function anchor(store, proposalId) {
    const proposal = await store.get(proposalId);
    await store.commitEnvelope(proposalId, {
      canonicalProposalId: proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      originRef: {
        kind: 'event',
        anchor: `test:${proposalId}`,
        summary: 'test',
        threadId: proposal.sourceThreadId,
      },
      approvalCardRef: {
        threadId: proposal.sourceThreadId,
        messageId: `card-${proposalId}`,
      },
      createdAt: proposal.createdAt,
    });
  }

  const negativeLookup = {
    ownerUserId: 'user-1',
    sourceInvocationId: 'invocation-001',
    sourceThreadId: 'thread-sender',
    senderCatId: 'opus',
    targetThreadId: 'thread-target',
    targetCats: ['sonnet'],
  };

  it('create stores proposal with status=pending', async () => {
    const store = new InMemoryDispatchProposalStore();
    const result = await store.create(createInput());
    const proposal = result.proposal;

    assert.equal(proposal.proposalId, 'dp-001');
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.effectClass, 'assign_work');
    assert.equal(proposal.content, 'Fix the bug in package X');
    assert.equal(proposal.deliveredMessageId, undefined);
  });

  it('get retrieves by proposalId', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());

    const found = await store.get('dp-001');
    assert.equal(found?.proposalId, 'dp-001');
    assert.equal(found?.status, 'pending');
  });

  it('get returns null for unknown ID', async () => {
    const store = new InMemoryDispatchProposalStore();
    const found = await store.get('nonexistent');
    assert.equal(found, null);
  });

  it('listPendingByUser returns only pending for the user', async () => {
    const store = new InMemoryDispatchProposalStore();
    // Different targetThreadIds to avoid same-K superseding
    await store.create(createInput({ proposalId: 'dp-1', ownerUserId: 'user-1', targetThreadId: 'thread-A' }));
    await store.create(createInput({ proposalId: 'dp-2', ownerUserId: 'user-1', targetThreadId: 'thread-B' }));
    await store.create(createInput({ proposalId: 'dp-3', ownerUserId: 'user-2', targetThreadId: 'thread-C' }));

    const items = await store.listPendingByUser('user-1');
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.ownerUserId === 'user-1'));
  });

  it('listPendingByUser excludes approved/rejected', async () => {
    const store = new InMemoryDispatchProposalStore();
    // Different targetThreadIds to avoid same-K superseding
    await store.create(createInput({ proposalId: 'dp-1', targetThreadId: 'thread-A' }));
    await store.create(createInput({ proposalId: 'dp-2', targetThreadId: 'thread-B' }));
    await store.approve('dp-1', 'user-1');

    const items = await store.listPendingByUser('user-1');
    assert.equal(items.length, 1);
    assert.equal(items[0].proposalId, 'dp-2');
  });

  it('approve: CAS pending→approved, then recordDelivery sets deliveredMessageId', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());

    const result = await store.approve('dp-001', 'user-1');
    assert.equal(result?.status, 'approved');
    assert.equal(result?.deliveredMessageId, undefined, 'approve does not set deliveredMessageId');
    assert.equal(result?.decidedBy, 'user-1');
    assert.ok(result?.decidedAt > 0);

    await store.recordDelivery('dp-001', 'msg-delivered-123');
    const fetched = await store.get('dp-001');
    assert.equal(fetched?.deliveredMessageId, 'msg-delivered-123');
  });

  it('approve on non-pending returns null (INV-2)', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());
    await store.approve('dp-001', 'user-1');

    // Second approve — already approved
    const result = await store.approve('dp-001', 'user-1');
    assert.equal(result, null);
  });

  it('approve on nonexistent returns null', async () => {
    const store = new InMemoryDispatchProposalStore();
    const result = await store.approve('nonexistent', 'user-1');
    assert.equal(result, null);
  });

  it('reject: CAS pending→rejected, removes from pending index', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());

    const result = await store.reject('dp-001', 'user-1');
    assert.equal(result?.status, 'rejected');
    assert.equal(result?.decidedBy, 'user-1');
    assert.ok(result?.decidedAt > 0);

    // Should not appear in pending list
    const items = await store.listPendingByUser('user-1');
    assert.equal(items.length, 0);
  });

  it('reject on non-pending returns null (INV-2)', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());
    await store.reject('dp-001', 'user-1');

    const result = await store.reject('dp-001', 'user-1');
    assert.equal(result, null);
  });

  it('findByClientMessageId returns matching proposal', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ clientMessageId: 'idempotent-key-1' }));

    const found = await store.findByClientMessageId('idempotent-key-1', 'thread-sender');
    assert.equal(found?.proposalId, 'dp-001');
  });

  it('findByClientMessageId returns null for no match', async () => {
    const store = new InMemoryDispatchProposalStore();
    const found = await store.findByClientMessageId('unknown', 'thread-sender');
    assert.equal(found, null);
  });

  it('double approve: second returns null (INV-5)', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());

    const first = await store.approve('dp-001', 'user-1');
    assert.equal(first?.status, 'approved');

    const second = await store.approve('dp-001', 'user-1');
    assert.equal(second, null); // Already approved, no-op
  });

  it('revertToPending: approved → pending (Cloud P1-2 delivery failure recovery)', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());
    await store.approve('dp-001', 'user-1');

    const reverted = await store.revertToPending('dp-001');
    assert.equal(reverted?.status, 'pending');
    assert.equal(reverted?.decidedAt, undefined);
    assert.equal(reverted?.decidedBy, undefined);

    // Should appear in pending list again
    const pending = await store.listPendingByUser('user-1');
    assert.equal(pending.length, 1);

    // Can be approved again (retry path)
    const reapproved = await store.approve('dp-001', 'user-1');
    assert.equal(reapproved?.status, 'approved');
  });

  it('revertToPending on pending/rejected returns null', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());

    // Pending → revert should fail (only approved → pending is valid)
    const fromPending = await store.revertToPending('dp-001');
    assert.equal(fromPending, null);

    // Reject then try revert
    await store.reject('dp-001', 'user-1');
    const fromRejected = await store.revertToPending('dp-001');
    assert.equal(fromRejected, null);
  });

  it('approve+reject race: first wins (INV-2 CAS)', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());

    const approved = await store.approve('dp-001', 'user-1');
    assert.equal(approved?.status, 'approved');

    const rejected = await store.reject('dp-001', 'user-1');
    assert.equal(rejected, null); // Already approved
  });

  // === F246 Phase J: Superseded (AC-J4, INV-J5, INV-J6) ===

  it('create returns { proposal, supersededProposals } result shape', async () => {
    const store = new InMemoryDispatchProposalStore();
    const result = await store.create(createInput());

    assert.ok(result.proposal, 'result must have proposal');
    assert.ok(Array.isArray(result.supersededProposals), 'result must have supersededProposals array');
    assert.equal(result.proposal.proposalId, 'dp-001');
    assert.equal(result.proposal.status, 'pending');
    assert.equal(result.supersededProposals.length, 0, 'first create has nothing to supersede');
  });

  it('same-K create atomically supersedes old pending proposal (AC-J4)', async () => {
    const store = new InMemoryDispatchProposalStore();
    // First proposal: same source→target→sender
    await store.create(createInput({ proposalId: 'dp-old' }));
    await anchor(store, 'dp-old');

    // Second proposal: same K (same source, target, sender)
    const result = await store.create(createInput({ proposalId: 'dp-new', content: 'Updated work' }));

    // New proposal is pending
    assert.equal(result.proposal.proposalId, 'dp-new');
    assert.equal(result.proposal.status, 'pending');

    // Old proposal is superseded
    assert.equal(result.supersededProposals.length, 1);
    assert.equal(result.supersededProposals[0].proposalId, 'dp-old');
    assert.equal(result.supersededProposals[0].status, 'superseded');
    assert.equal(result.supersededProposals[0].supersededBy, 'dp-new');

    // Verify old proposal in store is also superseded
    const old = await store.get('dp-old');
    assert.equal(old?.status, 'superseded');
    assert.equal(old?.supersededBy, 'dp-new');
  });

  it('same-K dual pending cannot coexist (INV-J5)', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-1' }));
    await anchor(store, 'dp-1');
    await store.create(createInput({ proposalId: 'dp-2' }));
    await anchor(store, 'dp-2');
    await store.create(createInput({ proposalId: 'dp-3' }));

    // Only the latest should be pending
    const pending = await store.listPendingByUser('user-1');
    const sameKPending = pending.filter(
      (p) => p.sourceThreadId === 'thread-sender' && p.targetThreadId === 'thread-target' && p.senderCatId === 'opus',
    );
    assert.equal(sameKPending.length, 1, 'only one pending proposal per lineage K');
    assert.equal(sameKPending[0].proposalId, 'dp-3');
  });

  it('different-K proposals do not supersede each other', async () => {
    const store = new InMemoryDispatchProposalStore();
    // Different target threads = different K
    await store.create(createInput({ proposalId: 'dp-1', targetThreadId: 'thread-A' }));
    const result = await store.create(createInput({ proposalId: 'dp-2', targetThreadId: 'thread-B' }));

    assert.equal(result.supersededProposals.length, 0, 'different K should not supersede');

    // Both should be pending
    const dp1 = await store.get('dp-1');
    const dp2 = await store.get('dp-2');
    assert.equal(dp1?.status, 'pending');
    assert.equal(dp2?.status, 'pending');
  });

  it('superseded proposal cannot be approved (INV-J6)', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-old' }));
    await anchor(store, 'dp-old');
    await store.create(createInput({ proposalId: 'dp-new' }));

    // Old is now superseded — approve should fail
    const result = await store.approve('dp-old', 'user-1');
    assert.equal(result, null, 'superseded proposal must not be approvable');
  });

  it('superseded proposal cannot be rejected (INV-J6)', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-old' }));
    await anchor(store, 'dp-old');
    await store.create(createInput({ proposalId: 'dp-new' }));

    const result = await store.reject('dp-old', 'user-1');
    assert.equal(result, null, 'superseded proposal must not be rejectable');
  });

  it('listPendingByUser excludes superseded proposals', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-old' }));
    await anchor(store, 'dp-old');
    await store.create(createInput({ proposalId: 'dp-new' }));

    const pending = await store.listPendingByUser('user-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].proposalId, 'dp-new');
  });

  it('superseded proposal does not appear in settled list', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-old' }));
    await anchor(store, 'dp-old');
    await store.create(createInput({ proposalId: 'dp-new' }));

    // Superseded is terminal but not a operator decision — should not be in settled
    const settled = await store.listSettledByUser('user-1', 10);
    assert.equal(settled.length, 0, 'superseded proposals should not appear in settled');
  });

  it('already-approved proposal is not superseded by new same-K create', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-decided' }));
    await store.approve('dp-decided', 'user-1');

    // New same-K create — should NOT supersede the already-decided proposal
    const r2 = await store.create(createInput({ proposalId: 'dp-new' }));
    assert.equal(r2.supersededProposals.length, 0, 'decided proposals should not be superseded');

    const decided = await store.get('dp-decided');
    assert.equal(decided?.status, 'approved', 'decided proposal status must not change');
  });

  // === F246 Phase J: revertToPending lineage guard (INV-J5) ===

  it('revertToPending with no successor → reverts to pending normally', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-sole' }));
    await store.approve('dp-sole', 'user-1');

    const reverted = await store.revertToPending('dp-sole');
    assert.ok(reverted, 'should revert when no successor exists');
    assert.equal(reverted.status, 'pending');
    assert.equal(reverted.decidedAt, undefined);
    assert.equal(reverted.decidedBy, undefined);
  });

  it('revertToPending with successor → superseded, returns null (INV-J5)', async () => {
    const store = new InMemoryDispatchProposalStore();
    // Create dp-old, approve it, then create dp-new (same K → lineage moves to dp-new)
    await store.create(createInput({ proposalId: 'dp-old', createdAt: 1000 }));
    await store.approve('dp-old', 'user-1');
    // dp-old is approved (not pending), so create doesn't supersede it, but lineage moves
    await store.create(createInput({ proposalId: 'dp-new', createdAt: 2000 }));

    // Now simulate delivery failure: dp-old tries to revert
    const reverted = await store.revertToPending('dp-old');
    assert.equal(reverted, null, 'must fail — successor holds lineage');

    // dp-old should now be superseded (not pending)
    const old = await store.get('dp-old');
    assert.equal(old?.status, 'superseded');
    assert.equal(old?.supersededBy, 'dp-new');

    // dp-new is still the only pending (INV-J5: no dual pending)
    const pending = await store.listPendingByUser('user-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].proposalId, 'dp-new');
  });

  it('#1291: deny-only lookup follows pending → approved → pending → rejected lifecycle', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());

    assert.deepEqual(await store.findNegativeAuthorizationBlocks(negativeLookup), [
      { proposalId: 'dp-001', status: 'pending', targetCats: ['sonnet'] },
    ]);

    await store.approve('dp-001', 'user-1');
    assert.deepEqual(await store.findNegativeAuthorizationBlocks(negativeLookup), []);

    await store.revertToPending('dp-001');
    assert.deepEqual(await store.findNegativeAuthorizationBlocks(negativeLookup), [
      { proposalId: 'dp-001', status: 'pending', targetCats: ['sonnet'] },
    ]);

    await store.reject('dp-001', 'user-1');
    assert.deepEqual(await store.findNegativeAuthorizationBlocks(negativeLookup), [
      { proposalId: 'dp-001', status: 'rejected', targetCats: ['sonnet'] },
    ]);
  });

  it('#1291: legacy cutover cannot activate until canonical index rebuild has completed', async () => {
    const store = new InMemoryDispatchProposalStore();
    await assert.rejects(
      () => store.establishNegativeAuthorizationLegacyCutoverAt(1_000),
      /requires a completed canonical index rebuild/,
    );
    await store.rebuildNegativeAuthorizationIndexes();
    assert.equal(await store.establishNegativeAuthorizationLegacyCutoverAt(1_000), 1_000);
  });

  it('#1291: supersede retains both denials and abort removes only the staged successor', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-old' }));
    await anchor(store, 'dp-old');
    await store.create(createInput({ proposalId: 'dp-new', content: 'replacement' }));

    assert.deepEqual(await store.findNegativeAuthorizationBlocks(negativeLookup), [
      { proposalId: 'dp-new', status: 'pending', targetCats: ['sonnet'] },
      { proposalId: 'dp-old', status: 'superseded', targetCats: ['sonnet'] },
    ]);

    await store.abortStaged('dp-new', 'test rollback');
    assert.deepEqual(await store.findNegativeAuthorizationBlocks(negativeLookup), [
      { proposalId: 'dp-old', status: 'pending', targetCats: ['sonnet'] },
    ]);
  });
});
