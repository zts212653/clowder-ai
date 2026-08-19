import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';

export function projectPersonMemoryProposalStatus(candidate: StoredPersonMemoryCandidate) {
  return {
    proposalId: candidate.candidateId,
    status: candidate.state,
    remainingDraftIds: candidate.remainingDraftIds,
    publicationState: candidate.publication.state,
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
