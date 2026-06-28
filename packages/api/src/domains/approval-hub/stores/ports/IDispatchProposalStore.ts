/**
 * F246 Phase B: DispatchProposal store port.
 *
 * Stores assign_work cross-thread dispatch proposals pending operator approval.
 * Lifecycle: create(pending) → approve/reject(terminal).
 */

import type { DispatchProposal } from '@cat-cafe/shared';

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
  cardMessageId?: string;
  createdAt: number;
}

export interface IDispatchProposalStore {
  /** Create a pending dispatch proposal. Returns the stored proposal. */
  create(input: CreateDispatchProposalInput): Promise<DispatchProposal>;

  /** Get a proposal by ID. Returns null if not found. */
  get(proposalId: string): Promise<DispatchProposal | null>;

  /** List pending proposals for a user (for Hub aggregation). */
  listPendingByUser(userId: string): Promise<DispatchProposal[]>;

  /**
   * CAS: pending → approved. Sets decidedAt, decidedBy.
   * deliveredMessageId is recorded separately via recordDelivery() AFTER delivery.
   * Returns updated proposal, or null if not pending (INV-2).
   */
  approve(proposalId: string, userId: string): Promise<DispatchProposal | null>;

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
}

// ---------------------------------------------------------------------------
// In-memory implementation (for fast unit tests — NOT for production)
// ---------------------------------------------------------------------------

export class InMemoryDispatchProposalStore implements IDispatchProposalStore {
  private readonly proposals = new Map<string, DispatchProposal>();

  async create(input: CreateDispatchProposalInput): Promise<DispatchProposal> {
    const proposal: DispatchProposal = {
      ...input,
      effectClass: 'assign_work',
      status: 'pending',
    };
    this.proposals.set(input.proposalId, proposal);
    return { ...proposal };
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

  async approve(proposalId: string, userId: string): Promise<DispatchProposal | null> {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== 'pending') return null;
    p.status = 'approved';
    p.decidedAt = Date.now();
    p.decidedBy = userId;
    return { ...p };
  }

  async recordDelivery(proposalId: string, deliveredMessageId: string): Promise<void> {
    const p = this.proposals.get(proposalId);
    if (p) p.deliveredMessageId = deliveredMessageId;
  }

  async revertToPending(proposalId: string): Promise<DispatchProposal | null> {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== 'approved') return null;
    p.status = 'pending';
    p.decidedAt = undefined;
    p.decidedBy = undefined;
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
}
