import { type ApprovalDecisionRead, projectApprovalDecisionRead } from '../ports/IApprovalAdapter.js';
/**
 * F246: F225 (Session Handoff Proposal) → ApprovalItem adapter.
 *
 * Maps pending SessionHandoffProposals from F225's canonical store to unified
 * ApprovalItem DTOs. inlineApprovable = false (F225 needs session context —
 * Hub shows a "jump to thread" action, not inline approve). Stale threshold: 24h.
 *
 * Settled history surfaces approved/rejected/expired proposals in
 * the approval history tab using listSettledByUser() added to the store.
 * decidedAt = updatedAt at the actual transition; expiry has no human decider.
 */

import type { ApprovalItem, SessionHandoffProposal, SettledApprovalItem } from '@cat-cafe/shared';
import type { ISessionHandoffProposalStore } from '../../cats/services/stores/ports/SessionHandoffProposalStore.js';
import { ALL_PENDING_APPROVALS_LIMIT, type IApprovalAdapter, type ListSettledOpts } from '../ports/IApprovalAdapter.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';

const F225_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class F225ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F225' as const;

  constructor(private readonly store: ISessionHandoffProposalStore) {}

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.store.listPendingByUser(userId, ALL_PENDING_APPROVALS_LIMIT);
    if (Array.isArray(result)) return compactApprovalProjections(result.map((p) => toItem(p)));
    return result.then((proposals) => compactApprovalProjections(proposals.map((p) => toItem(p))));
  }

  async readDecision(userId: string, proposalId: string): Promise<ApprovalDecisionRead> {
    const p = await this.store.get(proposalId);
    if (!p || p.userId !== userId) return { state: 'closed' };
    const feedback = p.latestHumanDisposition;
    const reason = feedback?.reasonCode === 'other' ? feedback.detail : feedback?.reasonCode;
    return projectApprovalDecisionRead(p.status, () => toSettledItem(p), reason);
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
  // Only approve/reject are operator decisions. System expiry retains its time without a human actor.
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F225' as const,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.userId,
    status: p.status as 'approved' | 'rejected' | 'expired',
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
    decidedBy: p.status === 'expired' ? '' : p.userId,
    createdAt: p.createdAt,
  };
}
