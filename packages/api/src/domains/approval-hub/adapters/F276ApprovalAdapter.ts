import type { ApprovalItem } from '@cat-cafe/shared';
import { projectCandidateInteractionInformedEvidence } from '../../memory/people/PersonMemoryInformedEvidence.js';
import type { PersonMemoryStore, StoredPersonMemoryCandidate } from '../../memory/people/PersonMemoryStore.js';
import type { IApprovalAdapter } from '../ports/IApprovalAdapter.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';

export class F276ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F276' as const;

  constructor(private readonly store: PersonMemoryStore | null) {}

  async listPending(userId: string): Promise<ApprovalItem[]> {
    if (!this.store) return [];
    const candidates = await this.store.listPending(userId);
    return compactApprovalProjections(candidates.map(toItem));
  }
}

function draftKind(
  draft:
    | StoredPersonMemoryCandidate['claimDrafts'][number]
    | NonNullable<StoredPersonMemoryCandidate['relationshipDraft']>
    | NonNullable<StoredPersonMemoryCandidate['interactionDraft']>,
): string {
  if ('eventKind' in draft.payload) return 'interaction_event';
  if ('status' in draft.payload) return 'relationship';
  return draft.payload.kind;
}

function isInteractionDraft(
  draft:
    | StoredPersonMemoryCandidate['claimDrafts'][number]
    | NonNullable<StoredPersonMemoryCandidate['relationshipDraft']>
    | NonNullable<StoredPersonMemoryCandidate['interactionDraft']>,
): draft is NonNullable<StoredPersonMemoryCandidate['interactionDraft']> {
  return 'sourceEvidence' in draft && 'eventKind' in draft.payload;
}

function typedEvidence(candidate: StoredPersonMemoryCandidate, draftId: string) {
  if (!candidate.sourceBundle) return [];
  const sources = new Map(candidate.sourceBundle.sources.map((source) => [source.sourceId, source]));
  return candidate.sourceBundle.assertionBindings
    .filter((binding) => binding.target.draftId === draftId)
    .map((binding) => {
      const source = sources.get(binding.sourceId);
      return source
        ? {
            sourceId: source.sourceId,
            sourceKind: source.kind,
            assertionRole: binding.role,
            ...(source.kind === 'owner_confirmed_transcript' ? { confirmationScope: source.confirmationScope } : {}),
          }
        : null;
    })
    .filter((entry) => entry !== null);
}

function toItem(candidate: StoredPersonMemoryCandidate): ApprovalItem | null {
  const navigation = projectApprovalNavigation(candidate, {});
  if (!navigation || !candidate.personDraft) return null;
  const drafts = [
    ...candidate.claimDrafts,
    ...(candidate.relationshipDraft ? [candidate.relationshipDraft] : []),
    ...(candidate.interactionDraft ? [candidate.interactionDraft] : []),
  ].filter((draft) => candidate.remainingDraftIds.includes(draft.draftId));
  return {
    proposalId: candidate.candidateId,
    sourceFeatureId: 'F276',
    requesterCatId: candidate.requesterCatId,
    ownerUserId: candidate.ownerUserId,
    status: 'pending',
    summary: `记住人物：${candidate.personDraft.displayName}`,
    detail: {
      displayName: candidate.personDraft.displayName,
      drafts: drafts.map((draft) => ({
        draftId: draft.draftId,
        claimKind: draftKind(draft),
        normalizedDraft: draft.normalizedDraft,
        sourceRole: draft.sourceRole,
        evidenceExcerpt: draft.evidenceExcerpt,
        typedEvidence: typedEvidence(candidate, draft.draftId),
        ...(isInteractionDraft(draft)
          ? {
              informedEvidence: projectCandidateInteractionInformedEvidence(candidate, draft.draftId),
              event: {
                ...draft.payload,
                sourceEvidence: draft.sourceEvidence,
              },
            }
          : {}),
      })),
      remainingDraftIds: candidate.remainingDraftIds,
      candidateState: candidate.state,
      ...(candidate.replacesProposalId ? { replacesProposalId: candidate.replacesProposalId } : {}),
    },
    navigation,
    inlineApprovable: true,
    decisionMode: 'claim-select',
    createdAt: candidate.createdAt,
  };
}
