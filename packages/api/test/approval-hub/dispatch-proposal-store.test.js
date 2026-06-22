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
    sourceThreadId: 'thread-sender',
    targetThreadId: 'thread-target',
    senderCatId: 'opus',
    ownerUserId: 'user-1',
    content: 'Fix the bug in package X',
    targetCats: ['sonnet'],
    createdAt: Date.now(),
    ...overrides,
  });

  it('create stores proposal with status=pending', async () => {
    const store = new InMemoryDispatchProposalStore();
    const proposal = await store.create(createInput());

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
    await store.create(createInput({ proposalId: 'dp-1', ownerUserId: 'user-1' }));
    await store.create(createInput({ proposalId: 'dp-2', ownerUserId: 'user-1' }));
    await store.create(createInput({ proposalId: 'dp-3', ownerUserId: 'user-2' }));

    const items = await store.listPendingByUser('user-1');
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.ownerUserId === 'user-1'));
  });

  it('listPendingByUser excludes approved/rejected', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-1' }));
    await store.create(createInput({ proposalId: 'dp-2' }));
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
});
