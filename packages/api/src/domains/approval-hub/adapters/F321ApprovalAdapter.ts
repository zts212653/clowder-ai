import type { ApprovalItem, EventMemoryCorrectionProposal, SettledApprovalItem } from '@cat-cafe/shared';
import type { EventMemoryCorrectionProposalStore } from '../../memory/event/EventMemoryCorrectionProposalStore.js';
import {
  ALL_PENDING_APPROVALS_LIMIT,
  type ApprovalDecisionRead,
  type IApprovalAdapter,
  type ListSettledOpts,
  projectApprovalDecisionRead,
} from '../ports/IApprovalAdapter.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';
import { projectSettledDecisionFacts } from '../settled-decision-facts.js';

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export class F321ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F321' as const;

  constructor(private readonly store: EventMemoryCorrectionProposalStore) {}

  async listPending(ownerUserId: string): Promise<ApprovalItem[]> {
    const proposals = await this.store.listActionable(ownerUserId, ALL_PENDING_APPROVALS_LIMIT);
    return compactApprovalProjections(proposals.map(toItem));
  }

  async readDecision(userId: string, proposalId: string): Promise<ApprovalDecisionRead> {
    const p = await this.store.get(proposalId);
    if (!p || p.ownerUserId !== userId) return { state: 'closed' };
    return projectApprovalDecisionRead(p.status, () => toSettledItem(p), p.rejectionReason);
  }

  async listSettled(ownerUserId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const proposals = await this.store.listSettled(ownerUserId, opts?.limit ?? 50);
    return compactApprovalProjections(proposals.map(toSettledItem));
  }
}

function toItem(proposal: EventMemoryCorrectionProposal): ApprovalItem | null {
  const navigation = projectApprovalNavigation(proposal, { legacyThreadId: proposal.sourceThreadId });
  if (!navigation) return null;
  return {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F321',
    requesterCatId: proposal.sourceCatId,
    ownerUserId: proposal.ownerUserId,
    status: proposal.status,
    summary: `Event correction: ${proposal.eventId}`,
    detail: detailOf(proposal),
    navigation,
    inlineApprovable: true,
    decisionMode: proposal.status === 'approving' ? 'resume-only' : 'approve-reject',
    expiresAt: proposal.createdAt + STALE_MS,
    createdAt: proposal.createdAt,
  };
}

function toSettledItem(proposal: EventMemoryCorrectionProposal): SettledApprovalItem | null {
  if (proposal.status !== 'approved' && proposal.status !== 'rejected') return null;
  const navigation = projectApprovalNavigation(proposal, { legacyThreadId: proposal.sourceThreadId });
  if (!navigation) return null;
  const decision = projectSettledDecisionFacts(proposal);
  return {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F321',
    requesterCatId: proposal.sourceCatId,
    ownerUserId: proposal.ownerUserId,
    status: proposal.status,
    summary: `Event correction: ${proposal.eventId}`,
    detail: { ...detailOf(proposal), ...decision.detail },
    navigation,
    decidedAt: decision.decidedAt,
    decidedBy: decision.decidedBy,
    createdAt: proposal.createdAt,
  };
}

function detailOf(proposal: EventMemoryCorrectionProposal): Record<string, unknown> {
  return {
    eventId: proposal.eventId,
    expectedRevision: proposal.expectedRevision,
    reason: proposal.reason,
    suggestedPatch: proposal.suggestedPatch,
    source: proposal.source,
    ...(proposal.appliedRevision ? { appliedRevision: proposal.appliedRevision } : {}),
    ...(proposal.rejectionReason ? { rejectionReason: proposal.rejectionReason } : {}),
  };
}
