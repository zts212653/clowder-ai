import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F128ApprovalAdapter', () => {
  let InMemoryProposalStore;
  let F128ApprovalAdapter;

  beforeEach(async () => {
    ({ InMemoryProposalStore } = await import('../../dist/domains/cats/services/stores/ports/ProposalStore.js'));
    ({ F128ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F128ApprovalAdapter.js'));
  });

  const createProposal = (store, overrides = {}) =>
    store.create({
      sourceThreadId: 't-1',
      sourceInvocationId: 'inv-1',
      sourceCatId: 'opus',
      title: 'New investigation',
      reason: 'Need separate thread',
      parentThreadId: 't-parent',
      preferredCats: ['opus'],
      projectPath: '/p',
      createdBy: 'user-1',
      ...overrides,
    });

  it('maps pending ThreadProposals to ApprovalItems', () => {
    const proposalStore = new InMemoryProposalStore();
    createProposal(proposalStore);

    const adapter = new F128ApprovalAdapter(proposalStore);
    const items = adapter.listPending('user-1');

    assert.equal(items.length, 1);
    assert.equal(items[0].sourceFeatureId, 'F128');
    assert.equal(items[0].ownerUserId, 'user-1');
    assert.equal(items[0].status, 'pending');
    assert.equal(items[0].inlineApprovable, false);
    assert.ok(items[0].summary.includes('New investigation'));
    assert.equal(items[0].detail.title, 'New investigation');
    assert.equal(items[0].detail.reason, 'Need separate thread');
    assert.equal(items[0].detail.parentThreadId, 't-parent');
    assert.deepEqual(items[0].detail.preferredCats, ['opus']);
    assert.equal(items[0].detail.projectPath, '/p');
  });

  it('returns empty for user with no pending proposals', () => {
    const proposalStore = new InMemoryProposalStore();
    const adapter = new F128ApprovalAdapter(proposalStore);
    const items = adapter.listPending('nobody');
    assert.deepEqual(items, []);
  });

  it('computes expiresAt as createdAt + 7 days', () => {
    const proposalStore = new InMemoryProposalStore();
    const p = createProposal(proposalStore);

    const adapter = new F128ApprovalAdapter(proposalStore);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.expiresAt, p.createdAt + 7 * 24 * 60 * 60 * 1000);
  });

  it('sets requesterCatId from sourceCatId', () => {
    const proposalStore = new InMemoryProposalStore();
    createProposal(proposalStore, { sourceCatId: 'sonnet' });

    const adapter = new F128ApprovalAdapter(proposalStore);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.requesterCatId, 'sonnet');
  });
});
