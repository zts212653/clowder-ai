import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryEventMemoryCorrectionProposalStore } from '../../src/domains/memory/event/InMemoryEventMemoryCorrectionProposalStore.js';

const ownerUserId = 'owner-event-correction';
const proposalId = 'proposal-event-correction-1';
const clientRequestId = 'event-correction:018f2d5e-9f45-7d8c-a829-88f6440a4f15';
const expectedRevision = `sha256:${'a'.repeat(64)}`;

function input() {
  return {
    proposalId,
    eventId: 'evt-original',
    expectedRevision,
    reason: 'unsupported_by_source' as const,
    suggestedPatch: { summary: 'A narrower source-supported summary.' },
    ownerUserId,
    sourceCatId: 'codex-sol',
    sourceThreadId: 'thread-suggestion',
    sourceInvocationId: 'invocation-suggestion',
    source: { threadId: 'thread-original', messageId: 'message-original' },
    clientRequestId,
    approvalOriginRef: { kind: 'message' as const, threadId: 'thread-suggestion', messageId: 'message-suggestion' },
  };
}

describe('F321 Event correction proposal store', () => {
  it('keeps a proposal attached to one Event revision through approval', async () => {
    const store = new InMemoryEventMemoryCorrectionProposalStore();
    assert.equal(await store.reserveDedup(ownerUserId, clientRequestId, proposalId), proposalId);
    const proposal = await store.create(input());
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.publication?.state, 'staged');
    assert.equal((await store.listActionableForEvent(ownerUserId, 'evt-original'))[0]?.proposalId, proposalId);

    await store.commitEnvelope(proposalId, {
      canonicalProposalId: proposalId,
      sourceFeatureId: 'F321',
      ownerUserId,
      requesterCatId: 'codex-sol',
      originRef: input().approvalOriginRef,
      approvalCardRef: { threadId: 'thread-suggestion', messageId: 'message-card' },
      createdAt: proposal.createdAt,
    });
    assert.equal((await store.getPublication(proposalId))?.state, 'anchored');

    assert.equal((await store.claimForApproval(proposalId, ownerUserId))?.status, 'approving');
    const appliedRevision = `sha256:${'b'.repeat(64)}`;
    const approved = await store.finalizeApproval(proposalId, ownerUserId, appliedRevision);
    assert.equal(approved?.status, 'approved');
    assert.equal(approved?.appliedRevision, appliedRevision);
    assert.equal((await store.listActionableForEvent(ownerUserId, 'evt-original')).length, 0);
    assert.equal((await store.listSettled(ownerUserId))[0]?.proposalId, proposalId);
  });

  it('deduplicates requests and only rejects an owner pending proposal', async () => {
    const store = new InMemoryEventMemoryCorrectionProposalStore();
    assert.equal(await store.reserveDedup(ownerUserId, clientRequestId, proposalId), proposalId);
    assert.equal(await store.reserveDedup(ownerUserId, clientRequestId, 'loser'), proposalId);
    await store.create(input());
    assert.equal(await store.markRejected(proposalId, 'someone-else', 'no'), null);
    assert.equal((await store.markRejected(proposalId, ownerUserId, 'Not supported'))?.status, 'rejected');
  });
});
