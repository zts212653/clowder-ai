import type { ApprovalCardRef, ProfileMemoryProposalView, ProfileUpdateProposal } from '@cat-cafe/shared';
import type { IProfileUpdateProposalStore } from '../domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import type { StoredProfileMemoryEntry } from '../domains/memory/profile/ProfileMemoryLifecycleStore.js';

export type ProfileMemoryProposalReader = Pick<IProfileUpdateProposalStore, 'listByTarget'>;

function approvalCardRef(proposal: ProfileUpdateProposal): ApprovalCardRef | undefined {
  if (proposal.publication?.state === 'anchored') {
    return { ...proposal.publication.envelope.approvalCardRef };
  }
  return proposal.cardMessageId ? { threadId: proposal.sourceThreadId, messageId: proposal.cardMessageId } : undefined;
}

export async function readProfileMemoryProposals(
  ownerUserId: string,
  entry: Pick<StoredProfileMemoryEntry, 'targetPath'>,
  store: ProfileMemoryProposalReader,
): Promise<ProfileMemoryProposalView[]> {
  const proposals = await store.listByTarget(ownerUserId, entry.targetPath, 100);
  return proposals
    .filter((proposal) => proposal.createdBy === ownerUserId && proposal.targetPath === entry.targetPath)
    .map((proposal) => {
      const cardRef = approvalCardRef(proposal);
      return {
        proposalId: proposal.proposalId,
        status: proposal.status,
        expectedRevision: `sha256:${proposal.baseContentHash}`,
        suggestedContent: proposal.afterContent,
        rationale: proposal.rationale,
        sourceCatId: proposal.sourceCatId,
        sourceThreadId: proposal.sourceThreadId,
        createdAt: proposal.createdAt,
        decisionEndpointBase: '/api/profile-updates' as const,
        approvalState: proposal.publication?.state ?? 'legacy_unanchored',
        ...(cardRef ? { approvalCardRef: cardRef } : {}),
        ...(proposal.rejectionReason ? { rejectionReason: proposal.rejectionReason } : {}),
      };
    });
}
