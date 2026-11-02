import { InMemorySettledIndex } from '../../../../../utils/in-memory-settled-index.js';
import type { SettledHistoryPageOptions, SettledHistorySourcePage } from '../../../../../utils/settled-history-page.js';
/**
 * F128 Proposal Store
 * Cats propose threads; users approve/reject. Proposal is the persistent
 * record across the propose-approve flow.
 */

import type { ApprovalEnvelope, ApprovalPublication, ProposalApproveOverrides, ThreadProposal } from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity, commitApprovalEnvelope, generateProposalId } from '@cat-cafe/shared';
import {
  type ApprovedTaskContinuationInput,
  type ApprovedTaskContinuationResult,
  decideApprovedTaskContinuation,
  implementationUsedProposal,
  type MemoryContinuationAuthority,
} from '../../../../ball-custody/approved-task-continuation.js';
import { freezeApprovedTaskContract } from '../../../../ball-custody/approved-task-contract.js';

import type {
  ClaimForApprovalInput,
  CreateProposalInput,
  FinalizeApprovalInput,
  IProposalStore,
  RejectProposalInput,
  WithdrawProposalInput,
} from './ProposalStoreContracts.js';

export type {
  ClaimForApprovalInput,
  CreateProposalInput,
  FinalizeApprovalInput,
  IProposalStore,
  RejectProposalInput,
  WithdrawProposalInput,
} from './ProposalStoreContracts.js';

import { applyProposalOverrides, cloneProposal } from './ProposalSnapshot.js';

const DEFAULT_LIST_LIMIT = 100;

/**
 * In-memory implementation for tests and single-process dev.
 */
export class InMemoryProposalStore implements IProposalStore {
  private readonly historyIndex = new InMemorySettledIndex();

  /** Keep only derived ordering refs; original snapshots and mutation semantics remain unchanged. */
  private indexedSnapshot(record: ThreadProposal): ThreadProposal {
    this.historyIndex.update(
      record.createdBy,
      record.proposalId,
      ['approved', 'rejected', 'withdrawn'].includes(record.status)
        ? (record.withdrawnAt ?? record.approvedAt ?? record.rejectedAt ?? 0)
        : null,
    );
    return cloneProposal(record);
  }

  async listSettledPage(
    owner: string,
    options: SettledHistoryPageOptions,
  ): Promise<SettledHistorySourcePage<ThreadProposal>> {
    return this.historyIndex.page(owner, options, async (id) => {
      const record = this.proposals.get(id);
      return record && record.createdBy === owner && ['approved', 'rejected', 'withdrawn'].includes(record.status)
        ? this.indexedSnapshot(record)
        : null;
    });
  }

  private readonly proposals: Map<string, ThreadProposal> = new Map();
  private readonly dedupCache: Map<string, string> = new Map();

  continueApprovedTask(
    input: ApprovedTaskContinuationInput,
    authority?: MemoryContinuationAuthority,
  ): ApprovedTaskContinuationResult {
    if (!authority) return { outcome: 'rejected', reason: 'unavailable' };
    const proposal = this.proposals.get(input.proposalId) ?? null;
    const result = decideApprovedTaskContinuation(
      input,
      proposal,
      authority.task(input.taskId),
      proposal?.createdThreadId ? authority.child(proposal.createdThreadId) : null,
      proposal
        ? (authority
            .implementations(input.taskId, input.actor.userId)
            .find((lease) => implementationUsedProposal(lease, proposal)) ?? null)
        : null,
    );
    if (result.outcome === 'continued' && proposal) proposal.taskContractContinuation = structuredClone(result.receipt);
    return result;
  }

  create(input: CreateProposalInput): ThreadProposal {
    const now = Date.now();
    const proposal: ThreadProposal = {
      proposalId: input.proposalId ?? generateProposalId(),
      status: 'pending',
      sourceThreadId: input.sourceThreadId,
      sourceInvocationId: input.sourceInvocationId,
      sourceCatId: input.sourceCatId,
      sourceMessageId: input.sourceMessageId,
      title: input.title,
      reason: input.reason,
      parentThreadId: input.parentThreadId,
      preferredCats: [...input.preferredCats],
      projectPath: input.projectPath,
      suggestedGroupId: input.suggestedGroupId,
      suggestedPinned: input.suggestedPinned,
      groupSuggestionReason: input.groupSuggestionReason,
      supersedesProposalId: input.supersedesProposalId,
      createdBy: input.createdBy,
      createdAt: now,
      publication: { state: 'staged', stagedAt: now },
      ...(input.initialMessage ? { initialMessage: input.initialMessage } : {}),
      ...(input.reportingMode ? { reportingMode: input.reportingMode } : {}),
      ...(input.declaredWorkMode ? { declaredWorkMode: input.declaredWorkMode } : {}),
      ...(input.subjectTaskId ? { subjectTaskId: input.subjectTaskId } : {}),
      ...(input.subjectTaskTitle ? { subjectTaskTitle: input.subjectTaskTitle } : {}),
      ...(input.approvedDevelopmentScope ? { approvedDevelopmentScope: { ...input.approvedDevelopmentScope } } : {}),
    };
    this.proposals.set(proposal.proposalId, proposal);
    return this.indexedSnapshot(proposal);
  }

  get(proposalId: string): ThreadProposal | null {
    const found = this.proposals.get(proposalId);
    return found ? this.indexedSnapshot(found) : null;
  }

  recordRevisionRequest(
    proposalId: string,
    request: NonNullable<ThreadProposal['revisionRequest']>,
  ): ThreadProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    if (
      proposal.revisionRequest &&
      (proposal.revisionRequest.instruction !== request.instruction ||
        (['suggestedGroupId', 'projectPath', 'pinned'] as const).some(
          (key) => proposal.revisionRequest?.choices?.[key] !== request.choices?.[key],
        ))
    )
      return null;
    proposal.revisionRequest ??= structuredClone(request);
    if (request.queuedAt && proposal.revisionRequest.messageId === request.messageId)
      proposal.revisionRequest.queuedAt ??= request.queuedAt;
    return this.indexedSnapshot(proposal);
  }

  supersedePending(proposalId: string, replacementId: string, requestMessageId: string): ThreadProposal | null {
    const proposal = this.proposals.get(proposalId);
    const next = this.proposals.get(replacementId);
    if (proposal?.supersededByProposalId === replacementId) return this.indexedSnapshot(proposal);
    if (
      !proposal ||
      proposal.status !== 'pending' ||
      proposal.revisionRequest?.messageId !== requestMessageId ||
      !next?.cardMessageId ||
      next.status !== 'pending' ||
      next.supersedesProposalId !== proposalId ||
      next.sourceMessageId !== requestMessageId ||
      next.createdBy !== proposal.createdBy ||
      next.sourceCatId !== proposal.sourceCatId ||
      next.sourceThreadId !== proposal.sourceThreadId
    )
      return null;
    proposal.status = 'withdrawn';
    proposal.withdrawnBy = proposal.sourceCatId;
    proposal.withdrawnAt = Date.now();
    proposal.supersededByProposalId = replacementId;
    return this.indexedSnapshot(proposal);
  }

  listByUser(userId: string, limit: number = DEFAULT_LIST_LIMIT): ThreadProposal[] {
    return this.collect((p) => p.createdBy === userId, limit);
  }

  listSettledByUser(userId: string, limit = DEFAULT_LIST_LIMIT): ThreadProposal[] {
    return [...this.proposals.values()]
      .filter((p) => p.createdBy === userId && ['approved', 'rejected', 'withdrawn'].includes(p.status))
      .sort(
        (a, b) =>
          (b.withdrawnAt ?? b.approvedAt ?? b.rejectedAt ?? b.createdAt) -
          (a.withdrawnAt ?? a.approvedAt ?? a.rejectedAt ?? a.createdAt),
      )
      .slice(0, limit)
      .map(cloneProposal);
  }

  listPending(userId: string, limit: number = DEFAULT_LIST_LIMIT): ThreadProposal[] {
    return this.collect((p) => p.createdBy === userId && p.status === 'pending', limit);
  }

  listByThread(threadId: string, limit: number = DEFAULT_LIST_LIMIT): ThreadProposal[] {
    return this.collect((p) => p.sourceThreadId === threadId, limit);
  }

  listAllByThread(threadId: string): ThreadProposal[] {
    return this.collect((p) => p.sourceThreadId === threadId, this.proposals.size);
  }

  claimForApproval(input: ClaimForApprovalInput): ThreadProposal | null {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'approving';
    proposal.approvedBy = input.approvedBy;
    proposal.claimedAt = Date.now();
    return this.indexedSnapshot(proposal);
  }

  finalizeApproval(input: FinalizeApprovalInput): ThreadProposal | null {
    const proposal = this.proposals.get(input.proposalId);
    if (
      !proposal ||
      proposal.status !== 'approving' ||
      (proposal.createdThreadId && proposal.createdThreadId !== input.createdThreadId)
    )
      return null;
    const updated = this.indexedSnapshot(proposal);
    updated.status = 'approved';
    updated.approvedAt = Date.now();
    updated.createdThreadId = input.createdThreadId;
    delete updated.claimedAt;
    applyProposalOverrides(updated, input.overrides);
    freezeApprovedTaskContract(updated);
    this.proposals.set(updated.proposalId, updated);
    return this.indexedSnapshot(updated);
  }

  rollbackClaim(proposalId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return false;
    proposal.status = 'pending';
    delete proposal.approvedBy;
    delete proposal.claimedAt;
    return true;
  }

  recordCreatedThread(proposalId: string, threadId: string, overrides?: ProposalApproveOverrides): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return;
    proposal.createdThreadId = threadId;
    applyProposalOverrides(proposal, overrides);
  }

  markRejected(input: RejectProposalInput): ThreadProposal | null {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'rejected';
    proposal.rejectedBy = input.rejectedBy;
    proposal.rejectedAt = Date.now();
    if (input.rejectionReason) proposal.rejectionReason = input.rejectionReason;
    return this.indexedSnapshot(proposal);
  }

  withdrawPending(input: WithdrawProposalInput): ThreadProposal | null {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'withdrawn';
    proposal.withdrawnBy = input.withdrawnBy;
    proposal.withdrawnAt = Date.now();
    return this.indexedSnapshot(proposal);
  }

  getDedupProposalId(userId: string, clientRequestId: string): string | null {
    return this.dedupCache.get(dedupKey(userId, clientRequestId)) ?? null;
  }

  reserveDedup(userId: string, clientRequestId: string, proposalId: string): string {
    const key = dedupKey(userId, clientRequestId);
    const existing = this.dedupCache.get(key);
    if (existing !== undefined) return existing;
    this.dedupCache.set(key, proposalId);
    return proposalId;
  }

  releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): void {
    const key = dedupKey(userId, clientRequestId);
    if (this.dedupCache.get(key) === expectedProposalId) {
      this.dedupCache.delete(key);
    }
  }

  setCardMessageId(proposalId: string, cardMessageId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (proposal) proposal.cardMessageId = cardMessageId;
  }

  getPublication(proposalId: string): ApprovalPublication | null {
    return this.proposals.get(proposalId)?.publication ?? null;
  }

  commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F128',
      ownerUserId: proposal.createdBy,
      requesterCatId: proposal.sourceCatId,
      createdAt: proposal.createdAt,
    });
    proposal.publication = commitApprovalEnvelope(proposal.publication, envelope);
    proposal.cardMessageId = envelope.approvalCardRef.messageId;
  }

  abortStaged(proposalId: string, _reason: string): void {
    const proposal = this.proposals.get(proposalId);
    if (proposal?.publication?.state === 'staged') this.delete(proposalId);
  }

  delete(proposalId: string): void {
    this.historyIndex.update('', proposalId, null);
    this.proposals.delete(proposalId);
  }

  private collect(predicate: (p: ThreadProposal) => boolean, limit: number): ThreadProposal[] {
    const result: ThreadProposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (predicate(proposal)) result.push(this.indexedSnapshot(proposal));
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result.slice(0, Math.max(0, limit));
  }
}

function dedupKey(userId: string, clientRequestId: string): string {
  return `${userId}::${clientRequestId}`;
}
