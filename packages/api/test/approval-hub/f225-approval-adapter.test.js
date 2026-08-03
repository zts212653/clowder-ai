import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { anchorApproval } from './helpers.js';

describe('F225ApprovalAdapter', () => {
  let InMemorySessionHandoffProposalStore;
  let F225ApprovalAdapter;

  beforeEach(async () => {
    ({ InMemorySessionHandoffProposalStore } = await import(
      '../../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js'
    ));
    ({ F225ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F225ApprovalAdapter.js'));
  });

  const createStagedHandoff = (store, overrides = {}) =>
    store.create({
      userId: 'user-1',
      sourceCatId: 'opus',
      sourceThreadId: 't-1',
      sourceSessionId: 's-1',
      note: { done: 'Finished task A', nextSteps: 'Continue task B' },
      ...overrides,
    });

  const createHandoff = (store, overrides = {}) => {
    const proposal = createStagedHandoff(store, overrides);
    anchorApproval(store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F225',
      ownerUserId: proposal.userId,
      requesterCatId: proposal.sourceCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });
    return proposal;
  };

  const withoutPublication = ({ publication: _publication, ...proposal }) => proposal;

  it('maps pending SessionHandoffProposals to ApprovalItems', () => {
    const store = new InMemorySessionHandoffProposalStore();
    createHandoff(store);

    const adapter = new F225ApprovalAdapter(store);
    const items = adapter.listPending('user-1');

    assert.equal(items.length, 1);
    assert.equal(items[0].sourceFeatureId, 'F225');
    assert.equal(items[0].ownerUserId, 'user-1');
    assert.equal(items[0].status, 'pending');
    assert.equal(items[0].inlineApprovable, false);
    assert.ok(items[0].summary.includes('Session handoff'));
    assert.equal(items[0].detail.done, 'Finished task A');
    assert.equal(items[0].detail.nextSteps, 'Continue task B');
    assert.equal(items[0].navigation.state, 'anchored');
  });

  it('computes expiresAt as createdAt + 24 hours', () => {
    const store = new InMemorySessionHandoffProposalStore();
    const p = createHandoff(store);

    const adapter = new F225ApprovalAdapter(store);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.expiresAt, p.createdAt + 24 * 60 * 60 * 1000);
  });

  it('returns empty for user with no pending proposals', () => {
    const store = new InMemorySessionHandoffProposalStore();
    const adapter = new F225ApprovalAdapter(store);
    assert.deepEqual(adapter.listPending('nobody'), []);
  });

  it('sets requesterCatId from sourceCatId', () => {
    const store = new InMemorySessionHandoffProposalStore();
    createHandoff(store, { sourceCatId: 'sonnet' });

    const adapter = new F225ApprovalAdapter(store);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.requesterCatId, 'sonnet');
  });

  it('includes sourceSessionId in detail', () => {
    const store = new InMemorySessionHandoffProposalStore();
    createHandoff(store, { sourceSessionId: 'sess-abc' });

    const adapter = new F225ApprovalAdapter(store);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.detail.sourceSessionId, 'sess-abc');
  });

  it('classifies a pre-I card marker as legacy instead of guessing dual anchors', () => {
    const store = new InMemorySessionHandoffProposalStore();
    const p = createStagedHandoff(store);
    // Simulate recordCheckpoint setting cardMessageId (done by persistAndBroadcastCard)
    store.recordCheckpoint(p.proposalId, { cardMessageId: 'msg-card-123' });

    const adapter = new F225ApprovalAdapter({
      listPendingByUser: (...args) => store.listPendingByUser(...args).map(withoutPublication),
    });
    const [item] = adapter.listPending('user-1');
    assert.deepEqual(item.navigation, {
      state: 'legacy_unanchored',
      legacyThreadId: 't-1',
      legacyMessageId: 'msg-card-123',
    });
  });

  // F246 Phase G: listSettled — approval history for F225 session handoff proposals
  describe('listSettled', () => {
    it('returns approved SessionHandoffProposals as SettledApprovalItems', async () => {
      const store = new InMemorySessionHandoffProposalStore();
      const p = createHandoff(store);
      store.claimForApproval(p.proposalId);
      store.finalizeApproval(p.proposalId);

      const adapter = new F225ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 1);
      assert.equal(items[0].proposalId, p.proposalId);
      assert.equal(items[0].sourceFeatureId, 'F225');
      assert.equal(items[0].status, 'approved');
      assert.equal(items[0].ownerUserId, 'user-1');
      assert.ok(typeof items[0].decidedAt === 'number');
      assert.ok(typeof items[0].decidedBy === 'string');
    });

    it('returns rejected SessionHandoffProposals as SettledApprovalItems', async () => {
      const store = new InMemorySessionHandoffProposalStore();
      const p = createHandoff(store);
      store.markRejected(p.proposalId, { decidedAt: p.createdAt + 1 });

      const adapter = new F225ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 1);
      assert.equal(items[0].status, 'rejected');
      assert.ok(typeof items[0].decidedAt === 'number');
    });

    it('does NOT return pending proposals in listSettled', async () => {
      const store = new InMemorySessionHandoffProposalStore();
      createHandoff(store); // stays pending

      const adapter = new F225ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 0, 'pending proposals must NOT appear in settled history');
    });

    it('does NOT return another user settled proposals', async () => {
      const store = new InMemorySessionHandoffProposalStore();
      const p = createHandoff(store, { userId: 'other-user' });
      store.claimForApproval(p.proposalId);
      store.finalizeApproval(p.proposalId);

      const adapter = new F225ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 0, 'must not return other user proposals');
    });
  });
});
