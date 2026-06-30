/**
 * F246: F128 (Thread Proposal) → ApprovalItem adapter.
 *
 * Maps pending ThreadProposals from F128's canonical store to unified
 * ApprovalItem DTOs. Phase A: inlineApprovable = false because Hub drawer
 * doesn't implement the full approve-time override form (AC-A4 强制跳转).
 * Stale threshold: 7 days.
 *
 * Phase G (F246): adds listSettled() — surfaces approved/rejected proposals
 * in the approval history tab using the existing listByUser() store method.
 */

import type { ApprovalItem, SettledApprovalItem, ThreadProposal } from '@cat-cafe/shared';
import type { IProposalStore } from '../../cats/services/stores/ports/ProposalStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';

const F128_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class F128ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F128' as const;

  constructor(private readonly proposalStore: IProposalStore) {}

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.proposalStore.listPending(userId);
    if (Array.isArray(result)) return result.map((p) => toItem(p));
    return result.then((proposals) => proposals.map((p) => toItem(p)));
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const limit = opts?.limit ?? 50;
    // listByUser returns ALL proposals (pending + settled) sorted by createdAt desc.
    // We must collect ALL settled proposals first, then sort by decidedAt desc, then limit.
    // Pass Number.MAX_SAFE_INTEGER to bypass the store's DEFAULT_LIST_LIMIT (100) — otherwise
    // older proposals (beyond position 100 in createdAt-desc order) are silently excluded
    // before filter+sort, causing recently-decided old proposals to disappear from the
    // history tab when the user has many proposals total (P2 fix, F246-G).
    const allRaw = this.proposalStore.listByUser(userId, Number.MAX_SAFE_INTEGER);
    const all = Array.isArray(allRaw) ? allRaw : await allRaw;
    return all
      .filter((p) => p.status === 'approved' || p.status === 'rejected')
      .map(toSettledItem)
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .slice(0, limit);
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

function toSettledItem(p: ThreadProposal): SettledApprovalItem {
  // Map approved/rejected timestamps: prefer dedicated fields, fall back to createdBy
  const decidedAt = p.approvedAt ?? p.rejectedAt ?? p.createdAt;
  const decidedBy = p.approvedBy ?? p.rejectedBy ?? p.createdBy;
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F128' as const,
    sourceThreadId: p.sourceThreadId,
    sourceMessageId: p.cardMessageId,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.createdBy,
    status: p.status as 'approved' | 'rejected',
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
    decidedAt,
    decidedBy: decidedBy ?? 'unknown',
    createdAt: p.createdAt,
  };
}
