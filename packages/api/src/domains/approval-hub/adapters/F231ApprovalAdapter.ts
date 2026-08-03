/**
 * F246 v2: F231 (Profile Update Proposal) → ApprovalItem adapter.
 *
 * Maps pending ProfileUpdateProposals from F231's canonical store to unified
 * ApprovalItem DTOs. inlineApprovable = false — primer diff review requires
 * thread context (same rationale as F225). Stale threshold: 7 days.
 *
 * Phase H additions: listSettled() for approval history tab.
 */

import type { ApprovalItem, ProfileUpdateProposal, SettledApprovalItem } from '@cat-cafe/shared';
import type { IProfileUpdateProposalStore } from '../../cats/services/stores/ports/ProfileUpdateProposalStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';

const F231_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_SETTLED_LIMIT = 50;

export class F231ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F231' as const;

  constructor(private readonly store: IProfileUpdateProposalStore) {}

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.store.listPending(userId);
    if (Array.isArray(result)) return compactApprovalProjections(result.map((p) => toItem(p)));
    return result.then((proposals) => compactApprovalProjections(proposals.map((p) => toItem(p))));
  }

  /** F246 Phase H: approved/rejected proposals for the history tab. */
  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const limit = opts?.limit ?? DEFAULT_SETTLED_LIMIT;
    const proposals = await this.store.listSettledByUser(userId, limit);
    return compactApprovalProjections(proposals.map((p) => toSettledItem(p)));
  }
}

function toItem(p: ProfileUpdateProposal): ApprovalItem | null {
  const navigation = projectApprovalNavigation(p, {
    legacyThreadId: p.sourceThreadId,
    legacyMessageId: p.cardMessageId,
  });
  if (!navigation) return null;
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F231' as const,
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
    navigation,
    inlineApprovable: false,
    expiresAt: p.createdAt + F231_STALE_MS,
    createdAt: p.createdAt,
  };
}

function toSettledItem(p: ProfileUpdateProposal): SettledApprovalItem | null {
  if (p.status !== 'approved' && p.status !== 'rejected') {
    throw new Error(`toSettledItem: unexpected status ${p.status} for proposal ${p.proposalId}`);
  }
  const navigation = projectApprovalNavigation(p, {
    legacyThreadId: p.sourceThreadId,
    legacyMessageId: p.cardMessageId,
  });
  if (!navigation) return null;
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F231' as const,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.createdBy,
    status: p.status,
    summary: `Profile update: ${p.rationale.slice(0, 80)}`,
    detail: {
      rationale: p.rationale,
      targetLayer: p.targetLayer,
      targetPath: p.targetPath,
      signalKind: p.signalProvenance.kind,
    },
    navigation,
    decidedAt: p.approvedAt ?? p.rejectedAt ?? 0,
    decidedBy: p.approvedBy ?? p.rejectedBy ?? '',
    createdAt: p.createdAt,
  };
}
