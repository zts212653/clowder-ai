/**
 * F246: F128 (Thread Proposal) → ApprovalItem adapter.
 *
 * Maps pending ThreadProposals from F128's canonical store to unified
 * ApprovalItem DTOs. Phase A: inlineApprovable = false because Hub drawer
 * doesn't implement the full approve-time override form (AC-A4 强制跳转).
 * Stale threshold: 7 days.
 */

import type { ApprovalItem, ThreadProposal } from '@cat-cafe/shared';
import type { IProposalStore } from '../../cats/services/stores/ports/ProposalStore.js';
import type { IApprovalAdapter } from '../ports/IApprovalAdapter.js';

const F128_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class F128ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F128' as const;

  constructor(private readonly proposalStore: IProposalStore) {}

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.proposalStore.listPending(userId);
    if (Array.isArray(result)) return result.map((p) => toItem(p));
    return result.then((proposals) => proposals.map((p) => toItem(p)));
  }
}

function toItem(p: ThreadProposal): ApprovalItem {
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F128' as const,
    sourceThreadId: p.sourceThreadId,
    sourceMessageId: p.cardMessageId,
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
    inlineApprovable: false,
    expiresAt: p.createdAt + F128_STALE_MS,
    createdAt: p.createdAt,
  };
}
