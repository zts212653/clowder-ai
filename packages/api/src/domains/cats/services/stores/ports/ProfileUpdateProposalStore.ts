/**
 * F231 Phase C ProfileUpdateProposalStore
 *
 * Cats propose a per-cat primer update; operator approves/rejects. Mirrors the
 * F128 ProposalStore state machine (review-proven edges):
 *   pending → approving → approved   (claim then finalize, atomic vs reject)
 *   pending → rejected               (one-shot)
 *   approving → pending              (rollback on write failure)
 *
 * AC-C1 additions over ThreadProposal:
 *  - P1-1 two-path crash checkpoint (recordCheckpoint persists BOTH writtenPath
 *    and provenancePath before finalize, so partial commits are recoverable).
 *  - P1-2 optimistic lock fields (baseContentHash pinned at propose; the decision
 *    route re-reads + compares under a per-target lock before writing — that lock
 *    lives in the route, not this store).
 */

import type {
  CatId,
  ProfileUpdateProposal,
  ProfileUpdateSignalProvenance,
  ProfileUpdateTargetLayer,
} from '@cat-cafe/shared';
import { generateProposalId } from '@cat-cafe/shared';

export interface CreateProfileUpdateProposalInput {
  sourceThreadId: string;
  sourceInvocationId: string;
  sourceCatId: CatId;
  targetLayer: ProfileUpdateTargetLayer;
  targetPath: string;
  beforeContent: string;
  baseContentHash: string;
  afterContent: string;
  rationale: string;
  signalProvenance: ProfileUpdateSignalProvenance;
  createdBy: string;
  /** Optional explicit proposalId (propose route reserves a dedup key before create). */
  proposalId?: string;
}

/** P1-1 partial-commit checkpoint — BOTH paths recorded before finalize. */
export interface ProfileUpdateCheckpoint {
  writtenPath?: string;
  provenancePath?: string;
}

export interface IProfileUpdateProposalStore {
  create(input: CreateProfileUpdateProposalInput): ProfileUpdateProposal | Promise<ProfileUpdateProposal>;
  get(proposalId: string): ProfileUpdateProposal | null | Promise<ProfileUpdateProposal | null>;
  listPending(userId: string, limit?: number): ProfileUpdateProposal[] | Promise<ProfileUpdateProposal[]>;
  listByThread(threadId: string, limit?: number): ProfileUpdateProposal[] | Promise<ProfileUpdateProposal[]>;
  /** CAS pending → approving. Returns claimed snapshot, or null if not pending. */
  claimForApproval(
    proposalId: string,
    approvedBy: string,
  ): ProfileUpdateProposal | null | Promise<ProfileUpdateProposal | null>;
  /**
   * Persist writtenPath/provenancePath on an `approving` proposal WITHOUT changing status
   * (P1-1 partial-commit checkpoint; deterministic paths → retry-idempotent). No-op if not approving.
   */
  recordCheckpoint(
    proposalId: string,
    checkpoint: ProfileUpdateCheckpoint,
  ): ProfileUpdateProposal | null | Promise<ProfileUpdateProposal | null>;
  /** CAS approving → approved. Returns updated proposal or null if status drifted. */
  finalizeApproval(proposalId: string): ProfileUpdateProposal | null | Promise<ProfileUpdateProposal | null>;
  /** CAS approving → pending. Used when the primer write fails after claim. */
  rollbackClaim(proposalId: string): boolean | Promise<boolean>;
  /** CAS pending → rejected. Returns null if not pending. */
  markRejected(
    proposalId: string,
    rejectedBy: string,
    rejectionReason?: string,
  ): ProfileUpdateProposal | null | Promise<ProfileUpdateProposal | null>;
  /** Idempotency: cached proposalId for (userId, clientRequestId). */
  getDedupProposalId(userId: string, clientRequestId: string): string | null | Promise<string | null>;
  /** Idempotency: atomically reserve (userId, clientRequestId) → proposalId; returns the stored value. */
  reserveDedup(userId: string, clientRequestId: string, proposalId: string): string | Promise<string>;
  /** Release the dedup reservation IF it points at expectedProposalId (defensive). */
  releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): void | Promise<void>;
  setCardMessageId(proposalId: string, cardMessageId: string): void | Promise<void>;
  /** Hard delete (cleanup after propose partial-commit). Idempotent. */
  delete(proposalId: string): void | Promise<void>;
}

const DEFAULT_LIST_LIMIT = 100;

/** In-memory implementation for tests and single-process dev. */
export class InMemoryProfileUpdateProposalStore implements IProfileUpdateProposalStore {
  private readonly proposals = new Map<string, ProfileUpdateProposal>();
  private readonly dedupCache = new Map<string, string>();

  create(input: CreateProfileUpdateProposalInput): ProfileUpdateProposal {
    const now = Date.now();
    const proposal: ProfileUpdateProposal = {
      proposalId: input.proposalId ?? generateProposalId(),
      status: 'pending',
      sourceThreadId: input.sourceThreadId,
      sourceInvocationId: input.sourceInvocationId,
      sourceCatId: input.sourceCatId,
      targetLayer: input.targetLayer,
      targetPath: input.targetPath,
      beforeContent: input.beforeContent,
      baseContentHash: input.baseContentHash,
      afterContent: input.afterContent,
      rationale: input.rationale,
      signalProvenance: { ...input.signalProvenance },
      createdBy: input.createdBy,
      createdAt: now,
    };
    this.proposals.set(proposal.proposalId, proposal);
    return clone(proposal);
  }

  get(proposalId: string): ProfileUpdateProposal | null {
    const found = this.proposals.get(proposalId);
    return found ? clone(found) : null;
  }

  listPending(userId: string, limit: number = DEFAULT_LIST_LIMIT): ProfileUpdateProposal[] {
    return this.collect((p) => p.createdBy === userId && p.status === 'pending', limit);
  }

  listByThread(threadId: string, limit: number = DEFAULT_LIST_LIMIT): ProfileUpdateProposal[] {
    return this.collect((p) => p.sourceThreadId === threadId, limit);
  }

  claimForApproval(proposalId: string, approvedBy: string): ProfileUpdateProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'approving';
    proposal.approvedBy = approvedBy;
    proposal.claimedAt = Date.now();
    return clone(proposal);
  }

  recordCheckpoint(proposalId: string, checkpoint: ProfileUpdateCheckpoint): ProfileUpdateProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return null;
    if (checkpoint.writtenPath !== undefined) proposal.writtenPath = checkpoint.writtenPath;
    if (checkpoint.provenancePath !== undefined) proposal.provenancePath = checkpoint.provenancePath;
    return clone(proposal);
  }

  finalizeApproval(proposalId: string): ProfileUpdateProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return null;
    proposal.status = 'approved';
    proposal.approvedAt = Date.now();
    delete proposal.claimedAt;
    return clone(proposal);
  }

  rollbackClaim(proposalId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return false;
    proposal.status = 'pending';
    delete proposal.approvedBy;
    delete proposal.claimedAt;
    return true;
  }

  markRejected(proposalId: string, rejectedBy: string, rejectionReason?: string): ProfileUpdateProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'rejected';
    proposal.rejectedBy = rejectedBy;
    proposal.rejectedAt = Date.now();
    if (rejectionReason) proposal.rejectionReason = rejectionReason;
    return clone(proposal);
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
    if (this.dedupCache.get(key) === expectedProposalId) this.dedupCache.delete(key);
  }

  setCardMessageId(proposalId: string, cardMessageId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (proposal) proposal.cardMessageId = cardMessageId;
  }

  delete(proposalId: string): void {
    this.proposals.delete(proposalId);
  }

  private collect(predicate: (p: ProfileUpdateProposal) => boolean, limit: number): ProfileUpdateProposal[] {
    const result: ProfileUpdateProposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (predicate(proposal)) result.push(clone(proposal));
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result.slice(0, Math.max(0, limit));
  }
}

function dedupKey(userId: string, clientRequestId: string): string {
  return `${userId}::${clientRequestId}`;
}

function clone(proposal: ProfileUpdateProposal): ProfileUpdateProposal {
  return { ...proposal, signalProvenance: { ...proposal.signalProvenance } };
}
