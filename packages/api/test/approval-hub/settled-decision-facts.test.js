import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const features = ['F128', 'F139', 'F221', 'F231', 'F260', 'F321'];
function record(feature, status) {
  const proposalId = `legacy-${feature}-${status}`;
  return {
    proposalId,
    id: proposalId,
    status,
    createdAt: 1000,
    createdBy: 'owner',
    ownerUserId: 'owner',
    userId: 'owner',
    sourceCatId: 'opus',
    catId: 'opus',
    requesterCatId: 'opus',
    sourceThreadId: 'source',
    threadId: 'source',
    content: 'Legacy assignment',
    targetThreadId: 'target',
    targetCats: ['sonnet'],
    senderCatId: 'opus',
    title: 'Legacy decision',
    reason: 'Original request',
    rationale: 'Original evidence',
    quote: 'Original taste',
    targetLayer: 'relationship',
    signalProvenance: { kind: 'owner_explicit' },
    canonicalName: 'Entity',
    entityType: 'concept',
    mutation: { kind: 'create', task: { id: 'task', display: { label: 'Schedule' }, trigger: {} } },
    publication: {
      state: 'anchored',
      envelope: {
        canonicalProposalId: proposalId,
        sourceFeatureId: feature,
        ownerUserId: 'owner',
        requesterCatId: 'opus',
        originRef: { kind: 'message', threadId: 'source', messageId: 'origin' },
        approvalCardRef: { threadId: 'source', messageId: 'card' },
        createdAt: 1000,
      },
    },
  };
}
describe('canonical terminal facts are status-specific and optional', () => {
  for (const feature of features) {
    for (const status of feature === 'F128' ? ['approved', 'rejected', 'withdrawn'] : ['approved', 'rejected']) {
      it(`${feature} ${status}: never borrows a creator or another status, and marks unknown dates`, async () => {
        const { [`${feature}ApprovalAdapter`]: Adapter } = await import(
          `../../dist/domains/approval-hub/adapters/${feature}ApprovalAdapter.js`
        );
        const proposal = record(feature, status);
        const store = { listSettledByUser: () => [proposal], listSettled: () => [proposal] };
        const adapter = new Adapter(store);
        const [missing] = await adapter.listSettled('owner');
        assert.equal(missing?.decidedAt, 0, 'creation time is not a decision');
        assert.equal(missing.decidedBy, '', 'ownership is not a decision actor');
        assert.equal(missing.detail.closureTimeUnknown, true, 'zero must not be displayed as 1970');

        const other = status === 'approved' ? 'rejected' : 'approved';
        proposal[`${other}At`] = 9000;
        proposal[`${other}By`] = 'other-status-actor';
        const [unrelated] = await adapter.listSettled('owner');
        assert.equal(unrelated.decidedAt, 0, 'another terminal cannot supply this decision time');
        assert.equal(unrelated.decidedBy, '', 'another terminal cannot supply this actor');
        assert.equal(unrelated.detail.closureTimeUnknown, true);

        proposal[`${status}At`] = 5000;
        proposal[`${status}By`] = 'actual-actor';
        const [known] = await adapter.listSettled('owner');
        assert.equal(known.decidedAt, 5000);
        assert.equal(known.decidedBy, 'actual-actor');
        assert.notEqual(known.detail.closureTimeUnknown, true);
      });
    }
  }
});

for (const status of ['approved', 'rejected', 'superseded']) {
  it(`F193 ${status} hides missing lifecycle time too`, async () => {
    const { F193ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F193ApprovalAdapter.js');
    const [row] = await new F193ApprovalAdapter({
      listSettledByUser: async () => [record('F193', status)],
    }).listSettled('owner');
    assert.equal(row.decidedAt, 0);
    assert.equal(row.detail.closureTimeUnknown, true);
    assert.equal(row.decidedBy, '');
  });
}
