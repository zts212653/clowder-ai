import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';

/** Current un-undone approvals, not the mere presence of a historical decision/Undo receipt. */
export function projectPersonMemoryRetainedEffects(candidate: StoredPersonMemoryCandidate) {
  const receipt = candidate.latestDecisionReceipt;
  // A receipt names one approval batch. Earlier un-undone drafts require a separate aggregate;
  // until one exists, expose the retained effect without mislabelling the last batch as its total.
  const receiptCoversRetained =
    receipt &&
    Array.isArray(receipt.selectedDraftIds) &&
    candidate.approval?.approvedDraftIds.every((id) => receipt.selectedDraftIds.some((selected) => selected === id));
  const retained = (candidate.approval?.approvedDraftIds.length ?? 0) > 0;
  return {
    ...(retained ? { hasRetainedWrites: true } : {}),
    ...(retained && receiptCoversRetained && receipt?.candidateId === candidate.candidateId
      ? {
          materialized: {
            claims: receipt.materializedClaimIds.length,
            relationships: receipt.materializedRelationshipIds.length,
            events: receipt.materializedEventIds.length,
          },
        }
      : {}),
    ...(candidate.state === 'withdrawn' &&
    !candidate.replacedByProposalId &&
    candidate.latestUndoReceipt?.candidateId === candidate.candidateId &&
    candidate.latestUndoReceipt.candidateState === 'withdrawn' &&
    candidate.latestUndoReceipt.verdict === 'undone'
      ? { undoApplied: true }
      : {}),
  };
}

export function projectPersonMemoryProposalStatus(candidate: StoredPersonMemoryCandidate) {
  return {
    proposalId: candidate.candidateId,
    status: candidate.state,
    remainingDraftIds: candidate.remainingDraftIds,
    publicationState: candidate.publication.state,
    ...projectPersonMemoryRetainedEffects(candidate),
    ...(candidate.replacesProposalId ? { replacesProposalId: candidate.replacesProposalId } : {}),
    ...(candidate.replacedByProposalId ? { replacedByProposalId: candidate.replacedByProposalId } : {}),
    ...(candidate.publication.state === 'anchored'
      ? {
          approvalCardMessageId: candidate.publication.envelope.approvalCardRef.messageId,
        }
      : {}),
    ...(candidate.latestDecisionReceipt ? { decisionReceipt: candidate.latestDecisionReceipt } : {}),
    ...(candidate.latestUndoReceipt ? { undoReceipt: candidate.latestUndoReceipt } : {}),
  };
}
