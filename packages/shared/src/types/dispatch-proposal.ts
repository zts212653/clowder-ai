/**
 * F246 Phase B: Cross-thread dispatch proposal types.
 *
 * When a cat sends a cross_post_message with effectClass='assign_work',
 * the message is held as a DispatchProposal pending operator approval in the
 * Approval Hub. Non-assign effect-classes (fyi/coordinate/investigate)
 * auto-deliver without creating a proposal.
 *
 * See: F193 E3 Effect-Class Matrix in docs/features/F246-approval-hub.md
 */

import type { ActionSuccessorRequestMetadata } from './action-successor.js';
import type { ApprovalOriginRef, ApprovalPublication } from './approval-hub.js';

export interface DispatchActionLeaseRef {
  leaseId: string;
  generation: number;
  dispatchId: string;
  terminalPredicateDigest: string;
}

/**
 * Cross-thread dispatch effect-class (F193 E3 matrix).
 *
 * - fyi: recipient reads + acknowledges ("shared changed, rebuild")
 * - coordinate: recipient adjusts own pace ("you're blocking me, ack")
 * - investigate: recipient does read-only investigation ("stray files on main")
 * - assign_work: recipient opens worktree + writes code ("fix this bug") → needs operator approval
 */
export type EffectClass = 'fyi' | 'coordinate' | 'investigate' | 'assign_work';

/**
 * DispatchProposal lifecycle status.
 *
 * - pending: awaiting operator decision
 * - approved: operator approved, message delivered (terminal)
 * - rejected: operator rejected (terminal)
 * - superseded: atomically replaced by a newer proposal with the same lineage key K
 *   (terminal — cannot approve/reject; AC-J4, INV-J5)
 */
export type DispatchProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

/**
 * A cross-thread assign_work dispatch held for operator approval.
 *
 * Created when a cat sends cross_post_message with effectClass='assign_work'.
 * The message content is held (NOT delivered to target thread) until the operator
 * approves through the Approval Hub.
 */
export interface DispatchProposal {
  /** Unique proposal identifier. */
  proposalId: string;
  /**
   * Authenticated invocation that created this proposal.
   *
   * Optional only while hydrating pre-#1291 records. Every new proposal must
   * carry this identity so a rejected assignment can remain a narrow,
   * invocation-scoped negative authorization fence.
   */
  sourceInvocationId?: string;
  /** Thread where the sender cat lives. */
  sourceThreadId: string;
  /** Target thread for message delivery (after approval). */
  targetThreadId: string;
  /** Cat that initiated the dispatch. */
  senderCatId: string;
  /** operator user ID — only this user can approve/reject. */
  ownerUserId: string;
  /** Always 'assign_work' — only this class creates proposals. */
  effectClass: 'assign_work';
  /** Held message content (immutable between creation and delivery). */
  content: string;
  /** Routing targets in the target thread. */
  targetCats: string[];
  /** Optional reply context. */
  replyTo?: string;
  /** Idempotency key from the sender. */
  clientMessageId?: string;
  /**
   * Server-validated action identity that may be promoted only by operator
   * approval. This is intentionally distinct from sender-facing `action`,
   * whose direct admission remains mutually exclusive with `assign_work`.
   */
  proposedAction?: ActionSuccessorRequestMetadata;
  /** Original canonical approval origin used for staged recovery retries. */
  approvalOriginRef?: ApprovalOriginRef;
  /** Current lifecycle status. */
  status: DispatchProposalStatus;
  /** Message ID in target thread after approval + delivery. */
  deliveredMessageId?: string;
  /** Message ID of the feedback card in sender's thread (for Hub jump-to). */
  cardMessageId?: string;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** When operator approved/rejected (epoch ms). */
  decidedAt?: number;
  /** operator userId who decided. */
  decidedBy?: string;
  /**
   * F246 Phase J (AC-J4): When superseded by a newer same-K proposal,
   * records the replacing proposal's ID. Only set when status='superseded'.
   */
  supersededBy?: string;
  /**
   * F246 Phase J (AC-J8): Digest of the ActionEnvelope that backs this proposal.
   * Absent on legacy (pre-Phase-J) proposals. When rollout state is 'required',
   * proposals without envelopeDigest cannot be approved — only rejected or
   * resubmitted through the new ingress. Task 1-2 will populate this field.
   */
  envelopeDigest?: string;
  /** Exact F167 lease generation atomically acquired with approval. */
  actionLeaseRef?: DispatchActionLeaseRef;
  /** Phase-I publication state; absent only on pre-Phase-I records. */
  publication?: ApprovalPublication;
}

/**
 * Recover a precise invocation identity from the historical event anchor when
 * it exists. Message-origin records deliberately stay unresolved: guessing
 * from actor/thread would create a permanent, overly broad denial.
 */
export function deriveDispatchProposalSourceInvocationId(input: {
  sourceInvocationId?: string;
  approvalOriginRef?: ApprovalOriginRef;
  publication?: ApprovalPublication;
}): string | undefined {
  if (input.sourceInvocationId) return input.sourceInvocationId;
  const originRef =
    input.approvalOriginRef ??
    (input.publication?.state === 'anchored' ? input.publication.envelope.originRef : undefined);
  if (originRef?.kind !== 'event') return undefined;
  const match = /^invocation:([^\s:]+)$/.exec(originRef.anchor);
  return match?.[1];
}
