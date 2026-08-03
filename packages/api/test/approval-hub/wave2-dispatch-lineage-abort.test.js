import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F193 atomic lineage abort recovery', () => {
  let InMemoryDispatchProposalStore;

  beforeEach(async () => {
    ({ InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    ));
  });

  function proposalInput(proposalId, createdAt) {
    return {
      proposalId,
      sourceThreadId: 'thread-s',
      targetThreadId: 'thread-t',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: proposalId,
      targetCats: ['sonnet'],
      createdAt,
    };
  }

  async function anchor(store, proposalId) {
    const proposal = await store.get(proposalId);
    await store.commitEnvelope(proposalId, {
      canonicalProposalId: proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      originRef: { kind: 'event', anchor: `test:${proposalId}`, summary: 'test', threadId: proposal.sourceThreadId },
      approvalCardRef: { threadId: proposal.sourceThreadId, messageId: `card-${proposalId}` },
      createdAt: proposal.createdAt,
    });
  }

  it('does not supersede a lineage holder while its publication is staged', async () => {
    const store = new InMemoryDispatchProposalStore();
    const first = await store.create(proposalInput('dp-publish-A', 1_000));
    const overlapping = await store.create(proposalInput('dp-publish-B', 2_000));

    assert.equal(overlapping.proposal.proposalId, first.proposal.proposalId);
    assert.equal(await store.get('dp-publish-B'), null);
    assert.equal((await store.get('dp-publish-A')).status, 'pending');
  });

  it('abortStaged atomically restores the direct predecessor', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(proposalInput('dp-abort-A', 1_000));
    await anchor(store, 'dp-abort-A');
    await store.create(proposalInput('dp-abort-B', 2_000));

    await store.abortStaged('dp-abort-B', 'pre-card failure');

    assert.equal(await store.get('dp-abort-B'), null);
    const restored = await store.get('dp-abort-A');
    assert.equal(restored.status, 'pending');
    assert.equal(restored.supersededBy, undefined);

    await store.create(proposalInput('dp-abort-C', 3_000));
    const afterC = await store.get('dp-abort-A');
    assert.equal(afterC.status, 'superseded');
    assert.equal(afterC.supersededBy, 'dp-abort-C');
  });

  it('revertToPending reclaims an empty lineage after an approved predecessor outlives an aborted successor', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(proposalInput('dp-approved-A', 1_000));
    await anchor(store, 'dp-approved-A');
    await store.approve('dp-approved-A', 'user-1');
    await store.create(proposalInput('dp-approved-B', 2_000));

    await store.abortStaged('dp-approved-B', 'pre-card failure');
    const reverted = await store.revertToPending('dp-approved-A');
    assert.equal(reverted.status, 'pending');

    await store.create(proposalInput('dp-approved-C', 3_000));
    const afterC = await store.get('dp-approved-A');
    assert.equal(afterC.status, 'superseded');
    assert.equal(afterC.supersededBy, 'dp-approved-C');
  });
});
