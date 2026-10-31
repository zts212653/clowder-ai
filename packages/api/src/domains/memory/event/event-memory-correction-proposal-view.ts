import type { EventMemoryCorrectionProposal, EventMemoryCorrectionProposalView } from '@cat-cafe/shared';

export function toEventMemoryCorrectionProposalView(
  proposal: EventMemoryCorrectionProposal,
): EventMemoryCorrectionProposalView {
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    expectedRevision: proposal.expectedRevision,
    reason: proposal.reason,
    suggestedPatch: structuredClone(proposal.suggestedPatch),
    sourceCatId: proposal.sourceCatId,
    sourceThreadId: proposal.sourceThreadId,
    source: { ...proposal.source },
    createdAt: proposal.createdAt,
    ...(proposal.rejectionReason ? { rejectionReason: proposal.rejectionReason } : {}),
    ...(proposal.appliedRevision ? { appliedRevision: proposal.appliedRevision } : {}),
  };
}
