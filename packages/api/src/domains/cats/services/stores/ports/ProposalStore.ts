/**
 * F128 Proposal Store
 * Cats propose threads; users approve/reject. Proposal is the persistent
 * record across the propose-approve flow.
 */

import type { CatId, ProposalApproveOverrides, ThreadProposal } from '@cat-cafe/shared';
import { generateProposalId } from '@cat-cafe/shared';

export interface CreateProposalInput {
  sourceThreadId: string;
  sourceInvocationId: string;
  sourceCatId: CatId;
  title: string;
  reason: string;
  parentThreadId: string;
  preferredCats: CatId[];
  projectPath: string;
  initialMessage?: string;
  createdBy: string;
  /**
   * Optional explicit proposalId. When supplied, the store uses this value instead of
   * generating one. Used by the propose route to reserve a dedup key BEFORE creating
   * the proposal, ensuring losers in a concurrent retry never produce orphan records.
   */
  proposalId?: string;
}

export interface ClaimForApprovalInput {
  proposalId: string;
  approvedBy: string;
}

export interface FinalizeApprovalInput {
  proposalId: string;
  createdThreadId: string;
  overrides?: ProposalApproveOverrides;
}

export interface RejectProposalInput {
  proposalId: string;
  rejectedBy: string;
  rejectionReason?: string;
}

export interface IProposalStore {
  create(input: CreateProposalInput): ThreadProposal | Promise<ThreadProposal>;
  get(proposalId: string): ThreadProposal | null | Promise<ThreadProposal | null>;
  listByUser(userId: string, limit?: number): ThreadProposal[] | Promise<ThreadProposal[]>;
  listPending(userId: string, limit?: number): ThreadProposal[] | Promise<ThreadProposal[]>;
  listByThread(threadId: string, limit?: number): ThreadProposal[] | Promise<ThreadProposal[]>;
  /**
   * Atomic CAS pending → approving. Returns the claimed proposal snapshot, or null if status
   * was not pending (e.g. already approved/rejected/claimed). Caller MUST call finalizeApproval
   * or rollbackClaim afterwards.
   */
  claimForApproval(input: ClaimForApprovalInput): ThreadProposal | null | Promise<ThreadProposal | null>;
  /** CAS approving → approved. Returns updated proposal or null if status drifted. */
  finalizeApproval(input: FinalizeApprovalInput): ThreadProposal | null | Promise<ThreadProposal | null>;
  /**
   * Persist `createdThreadId` on an approving proposal WITHOUT changing status.
   * Caller invokes this immediately after threadStore.create succeeds, BEFORE
   * finalizeApproval. This makes the partial-commit state idempotently recoverable:
   * if the process dies between create and finalize, the proposal records which
   * thread already exists — stale-claim recovery can then re-finalize instead of
   * rolling back (which would cause a duplicate thread on the next approve).
   * No-op if proposal status is not 'approving'.
   */
  recordCreatedThread(proposalId: string, threadId: string): void | Promise<void>;
  /** CAS approving → pending. Used when thread creation fails after claim. */
  rollbackClaim(proposalId: string): boolean | Promise<boolean>;
  /** CAS pending → rejected. Returns null if status is not pending (e.g. already approving/approved). */
  markRejected(input: RejectProposalInput): ThreadProposal | null | Promise<ThreadProposal | null>;
  /** Idempotency: return cached proposalId for (userId, clientRequestId) if any. */
  getDedupProposalId(userId: string, clientRequestId: string): string | null | Promise<string | null>;
  /**
   * Idempotency: try to reserve (userId, clientRequestId) → proposalId atomically.
   * Returns the proposalId actually stored — caller's value if newly reserved, or the existing
   * value if a concurrent request beat it. Use the returned value as the canonical proposalId.
   */
  reserveDedup(userId: string, clientRequestId: string, proposalId: string): string | Promise<string>;
  /**
   * Mark the proposal as visible by recording the rich-card messageId that was appended to the
   * source thread. Until this is set, dedup fast paths must treat the proposal as in-flight
   * and not return it as a successful prior result.
   */
  setCardMessageId(proposalId: string, cardMessageId: string): void | Promise<void>;
  /**
   * Hard delete: remove proposal record and all index entries. Used to clean up after a
   * partial-commit failure during propose (e.g. proposal created but its card message
   * failed to post). Idempotent — no error if the proposal is already gone.
   */
  delete(proposalId: string): void | Promise<void>;
  /**
   * Idempotency cleanup: release the dedup reservation IF it currently points at expectedProposalId.
   * Used when `create` fails after a successful reservation, so retries can reclaim the key.
   * No-op if the key is missing or points at a different proposalId (defensive: never wipe
   * someone else's winning reservation).
   */
  releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): void | Promise<void>;
}

const DEFAULT_LIST_LIMIT = 100;

/**
 * In-memory implementation for tests and single-process dev.
 */
export class InMemoryProposalStore implements IProposalStore {
  private readonly proposals: Map<string, ThreadProposal> = new Map();
  private readonly dedupCache: Map<string, string> = new Map();

  create(input: CreateProposalInput): ThreadProposal {
    const now = Date.now();
    const proposal: ThreadProposal = {
      proposalId: input.proposalId ?? generateProposalId(),
      status: 'pending',
      sourceThreadId: input.sourceThreadId,
      sourceInvocationId: input.sourceInvocationId,
      sourceCatId: input.sourceCatId,
      title: input.title,
      reason: input.reason,
      parentThreadId: input.parentThreadId,
      preferredCats: [...input.preferredCats],
      projectPath: input.projectPath,
      createdBy: input.createdBy,
      createdAt: now,
      ...(input.initialMessage ? { initialMessage: input.initialMessage } : {}),
    };
    this.proposals.set(proposal.proposalId, proposal);
    return cloneProposal(proposal);
  }

  get(proposalId: string): ThreadProposal | null {
    const found = this.proposals.get(proposalId);
    return found ? cloneProposal(found) : null;
  }

  listByUser(userId: string, limit: number = DEFAULT_LIST_LIMIT): ThreadProposal[] {
    return this.collect((p) => p.createdBy === userId, limit);
  }

  listPending(userId: string, limit: number = DEFAULT_LIST_LIMIT): ThreadProposal[] {
    return this.collect((p) => p.createdBy === userId && p.status === 'pending', limit);
  }

  listByThread(threadId: string, limit: number = DEFAULT_LIST_LIMIT): ThreadProposal[] {
    return this.collect((p) => p.sourceThreadId === threadId, limit);
  }

  claimForApproval(input: ClaimForApprovalInput): ThreadProposal | null {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'approving';
    proposal.approvedBy = input.approvedBy;
    proposal.claimedAt = Date.now();
    return cloneProposal(proposal);
  }

  finalizeApproval(input: FinalizeApprovalInput): ThreadProposal | null {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.status !== 'approving') return null;
    proposal.status = 'approved';
    proposal.approvedAt = Date.now();
    proposal.createdThreadId = input.createdThreadId;
    delete proposal.claimedAt;
    if (input.overrides?.title !== undefined) proposal.title = input.overrides.title;
    if (input.overrides?.parentThreadId !== undefined) {
      proposal.parentThreadId = input.overrides.parentThreadId;
    }
    if (input.overrides?.preferredCats !== undefined) {
      proposal.preferredCats = [...input.overrides.preferredCats];
    }
    if (input.overrides?.initialMessage === null) {
      delete proposal.initialMessage;
    } else if (typeof input.overrides?.initialMessage === 'string') {
      proposal.initialMessage = input.overrides.initialMessage;
    }
    return cloneProposal(proposal);
  }

  rollbackClaim(proposalId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return false;
    proposal.status = 'pending';
    delete proposal.approvedBy;
    delete proposal.claimedAt;
    return true;
  }

  recordCreatedThread(proposalId: string, threadId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return;
    proposal.createdThreadId = threadId;
  }

  markRejected(input: RejectProposalInput): ThreadProposal | null {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'rejected';
    proposal.rejectedBy = input.rejectedBy;
    proposal.rejectedAt = Date.now();
    if (input.rejectionReason) proposal.rejectionReason = input.rejectionReason;
    return cloneProposal(proposal);
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

  delete(proposalId: string): void {
    this.proposals.delete(proposalId);
  }

  private collect(predicate: (p: ThreadProposal) => boolean, limit: number): ThreadProposal[] {
    const result: ThreadProposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (predicate(proposal)) result.push(cloneProposal(proposal));
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result.slice(0, Math.max(0, limit));
  }
}

function dedupKey(userId: string, clientRequestId: string): string {
  return `${userId}::${clientRequestId}`;
}

function cloneProposal(proposal: ThreadProposal): ThreadProposal {
  return {
    ...proposal,
    preferredCats: [...proposal.preferredCats],
  };
}
