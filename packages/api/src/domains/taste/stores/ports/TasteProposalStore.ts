/**
 * F221 Phase B TasteProposalStore — port interface.
 *
 * Cats propose taste signal captures; operator approves/rejects in the F246 Approval Hub.
 * State machine (mirrors F231 ProfileUpdateProposalStore):
 *   pending → approving → approved   (claim then finalize)
 *   pending → rejected               (one-shot)
 *   approving → pending              (rollback on writer failure)
 *   approving → approved             (fresh-session resume after durable checkpoint)
 *
 * Lifecycle owner: this store (unique write point for TasteProposal status transitions).
 * Bypass prohibited: no generic delete/restore — proposals are immutable once settled.
 */

import type { ApprovalOriginRef, TasteDimension, TasteProposal } from '@cat-cafe/shared';
import type { ApprovalPublicationStore } from '../../../approval-hub/ports/ApprovalPublicationStore.js';

export interface CreateTasteProposalInput {
  /** Pre-generated proposal ID (for dedup coordination with route). When omitted, store generates one. */
  proposalId?: string;
  userId: string;
  catId: string;
  threadId: string;
  sourceMessageId?: string;
  scene: string;
  quote: string;
  tags: string[];
  dimension: TasteDimension;
  privacy: 'public' | 'sensitive';
  clientRequestId?: string;
  approvalOriginRef?: ApprovalOriginRef;
}

export interface TasteWriteCheckpoint {
  vignetteSlug: string;
  vignettePath: string;
}

export interface ITasteProposalStore extends ApprovalPublicationStore {
  /** Create a new pending proposal. */
  create(input: CreateTasteProposalInput): TasteProposal | Promise<TasteProposal>;
  /** Get a single proposal by ID. */
  get(id: string): TasteProposal | null | Promise<TasteProposal | null>;
  /** List pending proposals for a user, ordered by createdAt DESC. */
  listPending(userId: string, limit?: number): TasteProposal[] | Promise<TasteProposal[]>;
  /** List user-actionable proposals, including durable approving states that require resume. */
  listActionable(userId: string, limit?: number): TasteProposal[] | Promise<TasteProposal[]>;
  /** List settled (approved+rejected) proposals for a user, ordered by decidedAt DESC. */
  listSettledByUser(userId: string, limit?: number): TasteProposal[] | Promise<TasteProposal[]>;
  /** CAS pending → approving. Returns claimed snapshot, or null if not pending. */
  claimForApproval(id: string, approvedBy: string): TasteProposal | null | Promise<TasteProposal | null>;
  /** Persist durable writer output while status remains approving (crash-recovery checkpoint). */
  recordWriteCheckpoint(
    id: string,
    checkpoint: TasteWriteCheckpoint,
  ): TasteProposal | null | Promise<TasteProposal | null>;
  /** CAS approving → approved with writer output. Returns updated proposal or null. */
  finalizeApproval(
    id: string,
    approvedBy: string,
    slug: string,
    path: string,
  ): TasteProposal | null | Promise<TasteProposal | null>;
  /** CAS approving → pending. Used when vignette write fails after claim. */
  rollbackClaim(id: string): boolean | Promise<boolean>;
  /** CAS pending → rejected. Returns null if not pending. */
  markRejected(id: string, reason: string, rejectedBy: string): TasteProposal | null | Promise<TasteProposal | null>;
  /** Idempotency: cached proposalId for (userId, clientRequestId). */
  getDedupProposalId(userId: string, clientRequestId: string): string | null | Promise<string | null>;
  /** Idempotency: atomically reserve (userId, clientRequestId) → proposalId. */
  reserveDedup(userId: string, clientRequestId: string, proposalId: string): string | Promise<string>;
  /** Idempotency: release reservation if create failed (conditional on proposalId match). */
  releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): void | Promise<void>;
}
