import type { ApprovalCardRef, PersonIdentity, PersonMemoryProposalView } from '@cat-cafe/shared';
import type { PersonMemoryStore, StoredPersonMemoryCandidate } from './PersonMemoryStore.js';

type PersonProposalStore = Pick<PersonMemoryStore, 'getCandidateForOwner' | 'listCandidateIdsForPerson'>;

function targetsPerson(candidate: StoredPersonMemoryCandidate, personId: string): boolean {
  return candidate.targetPersonId === personId || candidate.materializedPersonId === personId;
}

function approvalCardRef(candidate: StoredPersonMemoryCandidate): ApprovalCardRef | undefined {
  return candidate.publication.state === 'anchored' ? { ...candidate.publication.envelope.approvalCardRef } : undefined;
}

function projectCandidate(
  candidate: StoredPersonMemoryCandidate,
  fallbackDisplayName: string,
): PersonMemoryProposalView {
  const cardRef = approvalCardRef(candidate);
  return {
    proposalId: candidate.candidateId,
    status: candidate.state === 'staged' ? 'pending_approval' : candidate.state,
    displayName: candidate.personDraft?.displayName ?? fallbackDisplayName,
    remainingDraftIds: [...candidate.remainingDraftIds],
    sourceCatId: candidate.requesterCatId,
    sourceThreadId: candidate.sourceMessageRef.threadId,
    createdAt: candidate.createdAt,
    decisionEndpointBase: '/api/person-memory-proposals',
    approvalState: 'anchored',
    ...(cardRef ? { approvalCardRef: cardRef } : {}),
    ...(candidate.replacesProposalId ? { replacesProposalId: candidate.replacesProposalId } : {}),
  };
}

export async function readPersonMemoryProposals(
  store: PersonProposalStore,
  ownerUserId: string,
  person: PersonIdentity,
  limit: number,
): Promise<{ proposals: PersonMemoryProposalView[]; truncated: boolean }> {
  const candidateIds = await store.listCandidateIdsForPerson(ownerUserId, person.personId);
  const candidates = await Promise.all(
    candidateIds.map((candidateId) => store.getCandidateForOwner(ownerUserId, candidateId)),
  );
  const matching = candidates
    .filter(
      (candidate): candidate is StoredPersonMemoryCandidate =>
        candidate !== null &&
        candidate.ownerUserId === ownerUserId &&
        candidate.state !== 'staged' &&
        candidate.publication.state === 'anchored' &&
        targetsPerson(candidate, person.personId),
    )
    .sort((left, right) => right.createdAt - left.createdAt || left.candidateId.localeCompare(right.candidateId));
  return {
    proposals: matching.slice(0, limit).map((candidate) => projectCandidate(candidate, person.displayName)),
    truncated: matching.length > limit,
  };
}
