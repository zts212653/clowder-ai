import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { anchorApproval } from './helpers.js';

describe('F231ApprovalAdapter', () => {
  let InMemoryProfileUpdateProposalStore;
  let F231ApprovalAdapter;

  beforeEach(async () => {
    ({ InMemoryProfileUpdateProposalStore } = await import(
      '../../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js'
    ));
    ({ F231ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F231ApprovalAdapter.js'));
  });

  const createStagedProposal = (store, overrides = {}) =>
    store.create({
      sourceThreadId: 't-1',
      sourceInvocationId: 'inv-1',
      sourceCatId: 'opus',
      targetLayer: 'primer',
      targetPath: '/data/primers/opus.md',
      beforeContent: 'old content',
      baseContentHash: 'abc123',
      afterContent: 'new content',
      rationale: 'Observed operator prefers concise updates',
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 't-1' },
      createdBy: 'user-1',
      ...overrides,
    });

  const createProposal = (store, overrides = {}) => {
    const proposal = createStagedProposal(store, overrides);
    anchorApproval(store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F231',
      ownerUserId: proposal.createdBy,
      requesterCatId: proposal.sourceCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });
    return proposal;
  };

  const withoutPublication = ({ publication: _publication, ...proposal }) => proposal;

  it('maps pending ProfileUpdateProposals to ApprovalItems', () => {
    const store = new InMemoryProfileUpdateProposalStore();
    createProposal(store);

    const adapter = new F231ApprovalAdapter(store);
    const items = adapter.listPending('user-1');

    assert.equal(items.length, 1);
    assert.equal(items[0].sourceFeatureId, 'F231');
    assert.equal(items[0].ownerUserId, 'user-1');
    assert.equal(items[0].status, 'pending');
    assert.equal(items[0].inlineApprovable, false);
    assert.ok(items[0].summary.includes('Profile update'));
    assert.equal(items[0].navigation.state, 'anchored');
  });

  it('computes expiresAt as createdAt + 7 days', () => {
    const store = new InMemoryProfileUpdateProposalStore();
    const p = createProposal(store);

    const adapter = new F231ApprovalAdapter(store);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.expiresAt, p.createdAt + 7 * 24 * 60 * 60 * 1000);
  });

  it('returns empty for user with no pending proposals', () => {
    const store = new InMemoryProfileUpdateProposalStore();
    const adapter = new F231ApprovalAdapter(store);
    assert.deepEqual(adapter.listPending('nobody'), []);
  });

  it('sets requesterCatId from sourceCatId', () => {
    const store = new InMemoryProfileUpdateProposalStore();
    createProposal(store, { sourceCatId: 'sonnet' });

    const adapter = new F231ApprovalAdapter(store);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.requesterCatId, 'sonnet');
  });

  it('includes rationale, targetLayer, targetPath in detail', () => {
    const store = new InMemoryProfileUpdateProposalStore();
    createProposal(store);

    const adapter = new F231ApprovalAdapter(store);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.detail.rationale, 'Observed operator prefers concise updates');
    assert.equal(item.detail.targetLayer, 'primer');
    assert.equal(item.detail.targetPath, '/data/primers/opus.md');
  });

  it('classifies a pre-I card marker as legacy instead of guessing dual anchors', () => {
    const store = new InMemoryProfileUpdateProposalStore();
    const p = createStagedProposal(store);
    store.setCardMessageId(p.proposalId, 'msg-card-456');

    const adapter = new F231ApprovalAdapter({
      listPending: (...args) => store.listPending(...args).map(withoutPublication),
    });
    const [item] = adapter.listPending('user-1');
    assert.deepEqual(item.navigation, {
      state: 'legacy_unanchored',
      legacyThreadId: 't-1',
      legacyMessageId: 'msg-card-456',
    });
  });

  it('includes signal provenance kind in detail', () => {
    const store = new InMemoryProfileUpdateProposalStore();
    createProposal(store, {
      signalProvenance: { kind: 'cvo-instructed', sourceThreadId: 't-2' },
    });

    const adapter = new F231ApprovalAdapter(store);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.detail.signalKind, 'cvo-instructed');
  });

  // F246 Phase H: listSettled()
  describe('listSettled', () => {
    const settleProposal = (store, proposal, outcome = 'approved') => {
      if (outcome === 'approved') {
        store.claimForApproval(proposal.proposalId, 'user-1'); // pending → approving
        store.finalizeApproval(proposal.proposalId); // approving → approved
      } else {
        store.markRejected(proposal.proposalId, 'user-1', 'not needed'); // pending → rejected
      }
    };

    it('returns empty when no proposals have been settled', async () => {
      const store = new InMemoryProfileUpdateProposalStore();
      const adapter = new F231ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');
      assert.deepEqual(items, []);
    });

    it('returns approved proposals as SettledApprovalItem', async () => {
      const store = new InMemoryProfileUpdateProposalStore();
      const p = createProposal(store);
      settleProposal(store, p, 'approved');

      const adapter = new F231ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 1);
      assert.equal(items[0].proposalId, p.proposalId);
      assert.equal(items[0].sourceFeatureId, 'F231');
      assert.equal(items[0].status, 'approved');
      assert.ok(items[0].decidedAt > 0, 'decidedAt must be set');
    });

    it('returns rejected proposals as SettledApprovalItem', async () => {
      const store = new InMemoryProfileUpdateProposalStore();
      const p = createProposal(store);
      settleProposal(store, p, 'rejected');

      const adapter = new F231ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 1);
      assert.equal(items[0].status, 'rejected');
    });

    it('excludes pending proposals from settled list', async () => {
      const store = new InMemoryProfileUpdateProposalStore();
      createProposal(store); // pending — should NOT appear
      const settled = createProposal(store, { sourceInvocationId: 'inv-2' });
      settleProposal(store, settled, 'approved');

      const adapter = new F231ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');
      assert.equal(items.length, 1);
      assert.equal(items[0].proposalId, settled.proposalId);
    });

    it('orders by decidedAt descending', async () => {
      const store = new InMemoryProfileUpdateProposalStore();
      const p1 = createProposal(store, { sourceInvocationId: 'inv-1' });
      settleProposal(store, p1, 'approved');
      // Busy-wait 2ms so p2 gets a strictly later approvedAt timestamp
      const until = Date.now() + 2;
      while (Date.now() < until) {} // eslint-disable-line no-empty
      const p2 = createProposal(store, { sourceInvocationId: 'inv-2' });
      settleProposal(store, p2, 'approved');

      const adapter = new F231ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');
      // p2 settled after p1, so p2 should appear first (decidedAt descending)
      assert.equal(items[0].proposalId, p2.proposalId);
    });

    it('keeps settled pre-I card markers explicitly legacy', async () => {
      const store = new InMemoryProfileUpdateProposalStore();
      const p = createStagedProposal(store);
      store.setCardMessageId(p.proposalId, 'msg-card-789');
      settleProposal(store, p, 'approved');

      const adapter = new F231ApprovalAdapter({
        listSettledByUser: (...args) => store.listSettledByUser(...args).map(withoutPublication),
      });
      const [item] = await adapter.listSettled('user-1');
      assert.deepEqual(item.navigation, {
        state: 'legacy_unanchored',
        legacyThreadId: 't-1',
        legacyMessageId: 'msg-card-789',
      });
    });

    it('respects limit option', async () => {
      const store = new InMemoryProfileUpdateProposalStore();
      for (let i = 0; i < 5; i++) {
        const p = createProposal(store, { sourceInvocationId: `inv-${i}` });
        settleProposal(store, p, 'approved');
      }

      const adapter = new F231ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1', { limit: 3 });
      assert.equal(items.length, 3);
    });
  });
});
