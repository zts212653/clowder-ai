import type { ApprovalCardRef, EntityMemoryProposalView, EntityProposal } from '@cat-cafe/shared';
import type { IEntityProposalStore } from '../domains/approval-hub/stores/ports/IEntityProposalStore.js';

export type EntityMemoryProposalReader = Pick<IEntityProposalStore, 'listByTarget'>;

function approvalCardRef(proposal: EntityProposal): ApprovalCardRef | undefined {
  return proposal.publication?.state === 'anchored' ? { ...proposal.publication.envelope.approvalCardRef } : undefined;
}

export async function readEntityMemoryProposals(
  ownerUserId: string,
  entityId: string,
  store: EntityMemoryProposalReader,
): Promise<EntityMemoryProposalView[]> {
  const proposals = await store.listByTarget(ownerUserId, entityId, 100);
  return proposals
    .filter((proposal) => proposal.ownerUserId === ownerUserId && proposal.entityId === entityId)
    .map((proposal) => {
      const cardRef = approvalCardRef(proposal);
      return {
        proposalId: proposal.proposalId,
        status: proposal.status,
        suggestedPatch: {
          entityType: proposal.entityType,
          canonicalName: proposal.canonicalName,
          aliases: [...proposal.aliases],
          stance: proposal.stance,
          visibilityScope: proposal.visibilityScope,
        },
        rationale: proposal.rationale,
        sourceCatId: proposal.sourceCatId,
        sourceThreadId: proposal.sourceThreadId,
        createdAt: proposal.createdAt,
        decisionEndpointBase: '/api/entity-proposals' as const,
        approvalState: proposal.publication?.state ?? 'legacy_unanchored',
        ...(cardRef ? { approvalCardRef: cardRef } : {}),
        ...(proposal.rejectionReason ? { rejectionReason: proposal.rejectionReason } : {}),
      };
    });
}
