/**
 * F260 Phase A T2: F260ApprovalAdapter test.
 *
 * Maps pending EntityProposals from the canonical store to unified
 * ApprovalItem DTOs. Following the same pattern as f231-approval-adapter.test.js.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { anchorApproval } from './helpers.js';

describe('F260ApprovalAdapter', () => {
  let InMemoryEntityProposalStore;
  let F260ApprovalAdapter;

  beforeEach(async () => {
    ({ InMemoryEntityProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
    ));
    ({ F260ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F260ApprovalAdapter.js'));
  });

  const createProposal = async (store, overrides = {}) => {
    const proposal = store.create({
      entityId: 'concept:未婚喵',
      entityType: 'concept',
      canonicalName: '未婚喵',
      aliases: ['未婚喵', '未婚猫'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'cat-proposed', anchor: 'thread_abc' }],
      rationale: 'Recurring term in thread discussions, needs registry entry',
      sourceThreadId: 't-1',
      sourceCatId: 'opus',
      ownerUserId: 'user-1',
      ...overrides,
    });
    await anchorApproval(store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.sourceCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });
    return proposal;
  };

  it('maps pending EntityProposals to ApprovalItems', async () => {
    const store = new InMemoryEntityProposalStore();
    await createProposal(store);

    const adapter = new F260ApprovalAdapter(store);
    const items = await adapter.listPending('user-1');

    assert.equal(items.length, 1);
    assert.equal(items[0].sourceFeatureId, 'F260');
    assert.equal(items[0].ownerUserId, 'user-1');
    assert.equal(items[0].status, 'pending');
    assert.equal(
      items[0].inlineApprovable,
      true,
      'F260 items must be inlineApprovable — Hub frontend routes per sourceFeatureId (T0)',
    );
    assert.ok(items[0].summary.includes('未婚喵'));
    assert.equal(items[0].navigation.state, 'anchored');
  });

  it('computes expiresAt as createdAt + 14 days', async () => {
    const store = new InMemoryEntityProposalStore();
    const p = await createProposal(store);

    const adapter = new F260ApprovalAdapter(store);
    const [item] = await adapter.listPending('user-1');
    assert.equal(item.expiresAt, p.createdAt + 14 * 24 * 60 * 60 * 1000);
  });

  it('returns empty for user with no pending proposals', async () => {
    const store = new InMemoryEntityProposalStore();
    const adapter = new F260ApprovalAdapter(store);
    assert.deepEqual(await adapter.listPending('nobody'), []);
  });

  it('sets requesterCatId from sourceCatId', async () => {
    const store = new InMemoryEntityProposalStore();
    await createProposal(store, { sourceCatId: 'sonnet' });

    const adapter = new F260ApprovalAdapter(store);
    const [item] = await adapter.listPending('user-1');
    assert.equal(item.requesterCatId, 'sonnet');
  });

  it('includes entityId, canonicalName, stance, aliases in detail', async () => {
    const store = new InMemoryEntityProposalStore();
    await createProposal(store);

    const adapter = new F260ApprovalAdapter(store);
    const [item] = await adapter.listPending('user-1');
    assert.equal(item.detail.entityId, 'concept:未婚喵');
    assert.equal(item.detail.canonicalName, '未婚喵');
    assert.equal(item.detail.stance, 'endorsed');
    assert.deepEqual(item.detail.aliases, ['未婚喵', '未婚猫']);
    assert.equal(item.detail.rationale, 'Recurring term in thread discussions, needs registry entry');
  });

  it('includes entityType and visibilityScope in detail', async () => {
    const store = new InMemoryEntityProposalStore();
    await createProposal(store, { entityType: 'feature', visibilityScope: 'private:user-1' });

    const adapter = new F260ApprovalAdapter(store);
    const [item] = await adapter.listPending('user-1');
    assert.equal(item.detail.entityType, 'feature');
    assert.equal(item.detail.visibilityScope, 'private:user-1');
  });

  it('rebuilds actionable conflict context into each pending item on refresh', async () => {
    const store = new InMemoryEntityProposalStore();
    const proposal = await createProposal(store);
    const conflict = {
      version: 1,
      reason: 'existing-entity-change',
      fingerprint: 'a'.repeat(64),
      incoming: {
        entityId: proposal.entityId,
        entityType: proposal.entityType,
        canonicalName: proposal.canonicalName,
        aliases: proposal.aliases,
        stance: proposal.stance,
        visibilityScope: proposal.visibilityScope,
        status: 'active',
      },
      candidates: [
        {
          entityId: proposal.entityId,
          entityType: proposal.entityType,
          canonicalName: 'Old Name',
          aliases: ['old'],
          stance: 'endorsed',
          visibilityScope: 'workspace',
          status: 'active',
        },
      ],
      conflictingSurfaces: ['未婚喵'],
      canonicalReplacementRequiredFor: [],
      allowedActions: ['merge-aliases', 'replace', 'reject'],
    };
    const inspected = [];
    const adapter = new F260ApprovalAdapter(store, async (pendingProposal) => {
      inspected.push(pendingProposal.proposalId);
      return conflict;
    });

    const [item] = await adapter.listPending('user-1');

    assert.deepEqual(inspected, [proposal.proposalId]);
    assert.deepEqual(item.detail.conflict, conflict);
  });

  it('omits conflict detail when the pending proposal no longer conflicts', async () => {
    const store = new InMemoryEntityProposalStore();
    await createProposal(store);
    const adapter = new F260ApprovalAdapter(store, async () => null);

    const [item] = await adapter.listPending('user-1');

    assert.equal('conflict' in item.detail, false);
  });

  // F246 Phase H: listSettled()
  describe('listSettled', () => {
    it('returns empty when no proposals have been settled', async () => {
      const store = new InMemoryEntityProposalStore();
      const adapter = new F260ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');
      assert.deepEqual(items, []);
    });

    it('returns approved proposals as SettledApprovalItem', async () => {
      const store = new InMemoryEntityProposalStore();
      const p = await createProposal(store);
      store.markApproved(p.proposalId, 'user-1');

      const adapter = new F260ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 1);
      assert.equal(items[0].proposalId, p.proposalId);
      assert.equal(items[0].sourceFeatureId, 'F260');
      assert.equal(items[0].status, 'approved');
      assert.ok(items[0].decidedAt > 0, 'decidedAt must be set');
    });

    it('returns rejected proposals as SettledApprovalItem', async () => {
      const store = new InMemoryEntityProposalStore();
      const p = await createProposal(store);
      store.markRejected(p.proposalId, 'user-1', 'Not useful');

      const adapter = new F260ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');

      assert.equal(items.length, 1);
      assert.equal(items[0].status, 'rejected');
    });

    it('excludes pending proposals from settled list', async () => {
      const store = new InMemoryEntityProposalStore();
      await createProposal(store); // pending — should NOT appear
      const settled = await createProposal(store, { entityId: 'concept:test2' });
      store.markApproved(settled.proposalId, 'user-1');

      const adapter = new F260ApprovalAdapter(store);
      const items = await adapter.listSettled('user-1');
      assert.equal(items.length, 1);
      assert.equal(items[0].proposalId, settled.proposalId);
    });
  });
});
