/**
 * F246 Phase B/J: DispatchProposal store port.
 *
 * Stores assign_work cross-thread dispatch proposals pending operator approval.
 * Lifecycle: create(pending) → approve/reject/superseded(terminal).
 *
 * Phase J additions (AC-J4, INV-J5):
 * - Lineage key K = (sourceThreadId, targetThreadId, senderCatId).
 * - create() atomically supersedes any existing pending proposal with the same K.
 * - superseded is a terminal status; approve/reject CAS guards already reject it.
 */

import type {
  ActionSuccessorRequestMetadata,
  ApprovalEnvelope,
  ApprovalOriginRef,
  ApprovalPublication,
  DispatchProposal,
} from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity, commitApprovalEnvelope } from '@cat-cafe/shared';
import { type OwnerAuthProvenance, requireOwnerAuthProvenance } from '../../../cats/services/owner-auth-provenance.js';
import type { ApprovalPublicationStore } from '../../ports/ApprovalPublicationStore.js';

/** Fields provided at creation time (status/decided* set by store). */
export interface CreateDispatchProposalInput {
  proposalId: string;
  sourceThreadId: string;
  targetThreadId: string;
  senderCatId: string;
  ownerUserId: string;
  content: string;
  targetCats: string[];
  replyTo?: string;
  clientMessageId?: string;
  proposedAction?: ActionSuccessorRequestMetadata;
  envelopeDigest?: string;
  approvalOriginRef?: ApprovalOriginRef;
  cardMessageId?: string;
  createdAt: number;
}

/**
 * F246 Phase J: Result of create() with superseded info.
 * `supersededProposals` lists proposals that were atomically superseded during this create.
 */
export interface CreateDispatchProposalResult {
  proposal: DispatchProposal;
  /** Proposals that were atomically moved pending→superseded by this create (AC-J4). */
  supersededProposals: DispatchProposal[];
}

/**
 * F246 Phase J: Lineage key K for dispatch proposals.
 * Two proposals share the same K when they represent the same cat
 * trying to dispatch work to the same target thread from the same source.
 * Same-K create atomically supersedes the older pending proposal (AC-J4, INV-J5).
 */
export function computeLineageKey(sourceThreadId: string, targetThreadId: string, senderCatId: string): string {
  return `${sourceThreadId}:${targetThreadId}:${senderCatId}`;
}

export interface IDispatchProposalStore extends ApprovalPublicationStore {
  /**
   * Create a pending dispatch proposal.
   * Atomically supersedes any existing pending proposal with the same lineage key K
   * = (sourceThreadId, targetThreadId, senderCatId) (AC-J4, INV-J5).
   * Returns the new proposal and list of superseded proposals.
   */
  create(input: CreateDispatchProposalInput): Promise<CreateDispatchProposalResult>;

  /** Get a proposal by ID. Returns null if not found. */
  get(proposalId: string): Promise<DispatchProposal | null>;

  /** List pending proposals for a user (for Hub aggregation). */
  listPendingByUser(userId: string): Promise<DispatchProposal[]>;

  /**
   * CAS: pending → approved. Sets decidedAt, decidedBy.
   * deliveredMessageId is recorded separately via recordDelivery() AFTER delivery.
   * Returns updated proposal, or null if not pending (INV-2).
   */
  approve(
    proposalId: string,
    userId: string,
    ownerAuthProvenance: OwnerAuthProvenance,
  ): Promise<DispatchProposal | null>;

  /** Server-private approval provenance; never projected on DispatchProposal. */
  getApprovalOwnerAuthProvenance(proposalId: string): Promise<OwnerAuthProvenance | undefined>;

  /**
   * Record the actual messageId after successful delivery.
   * Called after approve() succeeds and deliverMessage() completes.
   * Non-CAS: the proposal is already in terminal state.
   */
  recordDelivery(proposalId: string, deliveredMessageId: string): Promise<void>;

  /**
   * CAS: approved → pending. Rollback when delivery fails after CAS approve.
   * Clears decidedAt/decidedBy so the user can retry.
   * Returns updated proposal, or null if not in approved state (guard).
   * Cloud P1-2 fix: prevents stuck proposals on transient delivery failures.
   */
  revertToPending(proposalId: string): Promise<DispatchProposal | null>;

  /**
   * CAS: pending → rejected. Sets decidedAt, decidedBy.
   * Returns updated proposal, or null if not pending (INV-2).
   */
  reject(proposalId: string, userId: string): Promise<DispatchProposal | null>;

  /** Idempotency lookup: find proposal by clientMessageId + sourceThreadId. */
  findByClientMessageId(clientMessageId: string, sourceThreadId: string): Promise<DispatchProposal | null>;

  /**
   * F246 Phase F: List settled (approved|rejected) proposals for a user.
   * Returns at most `limit` items sorted by decidedAt descending (newest first).
   */
  listSettledByUser(userId: string, limit: number): Promise<DispatchProposal[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (for fast unit tests — NOT for production)
// ---------------------------------------------------------------------------

export class InMemoryDispatchProposalStore implements IDispatchProposalStore, ApprovalPublicationStore {
  private readonly proposals = new Map<string, DispatchProposal>();
  /** Lineage K → currently pending proposalId (AC-J4). */
  private readonly lineageIndex = new Map<string, string>();
  /** Staged holder → direct predecessor restored if publication aborts. */
  private readonly predecessorCustody = new Map<string, string>();
  /** Server-private approval provenance keyed by proposal id. */
  private readonly approvalOwnerAuthProvenance = new Map<string, OwnerAuthProvenance>();

  async create(input: CreateDispatchProposalInput): Promise<CreateDispatchProposalResult> {
    const now = input.createdAt;
    const proposal: DispatchProposal = {
      ...input,
      effectClass: 'assign_work',
      status: 'pending',
      publication: { state: 'staged', stagedAt: now },
    };

    // AC-J4: atomically supersede any existing pending proposal with the same K
    const K = computeLineageKey(input.sourceThreadId, input.targetThreadId, input.senderCatId);
    const supersededProposals: DispatchProposal[] = [];

    const existingId = this.lineageIndex.get(K);
    if (existingId) {
      const existing = this.proposals.get(existingId);
      if (existing && existing.status === 'pending') {
        if (existing.publication?.state === 'staged') {
          return { proposal: { ...existing }, supersededProposals: [] };
        }
        existing.status = 'superseded';
        existing.supersededBy = input.proposalId;
        supersededProposals.push({ ...existing });
      }
    }

    this.proposals.set(input.proposalId, proposal);
    this.approvalOwnerAuthProvenance.delete(input.proposalId);
    this.lineageIndex.set(K, input.proposalId);
    const directPredecessor = supersededProposals.at(-1);
    if (directPredecessor) {
      this.predecessorCustody.set(input.proposalId, directPredecessor.proposalId);
    }

    return { proposal: { ...proposal }, supersededProposals };
  }

  async get(proposalId: string): Promise<DispatchProposal | null> {
    const p = this.proposals.get(proposalId);
    return p ? { ...p } : null;
  }

  async listPendingByUser(userId: string): Promise<DispatchProposal[]> {
    return [...this.proposals.values()]
      .filter((p) => p.ownerUserId === userId && p.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async approve(
    proposalId: string,
    userId: string,
    ownerAuthProvenance: OwnerAuthProvenance = 'unknown',
  ): Promise<DispatchProposal | null> {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== 'pending') return null;
    const provenance = requireOwnerAuthProvenance(ownerAuthProvenance);
    p.status = 'approved';
    p.decidedAt = Date.now();
    p.decidedBy = userId;
    this.approvalOwnerAuthProvenance.set(proposalId, provenance);
    return { ...p };
  }

  async getApprovalOwnerAuthProvenance(proposalId: string): Promise<OwnerAuthProvenance | undefined> {
    return this.approvalOwnerAuthProvenance.get(proposalId);
  }

  async recordDelivery(proposalId: string, deliveredMessageId: string): Promise<void> {
    const p = this.proposals.get(proposalId);
    if (p) p.deliveredMessageId = deliveredMessageId;
  }

  async revertToPending(proposalId: string): Promise<DispatchProposal | null> {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== 'approved') return null;

    // Phase J (INV-J5): check if a successor exists for the same K.
    // If a newer pending proposal holds the lineage, revert would create
    // dual pending — mark as superseded instead.
    const K = computeLineageKey(p.sourceThreadId, p.targetThreadId, p.senderCatId);
    const currentHolder = this.lineageIndex.get(K);
    this.approvalOwnerAuthProvenance.delete(proposalId);
    if (currentHolder && currentHolder !== proposalId) {
      p.status = 'superseded';
      p.supersededBy = currentHolder;
      p.decidedAt = undefined;
      p.decidedBy = undefined;
      return null; // revert failed — proposal was superseded
    }

    p.status = 'pending';
    p.decidedAt = undefined;
    p.decidedBy = undefined;
    this.lineageIndex.set(K, proposalId);
    return { ...p };
  }

  async reject(proposalId: string, userId: string): Promise<DispatchProposal | null> {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== 'pending') return null;
    p.status = 'rejected';
    p.decidedAt = Date.now();
    p.decidedBy = userId;
    return { ...p };
  }

  async findByClientMessageId(clientMessageId: string, sourceThreadId: string): Promise<DispatchProposal | null> {
    for (const p of this.proposals.values()) {
      if (p.clientMessageId === clientMessageId && p.sourceThreadId === sourceThreadId) {
        return { ...p };
      }
    }
    return null;
  }

  async listSettledByUser(userId: string, limit: number): Promise<DispatchProposal[]> {
    return [...this.proposals.values()]
      .filter((p) => p.ownerUserId === userId && (p.status === 'approved' || p.status === 'rejected'))
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
      .slice(0, limit)
      .map((p) => ({ ...p }));
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
      sourceFeatureId: 'F193',
      ownerUserId: p.ownerUserId,
      requesterCatId: p.senderCatId,
      createdAt: p.createdAt,
    });
    p.publication = commitApprovalEnvelope(p.publication, envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const p = this.proposals.get(proposalId);
    if (!p || p.publication?.state !== 'staged') return;

    const K = computeLineageKey(p.sourceThreadId, p.targetThreadId, p.senderCatId);
    const holderId = this.lineageIndex.get(K);
    if (holderId && holderId !== proposalId) return;
    const predecessorId = this.predecessorCustody.get(proposalId);

    this.proposals.delete(proposalId);
    this.approvalOwnerAuthProvenance.delete(proposalId);
    this.predecessorCustody.delete(proposalId);
    this.lineageIndex.delete(K);
    if (!predecessorId) return;
    const predecessor = this.proposals.get(predecessorId);
    if (predecessor?.status !== 'superseded' || predecessor.supersededBy !== proposalId) return;
    predecessor.status = 'pending';
    predecessor.supersededBy = undefined;
    this.lineageIndex.set(K, predecessorId);
  }
}
