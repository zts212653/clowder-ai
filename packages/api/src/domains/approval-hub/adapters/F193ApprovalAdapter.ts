/**
 * F246 Phase B: F193 (Cross-Thread Dispatch) → ApprovalItem adapter.
 *
 * Maps pending DispatchProposals (assign_work effect-class) from the
 * DispatchProposal store to unified ApprovalItem DTOs. Stale threshold: 3 days.
 *
 * inlineApprovable = true — assign_work proposals contain all info needed
 * for Hub inline approve/reject (content, targetCats, targetThread).
 */

import type { ApprovalItem, DispatchProposal, SettledApprovalItem } from '@cat-cafe/shared';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';
import type { IDispatchProposalStore } from '../stores/ports/IDispatchProposalStore.js';

const F193_STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const DEFAULT_SETTLED_LIMIT = 50;

export class F193ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F193' as const;

  constructor(private readonly store: IDispatchProposalStore) {}

  async listPending(userId: string): Promise<ApprovalItem[]> {
    const proposals = await this.store.listPendingByUser(userId);
    return proposals.map((p) => toItem(p));
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const limit = opts?.limit ?? DEFAULT_SETTLED_LIMIT;
    const proposals = await this.store.listSettledByUser(userId, limit);
    return proposals.map((p) => toSettledItem(p));
  }
}

function toItem(p: DispatchProposal): ApprovalItem {
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F193' as const,
    sourceThreadId: p.sourceThreadId,
    sourceMessageId: p.cardMessageId,
    requesterCatId: p.senderCatId,
    ownerUserId: p.ownerUserId,
    status: 'pending' as const,
    summary: `Work assignment: ${p.content.slice(0, 80)}`,
    detail: {
      targetThreadId: p.targetThreadId,
      targetCats: p.targetCats,
      content: p.content,
      effectClass: p.effectClass,
    },
    inlineApprovable: true,
    expiresAt: p.createdAt + F193_STALE_MS,
    createdAt: p.createdAt,
  };
}

function toSettledItem(p: DispatchProposal): SettledApprovalItem {
  if (p.status !== 'approved' && p.status !== 'rejected') {
    throw new Error(`toSettledItem: unexpected status ${p.status} for proposal ${p.proposalId}`);
  }
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F193' as const,
    sourceThreadId: p.sourceThreadId,
    sourceMessageId: p.cardMessageId,
    requesterCatId: p.senderCatId,
    ownerUserId: p.ownerUserId,
    status: p.status,
    summary: `Work assignment: ${p.content.slice(0, 80)}`,
    detail: {
      targetThreadId: p.targetThreadId,
      targetCats: p.targetCats,
      content: p.content,
      effectClass: p.effectClass,
    },
    decidedAt: p.decidedAt ?? 0,
    decidedBy: p.decidedBy ?? '',
    createdAt: p.createdAt,
  };
}
