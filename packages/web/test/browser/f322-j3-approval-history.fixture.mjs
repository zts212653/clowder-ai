import assert from 'node:assert/strict';
import { F128ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F128ApprovalAdapter.js';
import { MessageStore } from '../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProposalStore } from '../../../api/dist/domains/cats/services/stores/ports/ProposalStore.js';
import { approvalHubRoutes } from '../../../api/dist/routes/approval-hub-routes.js';
import { createTestApprovalRegistry } from '../../../api/test/approval-hub/helpers.js';

/** Actual original proposal-store transitions and Hub read route; no provider or production proposal is touched. */
export async function registerControlledApprovalHistory(app, threadId) {
  const store = new InMemoryProposalStore();
  const messages = new MessageStore();
  const records = [];
  for (const [owner, outcome] of [
    ['default-user', 'approved'],
    ['default-user', 'rejected'],
    ['other-owner', 'approved'],
  ]) {
    const origin = messages.append({
      userId: owner,
      threadId,
      from: { kind: 'agent', catId: 'codex61-sol' },
      content: `Controlled ${outcome} proposal origin`,
      timestamp: Date.now() - 5000,
    });
    const card = messages.append({
      userId: owner,
      threadId,
      from: { kind: 'agent', catId: 'codex61-sol' },
      content: `Controlled ${outcome} approval card`,
      timestamp: Date.now() - 4000,
    });
    const proposal = store.create({
      proposalId: `j3-history-${outcome}-${owner}`,
      sourceThreadId: threadId,
      sourceInvocationId: 'controlled-invocation',
      sourceCatId: 'codex61-sol',
      sourceMessageId: origin.id,
      title: `Controlled ${outcome} approval`,
      reason: 'Disposable history navigation evidence',
      parentThreadId: threadId,
      preferredCats: ['codex61-sol'],
      projectPath: '/controlled/read-only-source',
      createdBy: owner,
    });
    store.commitEnvelope(proposal.proposalId, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F128',
      ownerUserId: owner,
      requesterCatId: 'codex61-sol',
      originRef: { kind: 'message', threadId, messageId: origin.id },
      approvalCardRef: { threadId, messageId: card.id },
      createdAt: proposal.createdAt,
    });
    if (outcome === 'approved') {
      assert.ok(store.claimForApproval({ proposalId: proposal.proposalId, approvedBy: owner }));
      assert.ok(
        store.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: 'controlled-already-created' }),
      );
    } else assert.ok(store.markRejected({ proposalId: proposal.proposalId, rejectedBy: owner }));
    if (owner === 'default-user') records.push({ proposalId: proposal.proposalId, outcome, origin, card });
  }
  const registry = await createTestApprovalRegistry([new F128ApprovalAdapter(store)]);
  await app.register(approvalHubRoutes, { registry });
  return {
    records,
    messages: messages.getByThread(threadId).filter((message) => message.userId === 'default-user'),
    read: () => registry.listSettled('default-user', 200),
  };
}
