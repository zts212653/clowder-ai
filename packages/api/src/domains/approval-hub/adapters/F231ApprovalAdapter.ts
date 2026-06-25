/**
 * F246 v2: F231 (Profile Update Proposal) → ApprovalItem adapter.
 *
 * Maps pending ProfileUpdateProposals from F231's canonical store to unified
 * ApprovalItem DTOs. inlineApprovable = false — primer diff review requires
 * thread context (same rationale as F225). Stale threshold: 7 days.
 */

import type { ApprovalItem, ProfileUpdateProposal } from '@cat-cafe/shared';
import type { IProfileUpdateProposalStore } from '../../cats/services/stores/ports/ProfileUpdateProposalStore.js';
import type { IApprovalAdapter } from '../ports/IApprovalAdapter.js';

const F231_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class F231ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F231' as const;

  constructor(private readonly store: IProfileUpdateProposalStore) {}

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.store.listPending(userId);
    if (Array.isArray(result)) return result.map((p) => toItem(p));
    return result.then((proposals) => proposals.map((p) => toItem(p)));
  }
}

function toItem(p: ProfileUpdateProposal): ApprovalItem {
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F231' as const,
    sourceThreadId: p.sourceThreadId,
    sourceMessageId: p.cardMessageId,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.createdBy,
    status: 'pending' as const,
    summary: `Profile update: ${p.rationale.slice(0, 80)}`,
    detail: {
      rationale: p.rationale,
      targetLayer: p.targetLayer,
      targetPath: p.targetPath,
      signalKind: p.signalProvenance.kind,
    },
    inlineApprovable: false,
    expiresAt: p.createdAt + F231_STALE_MS,
    createdAt: p.createdAt,
  };
}
