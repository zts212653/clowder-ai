import type { SettledHistoryPageOptions } from '../../../utils/settled-history-page.js';
import { type ApprovalDecisionRead, projectApprovalDecisionRead } from '../ports/IApprovalAdapter.js';
import { projectSettledPage } from '../project-settled-page.js';
/**
 * F246: F128 (Thread Proposal) → ApprovalItem adapter.
 *
 * Maps pending ThreadProposals from F128's canonical store to unified
 * ApprovalItem DTOs. Phase A: inlineApprovable = false because Hub drawer
 * doesn't implement the full approve-time override form (AC-A4 强制跳转).
 * Stale threshold: 7 days.
 *
 * Settled history includes requester withdrawal, read from the owner's bounded
 * terminal index rather than a full scan of all user proposals.
 */

import type { ApprovalItem, SettledApprovalItem, ThreadProposal } from '@cat-cafe/shared';
import type { IProposalStore } from '../../cats/services/stores/ports/ProposalStore.js';
import { ALL_PENDING_APPROVALS_LIMIT, type IApprovalAdapter, type ListSettledOpts } from '../ports/IApprovalAdapter.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';
import { projectSettledDecisionFacts } from '../settled-decision-facts.js';

const F128_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class F128ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F128' as const;

  constructor(
    private readonly proposalStore: IProposalStore,
    private readonly readCreatedThread?: (
      id: string,
    ) =>
      | { id: string; createdBy?: string; createdFromProposalId?: string }
      | null
      | undefined
      | Promise<{ id: string; createdBy?: string; createdFromProposalId?: string } | null | undefined>,
  ) {}

  async listSettledPage(owner: string, options: SettledHistoryPageOptions) {
    return projectSettledPage(this.proposalStore, owner, options, async (proposal) => {
      const item = toSettledItem(proposal);
      if (item && proposal.status === 'approved' && proposal.createdThreadId && this.readCreatedThread) {
        const thread = await this.readCreatedThread(proposal.createdThreadId);
        if (
          thread?.id === proposal.createdThreadId &&
          thread.createdBy === owner &&
          thread.createdFromProposalId === proposal.proposalId
        )
          item.detail.createdThreadProof = { threadId: thread.id, ownerUserId: owner, proposalId: proposal.proposalId };
      }
      return item;
    });
  }

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.proposalStore.listPending(userId, ALL_PENDING_APPROVALS_LIMIT);
    if (Array.isArray(result)) return compactApprovalProjections(result.map((p) => toItem(p)));
    return result.then((proposals) => compactApprovalProjections(proposals.map((p) => toItem(p))));
  }

  async readDecision(userId: string, proposalId: string): Promise<ApprovalDecisionRead> {
    const p = await this.proposalStore.get(proposalId);
    if (!p || p.createdBy !== userId) return { state: 'closed' };
    return projectApprovalDecisionRead(p.status, () => toSettledItem(p), p.rejectionReason);
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const limit = opts?.limit ?? 50;
    const all = await this.proposalStore.listSettledByUser(userId, limit);
    return all
      .filter((p) => p.status === 'approved' || p.status === 'rejected' || p.status === 'withdrawn')
      .map(toSettledItem)
      .filter((item): item is SettledApprovalItem => item !== null)
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .slice(0, limit);
  }
}

function toItem(p: ThreadProposal): ApprovalItem | null {
  const navigation = projectApprovalNavigation(p, {
    legacyThreadId: p.sourceThreadId,
    legacyMessageId: p.cardMessageId,
  });
  if (!navigation) return null;
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F128' as const,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.createdBy,
    status: 'pending' as const,
    summary: `New thread: ${p.title}`,
    detail: {
      title: p.title,
      reason: p.reason,
      parentThreadId: p.parentThreadId,
      preferredCats: p.preferredCats,
      initialMessage: p.initialMessage,
      projectPath: p.projectPath,
      reportingMode: p.reportingMode,
    },
    navigation,
    inlineApprovable: false,
    expiresAt: p.createdAt + F128_STALE_MS,
    createdAt: p.createdAt,
  };
}

function toSettledItem(p: ThreadProposal): SettledApprovalItem | null {
  const navigation = projectApprovalNavigation(p, {
    legacyThreadId: p.sourceThreadId,
    legacyMessageId: p.cardMessageId,
  });
  if (!navigation) return null;
  const decision = projectSettledDecisionFacts(p);
  const createdThreadId = p.status === 'approved' && p.createdThreadId?.trim() ? p.createdThreadId : undefined;
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F128' as const,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.createdBy,
    status: p.status as 'approved' | 'rejected' | 'withdrawn',
    summary: `New thread: ${p.title}`,
    detail: {
      ...decision.detail,
      ...(p.rejectionReason ? { rejectionReason: p.rejectionReason } : {}),
      ...(createdThreadId ? { createdThreadId, canonicalEffectProofRef: `thread:${createdThreadId}` } : {}),
      title: p.title,
      reason: p.reason,
      parentThreadId: p.parentThreadId,
      preferredCats: p.preferredCats,
      initialMessage: p.initialMessage,
      projectPath: p.projectPath,
      reportingMode: p.reportingMode,
    },
    navigation,
    decidedAt: decision.decidedAt,
    decidedBy: decision.decidedBy,
    createdAt: p.createdAt,
  };
}
