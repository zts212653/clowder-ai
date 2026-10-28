import type { ApprovalItem, SettledApprovalItem } from '@cat-cafe/shared';
import type { SettledHistoryPageOptions } from '../../../utils/settled-history-page.js';
import { projectCandidateInteractionInformedEvidence } from '../../memory/people/PersonMemoryInformedEvidence.js';
import type { PersonMemoryStore, StoredPersonMemoryCandidate } from '../../memory/people/PersonMemoryStore.js';
import { projectPersonMemoryRetainedEffects } from '../../memory/people/person-memory-proposal-status.js';
import {
  ALL_PENDING_APPROVALS_LIMIT,
  type ApprovalDecisionRead,
  type IApprovalAdapter,
  type ListSettledOpts,
  projectApprovalDecisionRead,
} from '../ports/IApprovalAdapter.js';
import { projectSettledPage } from '../project-settled-page.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';

export class F276ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F276' as const;

  constructor(private readonly store: PersonMemoryStore | null) {}

  async listSettledPage(owner: string, options: SettledHistoryPageOptions) {
    if (!this.store)
      throw Object.assign(new Error('F276 canonical history source unavailable'), {
        statusCode: 503,
        code: 'APPROVAL_HISTORY_UNAVAILABLE',
      });
    return projectSettledPage(this.store, owner, options, async ({ candidate, decidedAt }) => {
      const person =
        candidate.state === 'materialized' && candidate.materializedPersonId
          ? await this.store?.getPerson(owner, candidate.materializedPersonId)
          : null;
      return toSettledItem(candidate, decidedAt, person?.displayName);
    });
  }

  async listPending(userId: string): Promise<ApprovalItem[]> {
    if (!this.store) return [];
    const candidates = await this.store.listPending(userId, ALL_PENDING_APPROVALS_LIMIT);
    return compactApprovalProjections(candidates.map(toItem));
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    if (!this.store) return [];
    const settled = await this.store.listSettled(userId, opts?.limit ?? 50);
    return compactApprovalProjections(
      await Promise.all(
        settled.map(async ({ candidate, decidedAt }) => {
          const person =
            candidate.state === 'materialized' && candidate.materializedPersonId
              ? await this.store?.getPerson(userId, candidate.materializedPersonId)
              : null;
          return toSettledItem(candidate, decidedAt, person?.displayName);
        }),
      ),
    );
  }

  async readDecision(userId: string, proposalId: string): Promise<ApprovalDecisionRead> {
    if (!this.store) throw new Error('F276 decision store unavailable');
    const candidate = await this.store.getCandidateForOwner(userId, proposalId);
    if (!candidate || candidate.ownerUserId !== userId) return { state: 'closed' };
    if (['pending_approval', 'partially_materialized'].includes(candidate.state)) return { state: 'pending' };
    const person =
      candidate.state === 'materialized' && candidate.materializedPersonId
        ? await this.store.getPerson(userId, candidate.materializedPersonId)
        : null;
    // Partial approval receipts may survive a later rejection. The existing
    // atomic settled index owns the terminal time, not that older receipt.
    const decidedAt = (await this.store.getSettledDecisionTime(userId, proposalId)) ?? 0;
    const item = toSettledItem(candidate, decidedAt, person?.displayName);
    if (!item) return { state: 'closed' };
    const feedback = candidate.latestHumanDisposition;
    const reason = feedback?.reasonCode === 'other' ? feedback.detail : feedback?.reasonCode;
    return projectApprovalDecisionRead(item.status, () => item, reason);
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

function toSettledItem(
  candidate: StoredPersonMemoryCandidate,
  decidedAt: number,
  displayName?: string,
): SettledApprovalItem | null {
  const navigation = projectApprovalNavigation(candidate, {});
  if (!navigation || !['materialized', 'rejected', 'withdrawn'].includes(candidate.state)) return null;
  const receipt = candidate.latestDecisionReceipt;
  if (candidate.state === 'materialized' && (!displayName || !receipt)) return null;
  const detail =
    candidate.state === 'materialized'
      ? {
          displayName,
          materialized: {
            claims: receipt?.materializedClaimIds.length ?? 0,
            relationships: receipt?.materializedRelationshipIds.length ?? 0,
            events: receipt?.materializedEventIds.length ?? 0,
          },
        }
      : {
          ...(candidate.personDraft ? { displayName: candidate.personDraft.displayName } : {}),
          ...(candidate.replacedByProposalId ? { replacedByProposalId: candidate.replacedByProposalId } : {}),
          ...(candidate.latestHumanDisposition
            ? { dispositionReason: candidate.latestHumanDisposition.reasonCode }
            : {}),
        };
  return {
    proposalId: candidate.candidateId,
    sourceFeatureId: 'F276',
    requesterCatId: candidate.requesterCatId,
    ownerUserId: candidate.ownerUserId,
    status:
      candidate.state === 'materialized'
        ? 'approved'
        : candidate.state === 'rejected'
          ? 'rejected'
          : candidate.replacedByProposalId
            ? 'superseded'
            : 'withdrawn',
    summary:
      candidate.state === 'materialized'
        ? `记住人物：${displayName}`
        : candidate.state === 'rejected'
          ? '人物提案（内容已清除）'
          : '人物提案',
    detail: {
      ...detail,
      ...(candidate.state === 'materialized' && receipt?.decisionId
        ? { canonicalEffectProofRef: `person-memory-decision:${receipt.decisionId}` }
        : {}),
      ...projectPersonMemoryRetainedEffects(candidate),
      ...(decidedAt === 0 ? { closureTimeUnknown: true } : {}),
    },
    navigation,
    decisionMode: 'claim-select',
    decidedAt,
    decidedBy: candidate.state === 'withdrawn' ? '' : candidate.ownerUserId,
    createdAt: candidate.createdAt,
  };
}
