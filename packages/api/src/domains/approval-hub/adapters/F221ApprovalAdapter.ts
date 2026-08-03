/**
 * F246 v2: F221 (Taste Proposal) → ApprovalItem adapter.
 *
 * Maps pending and recoverable approving TasteProposals from F221's canonical
 * store to unified ApprovalItem DTOs. inlineApprovable = true — taste proposal cards render
 * full context (scene + quote + dimension + tags + privacy) in the Hub,
 * so operator can approve/reject inline without jumping to thread.
 * Stale threshold: 7 days.
 */

import type { ApprovalItem, SettledApprovalItem, TasteProposal } from '@cat-cafe/shared';
import type { ITasteProposalStore } from '../../taste/stores/ports/TasteProposalStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';

const F221_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_SETTLED_LIMIT = 50;

export class F221ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F221' as const;
  private store: ITasteProposalStore;

  constructor(store: ITasteProposalStore) {
    this.store = store;
  }

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.store.listActionable(userId);
    if (Array.isArray(result)) return compactApprovalProjections(result.map((p) => toItem(p)));
    return result.then((proposals) => compactApprovalProjections(proposals.map((p) => toItem(p))));
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const limit = opts?.limit ?? DEFAULT_SETTLED_LIMIT;
    const proposals = await this.store.listSettledByUser(userId, limit);
    return compactApprovalProjections(proposals.map((p) => toSettledItem(p)));
  }
}

function toItem(p: TasteProposal): ApprovalItem | null {
  const navigation = projectApprovalNavigation(p, {
    legacyThreadId: p.threadId,
    legacyMessageId: p.sourceMessageId,
  });
  if (!navigation) return null;
  return {
    proposalId: p.id,
    sourceFeatureId: 'F221' as const,
    requesterCatId: p.catId,
    ownerUserId: p.userId,
    status: 'pending' as const,
    summary: `Taste [${p.dimension}]: ${p.quote.slice(0, 60)}`,
    detail: {
      scene: p.scene,
      quote: p.quote,
      dimension: p.dimension,
      tags: p.tags,
      privacy: p.privacy,
    },
    navigation,
    inlineApprovable: true,
    decisionMode: p.status === 'approving' ? 'resume-only' : 'approve-reject',
    expiresAt: p.createdAt + F221_STALE_MS,
    createdAt: p.createdAt,
  };
}

function toSettledItem(p: TasteProposal): SettledApprovalItem | null {
  if (p.status !== 'approved' && p.status !== 'rejected') {
    throw new Error(`toSettledItem: unexpected status ${p.status} for proposal ${p.id}`);
  }
  const navigation = projectApprovalNavigation(p, {
    legacyThreadId: p.threadId,
    legacyMessageId: p.sourceMessageId,
  });
  if (!navigation) return null;
  return {
    proposalId: p.id,
    sourceFeatureId: 'F221' as const,
    requesterCatId: p.catId,
    ownerUserId: p.userId,
    status: p.status,
    summary: `Taste [${p.dimension}]: ${p.quote.slice(0, 60)}`,
    detail: {
      scene: p.scene,
      quote: p.quote,
      dimension: p.dimension,
      tags: p.tags,
      privacy: p.privacy,
    },
    navigation,
    decidedAt: p.approvedAt ?? p.rejectedAt ?? 0,
    decidedBy: p.approvedBy ?? p.rejectedBy ?? '',
    createdAt: p.createdAt,
  };
}
