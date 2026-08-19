import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { anchorApproval } from './helpers.js';

/** @returns {import('../../src/domains/taste/stores/ports/TasteProposalStore.ts').CreateTasteProposalInput} */
function makeInput(overrides = {}) {
  return {
    userId: 'user-1',
    catId: 'opus',
    threadId: 'thread-1',
    scene: 'operator said "太客服了" during code review',
    quote: '太客服了，我要的是活人感',
    tags: ['authentic-expression', '活人感'],
    dimension: 'authentic-expression',
    privacy: 'public',
    ...overrides,
  };
}

describe('F221ApprovalAdapter', () => {
  let InMemoryTasteProposalStore;
  let F221ApprovalAdapter;
  let store;
  let adapter;

  beforeEach(async () => {
    ({ InMemoryTasteProposalStore } = await import('../../dist/domains/taste/stores/InMemoryTasteProposalStore.js'));
    ({ F221ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F221ApprovalAdapter.js'));
    store = new InMemoryTasteProposalStore();
    adapter = new F221ApprovalAdapter(store);
  });

  /** Create and anchor a taste proposal so Hub navigation projects correctly. */
  const createAnchored = (overrides = {}) => {
    const proposal = store.create(makeInput(overrides));
    // F221 field mapping: id→proposalId, userId→ownerUserId, catId→requesterCatId, threadId
    anchorApproval(store, {
      proposalId: proposal.id,
      sourceFeatureId: 'F221',
      ownerUserId: proposal.userId,
      requesterCatId: proposal.catId,
      threadId: proposal.threadId,
      createdAt: proposal.createdAt,
    });
    return proposal;
  };

  it('maps pending TasteProposal to ApprovalItem', async () => {
    createAnchored();
    const items = await adapter.listPending('user-1');
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceFeatureId, 'F221');
    assert.equal(items[0].ownerUserId, 'user-1');
    assert.equal(items[0].status, 'pending');
    assert.equal(items[0].navigation.state, 'anchored');
  });

  it('returns only pending, not settled', async () => {
    const p1 = createAnchored();
    createAnchored();
    store.markRejected(p1.id, 'wrong', 'user-1');

    const items = await adapter.listPending('user-1');
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'pending');
  });

  it('computes expiresAt as createdAt + 7 days', async () => {
    const p = createAnchored();
    const [item] = await adapter.listPending('user-1');
    assert.equal(item.expiresAt, p.createdAt + 7 * 24 * 60 * 60 * 1000);
  });

  it('returns empty for user with no pending proposals', async () => {
    assert.deepEqual(await adapter.listPending('nobody'), []);
  });

  it('sets requesterCatId from proposal catId', async () => {
    createAnchored({ catId: 'sonnet' });
    const [item] = await adapter.listPending('user-1');
    assert.equal(item.requesterCatId, 'sonnet');
  });

  it('sets inlineApprovable=true (taste card shows full context for inline decision)', async () => {
    createAnchored();
    const [item] = await adapter.listPending('user-1');
    assert.equal(item.inlineApprovable, true);
  });

  it('includes scene, quote, dimension, tags in detail', async () => {
    createAnchored();
    const [item] = await adapter.listPending('user-1');
    assert.equal(item.detail.scene, 'operator said "太客服了" during code review');
    assert.equal(item.detail.quote, '太客服了，我要的是活人感');
    assert.equal(item.detail.dimension, 'authentic-expression');
    assert.deepEqual(item.detail.tags, ['authentic-expression', '活人感']);
  });

  it('summary includes dimension and truncated quote', async () => {
    createAnchored();
    const [item] = await adapter.listPending('user-1');
    assert.ok(item.summary.includes('Taste'));
    assert.ok(item.summary.includes('authentic-expression'));
  });

  // listSettled
  describe('listSettled', () => {
    it('returns empty when no proposals settled', async () => {
      const items = await adapter.listSettled('user-1');
      assert.deepEqual(items, []);
    });

    it('returns approved proposals as SettledApprovalItem', async () => {
      const p = createAnchored();
      store.claimForApproval(p.id, 'user-1');
      store.finalizeApproval(p.id, 'user-1', 'slug-1', 'path-1');

      const items = await adapter.listSettled('user-1');
      assert.equal(items.length, 1);
      assert.equal(items[0].proposalId, p.id);
      assert.equal(items[0].sourceFeatureId, 'F221');
      assert.equal(items[0].status, 'approved');
      assert.ok(items[0].decidedAt > 0);
      assert.equal(items[0].decidedBy, 'user-1');
    });

    it('returns rejected proposals as SettledApprovalItem', async () => {
      const p = createAnchored();
      store.markRejected(p.id, 'not a taste signal', 'user-1');

      const items = await adapter.listSettled('user-1');
      assert.equal(items.length, 1);
      assert.equal(items[0].status, 'rejected');
    });

    it('excludes pending from settled list', async () => {
      createAnchored(); // stays pending
      const p2 = createAnchored();
      store.claimForApproval(p2.id, 'user-1');
      store.finalizeApproval(p2.id, 'user-1', 'slug', 'path');

      const items = await adapter.listSettled('user-1');
      assert.equal(items.length, 1);
      assert.equal(items[0].proposalId, p2.id);
    });

    it('orders settled by decidedAt descending', async () => {
      const p1 = createAnchored();
      store.markRejected(p1.id, 'wrong', 'user-1');
      const p2 = createAnchored();
      store.claimForApproval(p2.id, 'user-1');
      store.finalizeApproval(p2.id, 'user-1', 'slug', 'path');

      const items = await adapter.listSettled('user-1');
      // p2 approved after p1 rejected → p2 first
      assert.equal(items[0].proposalId, p2.id);
    });

    it('respects limit option', async () => {
      for (let i = 0; i < 5; i++) {
        const p = createAnchored();
        store.markRejected(p.id, `reason-${i}`, 'user-1');
      }
      const items = await adapter.listSettled('user-1', { limit: 3 });
      assert.equal(items.length, 3);
    });
  });
});
