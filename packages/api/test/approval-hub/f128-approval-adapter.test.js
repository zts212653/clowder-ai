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

  // F246 Phase G: listSettled — approval history for F128 thread proposals
  describe('listSettled', () => {
    const approveProposal = (store, proposal) => {
      store.claimForApproval({ proposalId: proposal.proposalId, approvedBy: 'user-1' });
      store.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: 't-new' });
    };

    it('returns approved proposals as SettledApprovalItems', async () => {
      const proposalStore = new InMemoryProposalStore();
      const p = createProposal(proposalStore);
      approveProposal(proposalStore, p);

      const adapter = new F128ApprovalAdapter(proposalStore);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 1);
      assert.equal(items[0].proposalId, p.proposalId);
      assert.equal(items[0].sourceFeatureId, 'F128');
      assert.equal(items[0].status, 'approved');
      assert.equal(items[0].ownerUserId, 'user-1');
      assert.ok(typeof items[0].decidedAt === 'number');
      assert.ok(typeof items[0].decidedBy === 'string');
    });

    it('returns rejected proposals as SettledApprovalItems', async () => {
      const proposalStore = new InMemoryProposalStore();
      const p = createProposal(proposalStore);
      proposalStore.markRejected({ proposalId: p.proposalId, rejectedBy: 'user-1' });

      const adapter = new F128ApprovalAdapter(proposalStore);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 1);
      assert.equal(items[0].status, 'rejected');
      assert.equal(items[0].decidedBy, 'user-1');
    });

    it('does NOT return pending proposals in listSettled', async () => {
      const proposalStore = new InMemoryProposalStore();
      createProposal(proposalStore); // stays pending

      const adapter = new F128ApprovalAdapter(proposalStore);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 0, 'pending proposals must NOT appear in settled history');
    });

    it('returns empty for user with no settled proposals', async () => {
      const proposalStore = new InMemoryProposalStore();
      const adapter = new F128ApprovalAdapter(proposalStore);
      const items = await adapter.listSettled('nobody');
      assert.deepEqual(items, []);
    });

    it('fetches beyond store DEFAULT_LIST_LIMIT to avoid truncating recently-settled old proposals', async () => {
      // Regression for P2: listByUser() has DEFAULT_LIST_LIMIT=100. Before the fix, calling
      // listByUser(userId) without an explicit limit would truncate at 100. If the oldest
      // proposal (position 100 in createdAt-desc order) was settled most recently, it would
      // be silently excluded before filter+sort.
      const proposalStore = new InMemoryProposalStore();

      // Create the oldest proposal first — it will end up at createdAt-desc position 100
      const oldestProposal = createProposal(proposalStore);

      // Busy-wait 2ms so subsequent proposals get strictly newer createdAt
      const until = Date.now() + 2;
      while (Date.now() < until) {} // eslint-disable-line no-empty

      // Create 100 more proposals (all newer createdAt — fill positions 0-99 in createdAt-desc)
      for (let i = 0; i < 100; i++) {
        createProposal(proposalStore);
      }
      // Total: 101 proposals. oldestProposal lands at position 100 (0-based) in createdAt-desc,
      // which is CUT OFF by DEFAULT_LIST_LIMIT=100 if we don't bypass the store default.

      // Settle the oldest proposal (it would be invisible without the fix)
      proposalStore.claimForApproval({ proposalId: oldestProposal.proposalId, approvedBy: 'user-1' });
      proposalStore.finalizeApproval({ proposalId: oldestProposal.proposalId, createdThreadId: 't-new' });

      const adapter = new F128ApprovalAdapter(proposalStore);
      const items = await adapter.listSettled('user-1');

      assert.ok(
        items.some((item) => item.proposalId === oldestProposal.proposalId),
        'oldest proposal must appear in settled history even when total proposals exceeds DEFAULT_LIST_LIMIT',
      );
    });

    it('sorts settled proposals by decidedAt desc, not by createdAt', async () => {
      const proposalStore = new InMemoryProposalStore();
      // p1 created first (older createdAt → appears LAST in listByUser's createdAt-desc order)
      const p1 = createProposal(proposalStore);

      // Busy-wait ~2ms between creations so p2.createdAt > p1.createdAt (reliable ordering)
      let until = Date.now() + 2;
      while (Date.now() < until) {} // eslint-disable-line no-empty

      // p2 created second (newer createdAt → appears FIRST in listByUser's createdAt-desc order)
      const p2 = createProposal(proposalStore);

      // Reject p2 first (earlier decidedAt)
      proposalStore.markRejected({ proposalId: p2.proposalId, rejectedBy: 'user-1' });

      // Busy-wait ~2ms so p1.approvedAt > p2.rejectedAt (reliable decidedAt ordering)
      until = Date.now() + 2;
      while (Date.now() < until) {} // eslint-disable-line no-empty

      // Approve p1 second (later decidedAt)
      proposalStore.claimForApproval({ proposalId: p1.proposalId, approvedBy: 'user-1' });
      proposalStore.finalizeApproval({ proposalId: p1.proposalId, createdThreadId: 't-new' });

      const adapter = new F128ApprovalAdapter(proposalStore);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 2);
      // p1 was decided more recently → must appear first (decidedAt desc)
      assert.equal(items[0].proposalId, p1.proposalId, 'most recently decided proposal must appear first');
      assert.equal(items[1].proposalId, p2.proposalId);
      assert.ok(items[0].decidedAt >= items[1].decidedAt, 'must be sorted by decidedAt descending');
    });
  });
});
