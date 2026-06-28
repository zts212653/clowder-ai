/**
 * F246: F225 (Session Handoff Proposal) → ApprovalItem adapter.
 *
 * Maps pending SessionHandoffProposals from F225's canonical store to unified
 * ApprovalItem DTOs. inlineApprovable = false (F225 needs session context —
 * Hub shows a "jump to thread" action, not inline approve). Stale threshold: 24h.
 */

import type { ApprovalItem, SessionHandoffProposal } from '@cat-cafe/shared';
import type { ISessionHandoffProposalStore } from '../../cats/services/stores/ports/SessionHandoffProposalStore.js';
import type { IApprovalAdapter } from '../ports/IApprovalAdapter.js';

const F225_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class F225ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F225' as const;

  constructor(private readonly store: ISessionHandoffProposalStore) {}

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.store.listPendingByUser(userId);
    if (Array.isArray(result)) return result.map((p) => toItem(p));
    return result.then((proposals) => proposals.map((p) => toItem(p)));
  }
}

function toItem(p: SessionHandoffProposal): ApprovalItem {
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F225' as const,
    sourceThreadId: p.sourceThreadId,
    sourceMessageId: p.cardMessageId,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.userId,
    status: 'pending' as const,
    summary: `Session handoff: ${p.sourceCatId} → ${p.note.done.slice(0, 60)}`,
    detail: {
      done: p.note.done,
      nextSteps: p.note.nextSteps,
      worktreeBranch: p.note.worktreeBranch,
      commits: p.note.commits,
      gotchas: p.note.gotchas,
      sourceSessionId: p.sourceSessionId,
    },
    inlineApprovable: false,
    expiresAt: p.createdAt + F225_STALE_MS,
    createdAt: p.createdAt,
  };
}
