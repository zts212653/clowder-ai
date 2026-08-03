/**
 * F260 Phase A: Entity proposal store port.
 *
 * Stores propose_entity proposals pending operator approval.
 * Lifecycle:
 *   pending → approved   (CAS claim → upsert entity → done)
 *   pending → rejected   (one-shot: audit trail only)
 *   approved → pending   (rollback: revertToPending if post-approve upsert fails)
 *
 * Iron law #5 (LL-048): proposal hashes + settled history = persistent (TTL=0).
 */

import type {
  ApprovalEnvelope,
  ApprovalOriginRef,
  ApprovalPublication,
  EntityProposal,
  EntityProposalProvenance,
  EntityStance,
  EntityVisibilityScope,
} from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity, commitApprovalEnvelope } from '@cat-cafe/shared';
import type { EntityType } from '../../../memory/interfaces.js';
import type { ApprovalPublicationStore } from '../../ports/ApprovalPublicationStore.js';

/** Fields provided at creation time (status/decided* set by store). */
export interface CreateEntityProposalInput {
  entityId: string;
  entityType: EntityType;
  canonicalName: string;
  aliases: string[];
  stance: EntityStance;
  visibilityScope: EntityVisibilityScope;
  provenance: EntityProposalProvenance[];
  rationale: string;
  sourceThreadId: string;
  sourceCatId: string;
  ownerUserId: string;
  /** Optional explicit proposalId (for dedup). */
  proposalId?: string;
  /** Transport retry identity reserved before create; persisted atomically with the proposal. */
  clientRequestId?: string;
  /** Canonical approval origin for staged recovery retries. */
  approvalOriginRef?: ApprovalOriginRef;
}

export interface IEntityProposalStore extends ApprovalPublicationStore {
  /** Create a pending entity proposal. Returns the stored proposal. */
  create(input: CreateEntityProposalInput): EntityProposal | Promise<EntityProposal>;

  /** Get a proposal by ID. Returns null if not found. */
  get(proposalId: string): EntityProposal | null | Promise<EntityProposal | null>;

  /** List pending proposals for a user (for Hub aggregation). */
  listPending(userId: string, limit?: number): EntityProposal[] | Promise<EntityProposal[]>;

  /** Idempotency: cached proposalId for (userId, clientRequestId). */
  getDedupProposalId(userId: string, clientRequestId: string): string | null | Promise<string | null>;
  /** Idempotency: atomically reserve (userId, clientRequestId) → proposalId. */
  reserveDedup(userId: string, clientRequestId: string, proposalId: string): string | Promise<string>;
  /** Release a dedup reservation (used on create/publish failure). */
  releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): void | Promise<void>;

  /** List settled (approved/rejected) proposals for history view. Newest first. */
  listSettledByUser(userId: string, limit?: number): EntityProposal[] | Promise<EntityProposal[]>;

  /** CAS pending → approved. Returns updated proposal, or null if not pending. */
  markApproved(proposalId: string, approvedBy: string): EntityProposal | null | Promise<EntityProposal | null>;

  /** CAS pending → rejected. Returns updated proposal, or null if not pending. */
  markRejected(
    proposalId: string,
    rejectedBy: string,
    rejectionReason?: string,
  ): EntityProposal | null | Promise<EntityProposal | null>;

  /**
   * Rollback: revert approved → pending (used when post-approve entity upsert fails).
   * Returns true if reverted, false if proposal not found or not in approved state.
   */
  revertToPending(proposalId: string): boolean | Promise<boolean>;
}

const DEFAULT_LIST_LIMIT = 100;

/** In-memory implementation for tests and single-process dev. */
export class InMemoryEntityProposalStore implements IEntityProposalStore, ApprovalPublicationStore {
  private readonly proposals = new Map<string, EntityProposal>();
  private readonly dedupIndex = new Map<string, string>(); // "userId:clientRequestId" → proposalId
  private nextId = 1;

  create(input: CreateEntityProposalInput): EntityProposal {
    const now = Date.now();
    const proposalId = input.proposalId ?? `ep-${this.nextId++}`;
    const proposal: EntityProposal = {
      proposalId,
      status: 'pending',
      entityId: input.entityId,
      entityType: input.entityType as EntityProposal['entityType'],
      canonicalName: input.canonicalName,
      aliases: [...input.aliases],
      stance: input.stance,
      visibilityScope: input.visibilityScope,
      provenance: input.provenance.map((p) => ({ ...p })),
      rationale: input.rationale,
      sourceThreadId: input.sourceThreadId,
      sourceCatId: input.sourceCatId,
      ownerUserId: input.ownerUserId,
      clientRequestId: input.clientRequestId,
      approvalOriginRef: input.approvalOriginRef,
      createdAt: now,
      publication: { state: 'staged', stagedAt: now },
    };
    this.proposals.set(proposalId, proposal);
    return clone(proposal);
  }

  get(proposalId: string): EntityProposal | null {
    const found = this.proposals.get(proposalId);
    return found ? clone(found) : null;
  }

  listPending(userId: string, limit: number = DEFAULT_LIST_LIMIT): EntityProposal[] {
    return this.collect((p) => p.ownerUserId === userId && p.status === 'pending', limit);
  }

  listSettledByUser(userId: string, limit: number = DEFAULT_LIST_LIMIT): EntityProposal[] {
    return this.collect(
      (p) => p.ownerUserId === userId && (p.status === 'approved' || p.status === 'rejected'),
      limit,
      (a, b) => (b.approvedAt ?? b.rejectedAt ?? 0) - (a.approvedAt ?? a.rejectedAt ?? 0),
    );
  }

  markApproved(proposalId: string, approvedBy: string): EntityProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'approved';
    proposal.approvedBy = approvedBy;
    proposal.approvedAt = Date.now();
    return clone(proposal);
  }

  markRejected(proposalId: string, rejectedBy: string, rejectionReason?: string): EntityProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'rejected';
    proposal.rejectedBy = rejectedBy;
    proposal.rejectedAt = Date.now();
    if (rejectionReason) proposal.rejectionReason = rejectionReason;
    return clone(proposal);
  }

  revertToPending(proposalId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approved') return false;
    proposal.status = 'pending';
    delete proposal.approvedBy;
    delete proposal.approvedAt;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Idempotency (R4 P1-1: explicit clientRequestId dedup)
  // ---------------------------------------------------------------------------

  getDedupProposalId(userId: string, clientRequestId: string): string | null {
    return this.dedupIndex.get(`${userId}:${clientRequestId}`) ?? null;
  }

  reserveDedup(userId: string, clientRequestId: string, proposalId: string): string {
    const key = `${userId}:${clientRequestId}`;
    const existing = this.dedupIndex.get(key);
    if (existing) return existing;
    this.dedupIndex.set(key, proposalId);
    return proposalId;
  }

  releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): void {
    const key = `${userId}:${clientRequestId}`;
    if (this.dedupIndex.get(key) === expectedProposalId && !this.proposals.has(expectedProposalId)) {
      this.dedupIndex.delete(key);
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
      canonicalProposalId: p.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: p.ownerUserId,
      requesterCatId: p.sourceCatId,
      createdAt: p.createdAt,
    });
    p.publication = commitApprovalEnvelope(p.publication, envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const p = this.proposals.get(proposalId);
    if (!p || p.publication?.state !== 'staged') return;
    this.proposals.delete(proposalId);
    if (p.clientRequestId) {
      this.releaseDedup(p.ownerUserId, p.clientRequestId, p.proposalId);
    }
  }

  private collect(
    predicate: (p: EntityProposal) => boolean,
    limit: number,
    sort: (a: EntityProposal, b: EntityProposal) => number = (a, b) => b.createdAt - a.createdAt,
  ): EntityProposal[] {
    const result: EntityProposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (predicate(proposal)) result.push(clone(proposal));
    }
    result.sort(sort);
    return result.slice(0, Math.max(0, limit));
  }
}

function clone(proposal: EntityProposal): EntityProposal {
  return {
    ...proposal,
    aliases: [...proposal.aliases],
    provenance: proposal.provenance.map((p: EntityProposalProvenance) => ({ ...p })),
    ...(proposal.approvalOriginRef ? { approvalOriginRef: { ...proposal.approvalOriginRef } } : {}),
  };
}
