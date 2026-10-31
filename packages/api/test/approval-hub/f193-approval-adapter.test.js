import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { anchorApproval, proposedTaskAction } from './helpers.js';

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
    proposedAction: proposedTaskAction(),
    envelopeDigest: 'sha256:action-envelope',
    cardMessageId: 'msg-card-1',
    createdAt: Date.now(),
    ...overrides,
  });

  /** Create and anchor a dispatch proposal so Hub navigation projects correctly. */
  const createAnchored = async (store, overrides = {}) => {
    const { proposal } = await store.create(createInput(overrides));
    await anchorApproval(store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });
    return proposal;
  };

  it('maps pending DispatchProposals to ApprovalItems', async () => {
    const store = new InMemoryDispatchProposalStore();
    await createAnchored(store);

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
    assert.equal(items[0].detail.actionFamily, 'implement');
    assert.equal(items[0].detail.subjectRef, 'subject:task:work-42');
    assert.equal(items[0].detail.successorSlot, 'implementer');
    assert.equal(items[0].detail.mode, 'single');
    assert.deepEqual(items[0].detail.terminalPredicate, proposedTaskAction().terminalPredicate);
    assert.equal(items[0].detail.envelopeDigest, 'sha256:action-envelope');
    assert.equal(items[0].navigation.state, 'anchored');
    assert.equal(items[0].requesterCatId, 'opus');
  });

  it('retains a superseded original as a system closure without a human decider', async () => {
    const store = new InMemoryDispatchProposalStore();
    await createAnchored(store, { proposalId: 'old', createdAt: 1000 });
    await createAnchored(store, { proposalId: 'new', createdAt: 2000 });
    const [row] = await new F193ApprovalAdapter(store).listSettled('user-1');
    assert.equal(row?.proposalId, 'old');
    assert.equal(row.status, 'superseded');
    assert.equal(row.decidedAt, 2000);
    assert.equal(row.decidedBy, '');
    assert.equal((await store.listPendingByUser('user-1'))[0].proposalId, 'new');
    assert.equal(await store.approve('old', 'user-1'), null);
    assert.deepEqual(await store.listSettledByUser('foreign', 10), []);
  });

  it('returns empty for user with no pending proposals', async () => {
    const store = new InMemoryDispatchProposalStore();
    const adapter = new F193ApprovalAdapter(store);
    const items = await adapter.listPending('nobody');
    assert.equal(items.length, 0);
  });

  it('excludes approved/rejected proposals', async () => {
    const store = new InMemoryDispatchProposalStore();
    await createAnchored(store, { proposalId: 'dp-1', targetThreadId: 'thread-A' });
    await createAnchored(store, { proposalId: 'dp-2', targetThreadId: 'thread-B' });
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
    await createAnchored(store, { createdAt: now });

    const adapter = new F193ApprovalAdapter(store);
    const items = await adapter.listPending('user-1');
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    assert.equal(items[0].expiresAt, now + threeDaysMs);
  });
});
