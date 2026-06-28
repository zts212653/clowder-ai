import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F193ApprovalAdapter', () => {
  let InMemoryDispatchProposalStore;
  let F193ApprovalAdapter;

  beforeEach(async () => {
    ({ InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    ));
    ({ F193ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F193ApprovalAdapter.js'));
  });

  const createInput = (overrides = {}) => ({
    proposalId: 'dp-001',
    sourceThreadId: 'thread-sender',
    targetThreadId: 'thread-target',
    senderCatId: 'opus',
    ownerUserId: 'user-1',
    content: 'Fix the bug in package X',
    targetCats: ['sonnet'],
    cardMessageId: 'msg-card-1',
    createdAt: Date.now(),
    ...overrides,
  });

  it('maps pending DispatchProposals to ApprovalItems', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput());

    const adapter = new F193ApprovalAdapter(store);
    const items = await adapter.listPending('user-1');

    assert.equal(items.length, 1);
    assert.equal(items[0].sourceFeatureId, 'F193');
    assert.equal(items[0].ownerUserId, 'user-1');
    assert.equal(items[0].status, 'pending');
    assert.equal(items[0].inlineApprovable, true);
    assert.ok(items[0].summary.includes('Fix the bug'));
    assert.equal(items[0].detail.targetThreadId, 'thread-target');
    assert.deepEqual(items[0].detail.targetCats, ['sonnet']);
    assert.equal(items[0].detail.effectClass, 'assign_work');
    assert.equal(items[0].sourceMessageId, 'msg-card-1');
    assert.equal(items[0].requesterCatId, 'opus');
  });

  it('returns empty for user with no pending proposals', async () => {
    const store = new InMemoryDispatchProposalStore();
    const adapter = new F193ApprovalAdapter(store);
    const items = await adapter.listPending('nobody');
    assert.equal(items.length, 0);
  });

  it('excludes approved/rejected proposals', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ proposalId: 'dp-1' }));
    await store.create(createInput({ proposalId: 'dp-2' }));
    await store.approve('dp-1', 'user-1');

    const adapter = new F193ApprovalAdapter(store);
    const items = await adapter.listPending('user-1');
    assert.equal(items.length, 1);
    assert.equal(items[0].proposalId, 'dp-2');
  });

  it('featureId is F193', async () => {
    const store = new InMemoryDispatchProposalStore();
    const adapter = new F193ApprovalAdapter(store);
    assert.equal(adapter.featureId, 'F193');
  });

  it('expiresAt is set (3 day stale threshold)', async () => {
    const now = Date.now();
    const store = new InMemoryDispatchProposalStore();
    await store.create(createInput({ createdAt: now }));

    const adapter = new F193ApprovalAdapter(store);
    const items = await adapter.listPending('user-1');
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    assert.equal(items[0].expiresAt, now + threeDaysMs);
  });
});
