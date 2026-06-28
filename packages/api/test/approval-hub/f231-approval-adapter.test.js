import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F231ApprovalAdapter', () => {
  let InMemoryProfileUpdateProposalStore;
  let F231ApprovalAdapter;

  beforeEach(async () => {
    ({ InMemoryProfileUpdateProposalStore } = await import(
      '../../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js'
    ));
    ({ F231ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F231ApprovalAdapter.js'));
  });

  const createProposal = (store, overrides = {}) =>
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

  it('maps cardMessageId to sourceMessageId', () => {
    const store = new InMemoryProfileUpdateProposalStore();
    const p = createProposal(store);
    store.setCardMessageId(p.proposalId, 'msg-card-456');

    const adapter = new F231ApprovalAdapter(store);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.sourceMessageId, 'msg-card-456');
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
});
