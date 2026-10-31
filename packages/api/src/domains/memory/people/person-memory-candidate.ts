import type { CandidateClaimDraftId, PersonId } from '@cat-cafe/shared';
import type { PersonMemoryDecisionResult, StoredPersonMemoryCandidate } from './PersonMemoryStore.js';

export function updatePersonMemoryCandidate(
  candidate: StoredPersonMemoryCandidate,
  selectedIds: Set<CandidateClaimDraftId>,
  personId: PersonId,
  authorizedAt: number,
): StoredPersonMemoryCandidate {
  const remainingDraftIds = candidate.remainingDraftIds.filter((draftId) => !selectedIds.has(draftId));
  const approvedDraftIds = [
    ...(candidate.approval?.approvedDraftIds ?? []),
    ...[...selectedIds].filter((draftId) => !candidate.approval?.approvedDraftIds.includes(draftId)),
  ];
  const state = remainingDraftIds.length === 0 ? 'materialized' : 'partially_materialized';
  const base: StoredPersonMemoryCandidate = {
    ...candidate,
    state,
    materializedPersonId: personId,
    remainingDraftIds,
    approval: { approvedDraftIds, authorizedAt },
  };
  if (state !== 'materialized') {
    return {
      ...base,
      claimDrafts: candidate.claimDrafts.map((draft) =>
        selectedIds.has(draft.draftId) ? { ...draft, decision: 'approved' as const } : draft,
      ),
      relationshipDraft:
        candidate.relationshipDraft && selectedIds.has(candidate.relationshipDraft.draftId)
          ? { ...candidate.relationshipDraft, decision: 'approved' }
          : candidate.relationshipDraft,
      interactionDraft:
        candidate.interactionDraft && selectedIds.has(candidate.interactionDraft.draftId)
          ? { ...candidate.interactionDraft, decision: 'approved' }
          : candidate.interactionDraft,
    };
  }
  const {
    personDraft: _personDraft,
    relationshipDraft: _relationshipDraft,
    interactionDraft: _interactionDraft,
    sourceBundle: _sourceBundle,
    ...terminal
  } = base;
  return { ...terminal, claimDrafts: [] };
}

export function parsePersonMemoryDecisionResult(raw: unknown): PersonMemoryDecisionResult {
  const result = String(raw);
  if (result === 'CONFLICT') return { outcome: 'conflict' };
  if (result === 'NOT_AVAILABLE') return { outcome: 'not_available' };
  if (result.startsWith('APPLIED:')) {
    return { outcome: 'applied', receipt: JSON.parse(result.slice('APPLIED:'.length)) };
  }
  if (result.startsWith('REPLAYED:')) {
    return { outcome: 'replayed', receipt: JSON.parse(result.slice('REPLAYED:'.length)) };
  }
  throw new Error(`unexpected F276 approval result: ${result}`);
}
