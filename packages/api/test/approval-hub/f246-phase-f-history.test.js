/**
 * F246 Phase F: Approval History
 *
 * operator: "为什么我们没有审批的历史记录啊！！记录一下都审批是通过还是没通过啊！"
 *
 * AC-F3: IDispatchProposalStore.listSettledByUser returns approved+rejected proposals
 * AC-F4: F193ApprovalAdapter.listSettled maps them to SettledApprovalItem[]
 * AC-F5: GET /api/approval-hub/settled endpoint (covered in approval-hub-routes.test.js addition)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F246 Phase F: Approval History', () => {
  let InMemoryDispatchProposalStore;
  let F193ApprovalAdapter;

  beforeEach(async () => {
    ({ InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    ));
    ({ F193ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F193ApprovalAdapter.js'));
  });

  const createInput = (overrides = {}) => ({
    proposalId: 'dp-history-1',
    sourceThreadId: 'thread-sender',
    targetThreadId: 'thread-target',
    senderCatId: 'opus',
    ownerUserId: 'user-landy',
    content: 'Fix the bug',
    targetCats: ['sonnet'],
    cardMessageId: 'msg-card-1',
    createdAt: Date.now() - 300_000,
    ...overrides,
  });

  // ── AC-F3: IDispatchProposalStore.listSettledByUser ──────────────────────────

  describe('InMemoryDispatchProposalStore.listSettledByUser', () => {
    it('returns approved proposals for the user', async () => {
      const store = new InMemoryDispatchProposalStore();
      await store.create(createInput({ proposalId: 'dp-1' }));
      await store.approve('dp-1', 'user-landy');

      const settled = await store.listSettledByUser('user-landy', 50);
      assert.equal(settled.length, 1);
      assert.equal(settled[0].proposalId, 'dp-1');
      assert.equal(settled[0].status, 'approved');
    });

    it('returns rejected proposals for the user', async () => {
      const store = new InMemoryDispatchProposalStore();
      await store.create(createInput({ proposalId: 'dp-2' }));
      await store.reject('dp-2', 'user-landy');

      const settled = await store.listSettledByUser('user-landy', 50);
      assert.equal(settled.length, 1);
      assert.equal(settled[0].proposalId, 'dp-2');
      assert.equal(settled[0].status, 'rejected');
    });

    it('excludes pending proposals', async () => {
      const store = new InMemoryDispatchProposalStore();
      await store.create(createInput({ proposalId: 'dp-pending' }));

      const settled = await store.listSettledByUser('user-landy', 50);
      assert.equal(settled.length, 0);
    });

    it('excludes proposals owned by other users', async () => {
      const store = new InMemoryDispatchProposalStore();
      await store.create(createInput({ proposalId: 'dp-other', ownerUserId: 'user-other' }));
      await store.approve('dp-other', 'user-other');

      const settled = await store.listSettledByUser('user-landy', 50);
      assert.equal(settled.length, 0);
    });

    it('returns both approved and rejected in decidedAt desc order', async () => {
      const store = new InMemoryDispatchProposalStore();
      // Create and decide in order: reject dp-old first, approve dp-new second
      await store.create(createInput({ proposalId: 'dp-old', createdAt: Date.now() - 600_000 }));
      await store.create(createInput({ proposalId: 'dp-new', createdAt: Date.now() - 300_000 }));
      await store.reject('dp-old', 'user-landy');
      await store.approve('dp-new', 'user-landy');

      const settled = await store.listSettledByUser('user-landy', 50);
      assert.equal(settled.length, 2);
      // dp-new was decided later → should come first (decidedAt desc)
      assert.ok(
        settled[0].decidedAt >= settled[1].decidedAt,
        `Expected decidedAt desc order but got ${settled[0].decidedAt} < ${settled[1].decidedAt}`,
      );
    });

    it('respects the limit parameter', async () => {
      const store = new InMemoryDispatchProposalStore();
      for (let i = 0; i < 5; i++) {
        await store.create(createInput({ proposalId: `dp-${i}`, createdAt: Date.now() - i * 10_000 }));
        await store.approve(`dp-${i}`, 'user-landy');
      }

      const settled = await store.listSettledByUser('user-landy', 3);
      assert.equal(settled.length, 3);
    });

    it('returns empty array when user has no settled proposals', async () => {
      const store = new InMemoryDispatchProposalStore();
      const settled = await store.listSettledByUser('nobody', 50);
      assert.deepEqual(settled, []);
    });

    it('approve → revertToPending does NOT appear in settled history (P2 regression)', async () => {
      // Approve, then delivery fails → revert to pending.
      // The proposal must NOT appear in settled history — it is no longer decided.
      const store = new InMemoryDispatchProposalStore();
      await store.create(createInput({ proposalId: 'dp-reverted' }));
      await store.approve('dp-reverted', 'user-landy');
      await store.revertToPending('dp-reverted');

      const settled = await store.listSettledByUser('user-landy', 50);
      assert.equal(settled.length, 0, 'reverted proposal must not appear in settled history');
    });
  });

  // ── AC-F4: F193ApprovalAdapter.listSettled ───────────────────────────────────

  describe('F193ApprovalAdapter.listSettled', () => {
    it('returns SettledApprovalItem[] for approved dispatch proposals', async () => {
      const store = new InMemoryDispatchProposalStore();
      await store.create(
        createInput({
          proposalId: 'dp-settled-1',
          content: 'Investigate the F246 history feature',
          targetCats: ['sonnet', 'gpt52'],
        }),
      );
      await store.approve('dp-settled-1', 'user-landy');

      const adapter = new F193ApprovalAdapter(store);
      const settled = await adapter.listSettled('user-landy', { limit: 50 });

      assert.equal(settled.length, 1);
      const item = settled[0];
      assert.equal(item.proposalId, 'dp-settled-1');
      assert.equal(item.sourceFeatureId, 'F193');
      assert.equal(item.status, 'approved');
      assert.equal(item.ownerUserId, 'user-landy');
      assert.equal(item.requesterCatId, 'opus');
      assert.ok(typeof item.decidedAt === 'number' && item.decidedAt > 0, 'decidedAt must be a positive number');
      assert.equal(item.decidedBy, 'user-landy');
      assert.ok(item.summary.includes('Investigate'), `summary should include content, got: ${item.summary}`);
    });

    it('returns SettledApprovalItem with status=rejected for rejected proposals', async () => {
      const store = new InMemoryDispatchProposalStore();
      await store.create(createInput({ proposalId: 'dp-rejected' }));
      await store.reject('dp-rejected', 'user-landy');

      const adapter = new F193ApprovalAdapter(store);
      const settled = await adapter.listSettled('user-landy', { limit: 50 });

      assert.equal(settled.length, 1);
      assert.equal(settled[0].status, 'rejected');
      assert.equal(settled[0].decidedBy, 'user-landy');
    });

    it('returns empty array when no settled proposals', async () => {
      const store = new InMemoryDispatchProposalStore();
      // Only pending — should not appear in settled
      await store.create(createInput({ proposalId: 'dp-pending' }));

      const adapter = new F193ApprovalAdapter(store);
      const settled = await adapter.listSettled('user-landy', { limit: 50 });
      assert.deepEqual(settled, []);
    });

    it('respects limit option', async () => {
      const store = new InMemoryDispatchProposalStore();
      for (let i = 0; i < 5; i++) {
        await store.create(createInput({ proposalId: `dp-s-${i}` }));
        await store.approve(`dp-s-${i}`, 'user-landy');
      }

      const adapter = new F193ApprovalAdapter(store);
      const settled = await adapter.listSettled('user-landy', { limit: 2 });
      assert.equal(settled.length, 2);
    });

    it('returns empty array for user with no proposals', async () => {
      const store = new InMemoryDispatchProposalStore();
      const adapter = new F193ApprovalAdapter(store);
      const settled = await adapter.listSettled('nobody', { limit: 50 });
      assert.deepEqual(settled, []);
    });
  });
});
