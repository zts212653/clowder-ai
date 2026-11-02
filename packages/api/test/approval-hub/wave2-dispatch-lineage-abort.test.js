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

  it('restores delivery rollback custody when the approved predecessor fails before the staged successor aborts', async () => {
    const store = new InMemoryDispatchProposalStore();
    const proposedAction = {
      subjectRef: 'subject:task:staged-delivery-retry',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      terminalPredicate: { kind: 'task_done' },
    };
    const input = {
      ...proposalInput('dp-revert-first-A', 1000),
      sourceInvocationId: 'inv-staged-retry',
      proposedAction,
    };
    await store.create(input);
    await anchor(store, input.proposalId);
    await store.approve(input.proposalId, input.ownerUserId, 'strict');
    await store.create({ ...input, proposalId: 'dp-revert-first-B', createdAt: 2000 });
    assert.equal(await store.revertToPending(input.proposalId), null);
    assert.equal((await store.get(input.proposalId)).status, 'superseded');

    await store.abortStaged('dp-revert-first-B', 'card publication failed');

    const restored = await store.get(input.proposalId);
    assert.equal(restored.status, 'pending', 'an unpublished successor must return delivery retry custody');
    assert.equal(restored.supersededBy, undefined);
    assert.equal(restored.supersededAt, undefined);
    assert.deepEqual(
      (await store.listPendingByUser(input.ownerUserId)).map((p) => p.proposalId),
      [input.proposalId],
    );
    assert.deepEqual(await store.listSettledByUser(input.ownerUserId, 1), []);
    assert.deepEqual(
      await store.findCanonicalAdmissionBlocks({
        ownerUserId: input.ownerUserId,
        canonicalSubjectRef: proposedAction.subjectRef,
      }),
      [{ proposalId: input.proposalId, status: 'pending' }],
    );
    assert.deepEqual(await store.findNegativeAuthorizationBlocks({ ...input, targetCats: ['sonnet'] }), [
      { proposalId: input.proposalId, status: 'pending', targetCats: ['sonnet'] },
    ]);
    assert.equal(await store.getApprovalOwnerAuthProvenance(input.proposalId), undefined);
  });

  it('keeps the direct pending predecessor ahead of an older failed delivery during staged abort', async () => {
    const store = new InMemoryDispatchProposalStore();
    await store.create(proposalInput('old-approved', 1000));
    await anchor(store, 'old-approved');
    await store.approve('old-approved', 'user-1', 'strict');
    await store.create(proposalInput('current-pending', 2000));
    await anchor(store, 'current-pending');
    await store.create(proposalInput('failed-staged', 3000));
    await store.revertToPending('old-approved');
    await store.abortStaged('failed-staged', 'publication failed');
    assert.deepEqual(
      (await store.listPendingByUser('user-1')).map((p) => p.proposalId),
      ['current-pending'],
    );
    assert.equal((await store.get('old-approved')).supersededBy, 'current-pending');
    assert.equal((await store.get('current-pending')).supersededAt, undefined);
  });

  it('restores the newest failed delivery and reparents earlier failures when both outlive the staged holder', async () => {
    const store = new InMemoryDispatchProposalStore();
    for (const [id, time] of [
      ['older-approved', 1000],
      ['newer-approved', 2000],
    ]) {
      await store.create(proposalInput(id, time));
      await anchor(store, id);
      await store.approve(id, 'user-1', 'strict');
    }
    await store.create(proposalInput('failed-staged', 3000));
    await store.revertToPending('newer-approved');
    await store.revertToPending('older-approved');
    await store.abortStaged('failed-staged', 'publication failed');
    assert.deepEqual(
      (await store.listPendingByUser('user-1')).map((p) => p.proposalId),
      ['newer-approved'],
    );
    assert.equal((await store.get('older-approved')).supersededBy, 'newer-approved');
    assert.equal((await store.get('newer-approved')).supersededAt, undefined);
  });
});
