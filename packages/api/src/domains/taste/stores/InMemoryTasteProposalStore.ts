/**
 * F221 Phase B — In-memory TasteProposalStore for tests and single-process dev.
 *
 * State machine:
 *   pending → approving → approved   (claim then finalize)
 *   pending → rejected               (one-shot)
 *   approving → pending              (rollback on writer failure)
 *   approving → approved             (fresh-session resume after durable checkpoint)
 */

import type { ApprovalEnvelope, ApprovalPublication, TasteProposal } from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity, commitApprovalEnvelope, generateProposalId } from '@cat-cafe/shared';
import type { ApprovalPublicationStore } from '../../approval-hub/ports/ApprovalPublicationStore.js';
import type {
  CreateTasteProposalInput,
  ITasteProposalStore,
  TasteWriteCheckpoint,
} from './ports/TasteProposalStore.js';

const DEFAULT_LIST_LIMIT = 100;

export class InMemoryTasteProposalStore implements ITasteProposalStore, ApprovalPublicationStore {
  private readonly proposals = new Map<string, TasteProposal>();
  private readonly dedupCache = new Map<string, string>();
  /** Monotonic counter for stable sort when timestamps tie (same-ms creation). */
  private insertionOrder = new Map<string, number>();
  private nextOrder = 0;

  create(input: CreateTasteProposalInput): TasteProposal {
    const now = Date.now();
    const proposal: TasteProposal = {
      id: input.proposalId ?? generateProposalId(),
      userId: input.userId,
      catId: input.catId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      scene: input.scene,
      quote: input.quote,
      tags: [...input.tags],
      dimension: input.dimension,
      privacy: input.privacy,
      status: 'pending',
      createdAt: now,
      clientRequestId: input.clientRequestId,
      approvalOriginRef: input.approvalOriginRef,
      publication: { state: 'staged', stagedAt: now },
    };
    this.proposals.set(proposal.id, proposal);
    this.insertionOrder.set(proposal.id, this.nextOrder++);
    return clone(proposal);
  }

  get(id: string): TasteProposal | null {
    const found = this.proposals.get(id);
    return found ? clone(found) : null;
  }

  listPending(userId: string, limit: number = DEFAULT_LIST_LIMIT): TasteProposal[] {
    return this.collect(
      (p) => p.userId === userId && p.status === 'pending',
      limit,
      (a, b) => b.createdAt - a.createdAt || this.orderOf(b) - this.orderOf(a),
    );
  }

  listActionable(userId: string, limit: number = DEFAULT_LIST_LIMIT): TasteProposal[] {
    return this.collect(
      (p) => p.userId === userId && (p.status === 'pending' || p.status === 'approving'),
      limit,
      (a, b) => b.createdAt - a.createdAt || this.orderOf(b) - this.orderOf(a),
    );
  }

  listSettledByUser(userId: string, limit: number = DEFAULT_LIST_LIMIT): TasteProposal[] {
    return this.collect(
      (p) => p.userId === userId && (p.status === 'approved' || p.status === 'rejected'),
      limit,
      (a, b) =>
        (b.approvedAt ?? b.rejectedAt ?? 0) - (a.approvedAt ?? a.rejectedAt ?? 0) || this.orderOf(b) - this.orderOf(a),
    );
  }

  private orderOf(p: TasteProposal): number {
    return this.insertionOrder.get(p.id) ?? 0;
  }

  claimForApproval(id: string, approvedBy: string): TasteProposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'approving';
    proposal.approvedBy = approvedBy;
    return clone(proposal);
  }

  recordWriteCheckpoint(id: string, checkpoint: TasteWriteCheckpoint): TasteProposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'approving') return null;
    proposal.vignetteSlug = checkpoint.vignetteSlug;
    proposal.vignettePath = checkpoint.vignettePath;
    return clone(proposal);
  }

  finalizeApproval(id: string, approvedBy: string, slug: string, path: string): TasteProposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'approving') return null;
    proposal.status = 'approved';
    proposal.approvedAt = Date.now();
    proposal.approvedBy = approvedBy;
    proposal.vignetteSlug = slug;
    proposal.vignettePath = path;
    return clone(proposal);
  }

  rollbackClaim(id: string): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'approving') return false;
    proposal.status = 'pending';
    delete proposal.approvedBy;
    delete proposal.vignetteSlug;
    delete proposal.vignettePath;
    return true;
  }

  markRejected(id: string, reason: string, rejectedBy: string): TasteProposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'rejected';
    proposal.rejectedBy = rejectedBy;
    proposal.rejectedAt = Date.now();
    proposal.rejectionReason = reason;
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
    if (this.dedupCache.get(key) === expectedProposalId && !this.proposals.has(expectedProposalId)) {
      this.dedupCache.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // ApprovalPublicationStore (Phase-I publication envelope)
  // ---------------------------------------------------------------------------

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return this.proposals.get(proposalId)?.publication ?? null;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const p = this.proposals.get(proposalId);
    if (!p) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: p.id,
      sourceFeatureId: 'F221',
      ownerUserId: p.userId,
      requesterCatId: p.catId,
      createdAt: p.createdAt,
    });
    p.publication = commitApprovalEnvelope(p.publication, envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const p = this.proposals.get(proposalId);
    if (!p || p.publication?.state !== 'staged') return;
    this.proposals.delete(proposalId);
    if (p.clientRequestId) {
      this.releaseDedup(p.userId, p.clientRequestId, p.id);
    }
  }

  private collect(
    predicate: (p: TasteProposal) => boolean,
    limit: number,
    sort: (a: TasteProposal, b: TasteProposal) => number,
  ): TasteProposal[] {
    const result: TasteProposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (predicate(proposal)) result.push(clone(proposal));
    }
    result.sort(sort);
    return result.slice(0, Math.max(0, limit));
  }
}

function dedupKey(userId: string, clientRequestId: string): string {
  return `${userId}::${clientRequestId}`;
}

function clone(proposal: TasteProposal): TasteProposal {
  return {
    ...proposal,
    tags: [...proposal.tags],
    ...(proposal.approvalOriginRef ? { approvalOriginRef: { ...proposal.approvalOriginRef } } : {}),
  };
}
