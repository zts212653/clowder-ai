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

/**
 * Cross-thread dispatch effect-class (F193 E3 matrix).
 *
 * - fyi: recipient reads + acknowledges ("shared changed, rebuild")
 * - coordinate: recipient adjusts own pace ("you're blocking me, ack")
 * - investigate: recipient does read-only investigation ("stray files on main")
 * - assign_work: recipient opens worktree + writes code ("fix this bug") → needs operator approval
 */
export type EffectClass = 'fyi' | 'coordinate' | 'investigate' | 'assign_work';

/** DispatchProposal lifecycle status. */
export type DispatchProposalStatus = 'pending' | 'approved' | 'rejected';

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
}
