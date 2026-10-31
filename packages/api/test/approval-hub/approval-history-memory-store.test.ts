import assert from 'node:assert/strict';
import { test } from 'node:test';
import { F128ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F128ApprovalAdapter.js';
import { InMemoryProposalStore } from '../../src/domains/cats/services/stores/ports/ProposalStore.js';

test('canonical in-memory decisions maintain a ref-only index; paging never scans the proposal Map', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const store = new InMemoryProposalStore();
  const expected: string[] = [];
  for (let index = 0; index < 251; index++) {
    const proposal = store.create({
      sourceThreadId: 'thread',
      sourceInvocationId: `inv-${index}`,
      sourceCatId: 'codex61-sol',
      title: `Actual subject ${index}`,
      reason: 'Need a conversation',
      parentThreadId: 'thread',
      preferredCats: ['codex61-sol'],
      projectPath: '/isolated',
      createdBy: 'owner',
    });
    store.commitEnvelope(proposal.proposalId, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F128',
      ownerUserId: 'owner',
      requesterCatId: 'codex61-sol',
      createdAt: proposal.createdAt,
      originRef: { kind: 'message', threadId: 'thread', messageId: `origin-${index}` },
      approvalCardRef: { threadId: 'thread', messageId: `card-${index}` },
    });
    store.markRejected({ proposalId: proposal.proposalId, rejectedBy: 'owner', rejectionReason: 'Not now' });
    expected.push(proposal.proposalId);
  }
  // Replacing iteration proves that this port doesn't disguise a full scan as a page.
  const internal = store as unknown as { proposals: Map<string, unknown> };
  t.mock.method(internal.proposals, 'values', () => {
    throw new Error('whole store scan forbidden');
  });
  const adapter = new F128ApprovalAdapter(store);
  const seen: string[] = [];
  let before;
  for (;;) {
    const page = await adapter.listSettledPage('owner', { limit: 30, before });
    assert.ok(page.records.every((record) => record.detail.rejectionReason === 'Not now'));
    seen.push(...page.records.map((record) => record.proposalId));
    if (!page.hasMore) break;
    before = page.frontier!;
  }
  assert.deepEqual(seen, [...expected].sort().reverse());
  assert.equal(seen.length, 251);
  assert.deepEqual((await adapter.listSettledPage('other', { limit: 30 })).records, []);
});
