import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F225ApprovalAdapter', () => {
  let InMemorySessionHandoffProposalStore;
  let F225ApprovalAdapter;

  beforeEach(async () => {
    ({ InMemorySessionHandoffProposalStore } = await import(
      '../../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js'
    ));
    ({ F225ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F225ApprovalAdapter.js'));
  });

  const createHandoff = (store, overrides = {}) =>
    store.create({
      userId: 'user-1',
      sourceCatId: 'opus',
      sourceThreadId: 't-1',
      sourceSessionId: 's-1',
      note: { done: 'Finished task A', nextSteps: 'Continue task B' },
      ...overrides,
    });

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

  it('maps cardMessageId to sourceMessageId for teleport navigation', () => {
    const store = new InMemorySessionHandoffProposalStore();
    const p = createHandoff(store);
    // Simulate recordCheckpoint setting cardMessageId (done by persistAndBroadcastCard)
    store.recordCheckpoint(p.proposalId, { cardMessageId: 'msg-card-123' });

    const adapter = new F225ApprovalAdapter(store);
    const [item] = adapter.listPending('user-1');
    assert.equal(item.sourceMessageId, 'msg-card-123');
  });
});
