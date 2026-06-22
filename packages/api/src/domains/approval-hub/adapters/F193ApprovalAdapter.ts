/**
 * F246 Phase B: F193 (Cross-Thread Dispatch) → ApprovalItem adapter.
 *
 * Maps pending DispatchProposals (assign_work effect-class) from the
 * DispatchProposal store to unified ApprovalItem DTOs. Stale threshold: 3 days.
 *
 * inlineApprovable = true — assign_work proposals contain all info needed
 * for Hub inline approve/reject (content, targetCats, targetThread).
 */

import type { ApprovalItem, DispatchProposal } from '@cat-cafe/shared';
import type { IApprovalAdapter } from '../ports/IApprovalAdapter.js';
import type { IDispatchProposalStore } from '../stores/ports/IDispatchProposalStore.js';

const F193_STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export class F193ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F193' as const;

  constructor(private readonly store: IDispatchProposalStore) {}

  listPending(userId: string): Promise<ApprovalItem[]> {
    return this.store.listPendingByUser(userId).then((proposals) => proposals.map((p) => toItem(p)));
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
