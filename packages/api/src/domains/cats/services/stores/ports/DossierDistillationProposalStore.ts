/**
 * F208 Phase E — DossierDistillationProposalStore
 *
 * Stores distillation proposals that promote observations/evidence into the
 * cat-dossier.md summary layer. operator approves in Hub, then a cat applies.
 *
 * State machine (KD-18 — simpler than F231, no file write during approve):
 *   pending  → approved   (operator approves)
 *   pending  → rejected   (operator rejects)
 *   approved → applied    (cat applies draft to dossier + git commit)
 *
 * Idempotency: sourceId is unique per triggering event (e.g., "feat-phase-close:F208:D").
 * Same sourceId → getBySourceId returns existing proposal, create should be skipped.
 *
 * Safety: evidenceRefs must be non-empty at create time (fail-closed, KD-17 FM-2).
 */

import type {
  CatId,
  DistillationEvidenceRef,
  DistillationSourceEvent,
  DossierDistillationProposal,
} from '@cat-cafe/shared';
import { generateProposalId } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateDistillationProposalInput {
  sourceEvent: DistillationSourceEvent;
  sourceId: string;
  targetCatId: CatId;
  targetFields: string[];
  beforeSnapshot: string;
  afterDraft: string;
  rationale: string;
  evidenceRefs: DistillationEvidenceRef[];
  baseHash: string;
  createdBy: string;
  /** Optional explicit proposalId (for pre-reserved IDs). */
  proposalId?: string;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface IDossierDistillationProposalStore {
  /** Create a new proposal. Throws if evidenceRefs is empty (fail-closed). */
  create(input: CreateDistillationProposalInput): DossierDistillationProposal | Promise<DossierDistillationProposal>;
  /** Get a proposal by ID. */
  get(proposalId: string): DossierDistillationProposal | null | Promise<DossierDistillationProposal | null>;
  /** List all pending proposals (newest first). */
  listPending(limit?: number): DossierDistillationProposal[] | Promise<DossierDistillationProposal[]>;
  /** List proposals for a specific cat (all statuses, newest first). */
  listByCat(catId: CatId, limit?: number): DossierDistillationProposal[] | Promise<DossierDistillationProposal[]>;
  /** Idempotency: find existing proposal by sourceId. */
  getBySourceId(sourceId: string): DossierDistillationProposal | null | Promise<DossierDistillationProposal | null>;
  /** CAS pending → approved. Returns null if not pending. */
  markApproved(
    proposalId: string,
    approvedBy: string,
  ): DossierDistillationProposal | null | Promise<DossierDistillationProposal | null>;
  /** CAS pending → rejected. Returns null if not pending. */
  markRejected(
    proposalId: string,
    rejectedBy: string,
    rejectionReason?: string,
  ): DossierDistillationProposal | null | Promise<DossierDistillationProposal | null>;
  /** CAS approved → applied. Returns null if not approved. */
  markApplied(
    proposalId: string,
    appliedBy: string,
    commitSha: string,
  ): DossierDistillationProposal | null | Promise<DossierDistillationProposal | null>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + single-process dev)
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 100;

export class InMemoryDossierDistillationProposalStore implements IDossierDistillationProposalStore {
  private readonly proposals = new Map<string, DossierDistillationProposal>();
  private readonly sourceIdIndex = new Map<string, string>(); // sourceId → proposalId

  create(input: CreateDistillationProposalInput): DossierDistillationProposal {
    // KD-17 FM-2: fail-closed — no evidence = no proposal
    if (!input.evidenceRefs || input.evidenceRefs.length === 0) {
      throw new Error('evidenceRefs must be non-empty (KD-17 fail-closed)');
    }

    const now = Date.now();
    const proposal: DossierDistillationProposal = {
      proposalId: input.proposalId ?? generateProposalId(),
      status: 'pending',
      sourceEvent: input.sourceEvent,
      sourceId: input.sourceId,
      targetCatId: input.targetCatId,
      targetFields: [...input.targetFields],
      beforeSnapshot: input.beforeSnapshot,
      afterDraft: input.afterDraft,
      rationale: input.rationale,
      evidenceRefs: input.evidenceRefs.map((r) => ({ ...r })),
      baseHash: input.baseHash,
      createdBy: input.createdBy,
      createdAt: now,
    };
    this.proposals.set(proposal.proposalId, proposal);
    this.sourceIdIndex.set(input.sourceId, proposal.proposalId);
    return clone(proposal);
  }

  get(proposalId: string): DossierDistillationProposal | null {
    const found = this.proposals.get(proposalId);
    return found ? clone(found) : null;
  }

  listPending(limit: number = DEFAULT_LIMIT): DossierDistillationProposal[] {
    return this.collect((p) => p.status === 'pending', limit);
  }

  listByCat(catId: CatId, limit: number = DEFAULT_LIMIT): DossierDistillationProposal[] {
    return this.collect((p) => p.targetCatId === catId, limit);
  }

  getBySourceId(sourceId: string): DossierDistillationProposal | null {
    const proposalId = this.sourceIdIndex.get(sourceId);
    if (!proposalId) return null;
    return this.get(proposalId);
  }

  markApproved(proposalId: string, approvedBy: string): DossierDistillationProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'approved';
    proposal.approvedBy = approvedBy;
    proposal.approvedAt = Date.now();
    return clone(proposal);
  }

  markRejected(proposalId: string, rejectedBy: string, rejectionReason?: string): DossierDistillationProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    proposal.status = 'rejected';
    proposal.rejectedBy = rejectedBy;
    proposal.rejectedAt = Date.now();
    if (rejectionReason) proposal.rejectionReason = rejectionReason;
    return clone(proposal);
  }

  markApplied(proposalId: string, appliedBy: string, commitSha: string): DossierDistillationProposal | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'approved') return null;
    proposal.status = 'applied';
    proposal.appliedBy = appliedBy;
    proposal.appliedAt = Date.now();
    proposal.appliedCommitSha = commitSha;
    return clone(proposal);
  }

  // -- helpers --

  private collect(
    predicate: (p: DossierDistillationProposal) => boolean,
    limit: number,
  ): DossierDistillationProposal[] {
    const result: DossierDistillationProposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (predicate(proposal)) result.push(clone(proposal));
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result.slice(0, Math.max(0, limit));
  }
}

function clone(proposal: DossierDistillationProposal): DossierDistillationProposal {
  return {
    ...proposal,
    targetFields: [...proposal.targetFields],
    evidenceRefs: proposal.evidenceRefs.map((r) => ({ ...r })),
  };
}
