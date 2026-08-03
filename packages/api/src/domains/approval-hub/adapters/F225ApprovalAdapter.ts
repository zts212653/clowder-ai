/**
 * F246: F225 (Session Handoff Proposal) → ApprovalItem adapter.
 *
 * Maps pending SessionHandoffProposals from F225's canonical store to unified
 * ApprovalItem DTOs. inlineApprovable = false (F225 needs session context —
 * Hub shows a "jump to thread" action, not inline approve). Stale threshold: 24h.
 *
 * Phase G (F246): adds listSettled() — surfaces approved/rejected proposals in
 * the approval history tab using listSettledByUser() added to the store.
 * decidedAt = updatedAt (set at approve/reject time); decidedBy = userId (always operator).
 */

import type { ApprovalItem, SessionHandoffProposal, SettledApprovalItem } from '@cat-cafe/shared';
import type { ISessionHandoffProposalStore } from '../../cats/services/stores/ports/SessionHandoffProposalStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';

const F225_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class F225ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F225' as const;

  constructor(private readonly store: ISessionHandoffProposalStore) {}

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.store.listPendingByUser(userId);
    if (Array.isArray(result)) return compactApprovalProjections(result.map((p) => toItem(p)));
    return result.then((proposals) => compactApprovalProjections(proposals.map((p) => toItem(p))));
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const limit = opts?.limit ?? 50;
    const resultRaw = this.store.listSettledByUser(userId, limit);
    const proposals = Array.isArray(resultRaw) ? resultRaw : await resultRaw;
    return compactApprovalProjections(proposals.map((p) => toSettledItem(p)));
  }
}

function toItem(p: SessionHandoffProposal): ApprovalItem | null {
  const navigation = projectApprovalNavigation(p, {
    legacyThreadId: p.sourceThreadId,
    legacyMessageId: p.cardMessageId,
  });
  if (!navigation) return null;
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F225' as const,
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
    navigation,
    inlineApprovable: false,
    expiresAt: p.createdAt + F225_STALE_MS,
    createdAt: p.createdAt,
  };
}

function toSettledItem(p: SessionHandoffProposal): SettledApprovalItem | null {
  const navigation = projectApprovalNavigation(p, {
    legacyThreadId: p.sourceThreadId,
    legacyMessageId: p.cardMessageId,
  });
  if (!navigation) return null;
  // F225 has no dedicated decidedBy field — the decision-maker is always the operator (userId).
  // updatedAt is set to Date.now() at approve/reject time, so it serves as decidedAt.
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F225' as const,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.userId,
    status: p.status as 'approved' | 'rejected',
    summary: `Session handoff: ${p.sourceCatId} → ${p.note.done.slice(0, 60)}`,
    detail: {
      done: p.note.done,
      nextSteps: p.note.nextSteps,
      worktreeBranch: p.note.worktreeBranch,
      commits: p.note.commits,
      gotchas: p.note.gotchas,
      sourceSessionId: p.sourceSessionId,
    },
    navigation,
    decidedAt: p.updatedAt,
    decidedBy: p.userId,
    createdAt: p.createdAt,
  };
}
