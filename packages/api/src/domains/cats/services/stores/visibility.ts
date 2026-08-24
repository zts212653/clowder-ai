/**
 * Message Visibility — F35 Whisper + System-user exemption
 * Pure functions for determining whether a message is visible to a given viewer.
 */

import { type CatId, isSelectableManagedHoldConnectorSource } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage, ThreadMessageReadOptions } from './ports/MessageStore.js';

/**
 * System-level userIds whose messages are visible to ALL thread participants
 * regardless of the per-user filter (scheduler, system, etc.).
 */
export const SYSTEM_USER_IDS: ReadonlySet<string> = new Set(['scheduler', 'system']);

/**
 * Returns true if a message was authored by a trusted system-level source.
 *
 * Historical writes use `catId: 'system'`; newer display-only badges (for example
 * persisted ACP errors) use `catId: null`. Both must bypass per-user filtering.
 */
export function isSystemUserMessage(msg: Pick<StoredMessage, 'userId' | 'catId'>): boolean {
  return SYSTEM_USER_IDS.has(msg.userId) && (msg.catId === 'system' || msg.catId === null);
}

/**
 * Cat-visible publication is independent from execution custody: cat-authored
 * speech is published as soon as it is persisted. Queued user/system/briefing
 * work remains private until delivery.
 */
export function isTimelinePublished(msg: StoredMessage): boolean {
  if (!msg.deliveryStatus || msg.deliveryStatus === 'delivered') return true;
  return msg.deliveryStatus === 'queued' && isRealCatSpeech(msg);
}

/**
 * A scheduler-authored managed-hold row is user-visible only when its durable
 * Queue custody binds the exact viewer. Scheduler authorship is provenance,
 * never access authority. Legacy ownerless records and hidden trigger rows
 * fail closed.
 */
type ManagedHoldConnectorVisibilityMessage = Pick<
  StoredMessage,
  'userId' | 'catId' | 'threadId' | 'source' | 'extra' | 'queueCustody'
>;

/** Classify the protected scheduler namespace before evaluating publication authority. */
export function isManagedHoldConnectorMessage(msg: ManagedHoldConnectorVisibilityMessage): boolean {
  return msg.userId === 'scheduler' && msg.catId === null && msg.source?.connector === 'hold-ball';
}

export function isOwnerVisibleManagedHoldConnector(
  msg: ManagedHoldConnectorVisibilityMessage,
  viewerUserId?: string,
): boolean {
  return (
    typeof viewerUserId === 'string' &&
    viewerUserId.length > 0 &&
    isManagedHoldConnectorMessage(msg) &&
    msg.extra?.scheduler?.hiddenTrigger !== true &&
    msg.queueCustody?.ownerUserId === viewerUserId &&
    isSelectableManagedHoldConnectorSource(msg.source) &&
    msg.source?.meta?.threadId === msg.threadId
  );
}

/**
 * Protect every viewer-bound read before generic scheduler/system exemptions.
 * Internal reads without a human viewer keep their existing execution-history semantics.
 */
export function passesManagedHoldViewerBoundary(
  msg: ManagedHoldConnectorVisibilityMessage,
  viewerUserId?: string,
): boolean {
  return (
    viewerUserId === undefined ||
    !isManagedHoldConnectorMessage(msg) ||
    isOwnerVisibleManagedHoldConnector(msg, viewerUserId)
  );
}

/** Queued browser-publication subset of the owner-bound managed-hold contract. */
export function isOwnerVisibleQueuedManagedHoldConnector(msg: StoredMessage, viewerUserId?: string): boolean {
  return msg.deliveryStatus === 'queued' && isOwnerVisibleManagedHoldConnector(msg, viewerUserId);
}

/**
 * Owner read cursors are durable evidence, not a mirror of what the mutable
 * timeline can currently paint. Stream speech is intentionally published
 * while it grows, but only its queued -> delivered transition proves that the
 * owner had a final result available to read. Complete callback speech keeps
 * the existing queued-publication contract.
 */
export function isDurableOwnerReadEvidence(msg: StoredMessage): boolean {
  return isTimelinePublished(msg) && !(msg.deliveryStatus === 'queued' && msg.origin === 'stream');
}

/**
 * A queued user body that was already exposed to one exact child is durable
 * cognition for that target cat. The append-only exposure witness survives
 * child/session replacement, while other cats remain unable to read the body.
 */
export function hasDurableQueueBodyExposure(msg: StoredMessage, catId: CatId): boolean {
  return (
    msg.deliveryStatus === 'queued' &&
    msg.catId === null &&
    (msg.queueCustody?.bodyExposures ?? []).some((exposure) => exposure.targetCatId === catId)
  );
}

/** Published history plus target-scoped queued bodies the cat has already read. */
export function isDurablyReadableByCat(msg: StoredMessage, catId: CatId): boolean {
  return isTimelinePublished(msg) || hasDurableQueueBodyExposure(msg, catId);
}

/** Resolve the publication predicate for a thread read in one place. */
export function resolveThreadMessageVisibility(
  options?: ThreadMessageReadOptions,
  viewerUserId?: string,
): (message: StoredMessage) => boolean {
  return (message) => {
    if (!passesManagedHoldViewerBoundary(message, viewerUserId)) return false;
    if (viewerUserId !== undefined && isManagedHoldConnectorMessage(message)) {
      return (
        isDeliveredMessage(message) ||
        (options?.includeQueuedUserMessages === true && message.deliveryStatus === 'queued')
      );
    }

    return (
      isDeliveredMessage(message) ||
      (options?.includeQueuedCatMessages === true && isQueuedCatTimelineMessage(message)) ||
      (options?.includeQueuedUserMessages === true && isQueuedUserTimelineMessage(message)) ||
      (options?.includeExposedQueuedUserMessagesForCatId !== undefined &&
        hasDurableQueueBodyExposure(message, options.includeExposedQueuedUserMessagesForCatId)) ||
      (options?.includeRecalledUserMessages === true && isOwnerVisibleRecalledUserMessage(message))
    );
  };
}

/**
 * Delivery time and publication order are distinct for real-cat speech: it is
 * published when authored, even if recipient execution custody ends later.
 */
export function resolveDeliveryTimelineScore(message: StoredMessage, deliveredAt: number): number {
  return isTimelinePublished(message) || isQueuedUserTimelineMessage(message) ? message.timestamp : deliveredAt;
}

/** Match the Redis timeline score when constructing pagination cursors in memory. */
export function getTimelineOrderTime(message: StoredMessage): number {
  if (message.timelineOrderAt !== undefined) return message.timelineOrderAt;
  if (isQueuedCatTimelineMessage(message) || isQueuedUserTimelineMessage(message)) return message.timestamp;
  return message.deliveredAt ?? message.timestamp;
}

function isDeliveredMessage(message: StoredMessage): boolean {
  return !message.deliveryStatus || message.deliveryStatus === 'delivered';
}

function isRealCatSpeech(message: StoredMessage): boolean {
  return (
    message.catId !== null &&
    message.catId !== 'system' &&
    message.userId !== 'system' &&
    message.userId !== 'scheduler' &&
    message.origin !== 'briefing'
  );
}

function isQueuedCatTimelineMessage(message: StoredMessage): boolean {
  return message.deliveryStatus === 'queued' && isRealCatSpeech(message);
}

/**
 * Owner-facing timeline publication for durable queued user work. This is kept
 * separate from `isTimelinePublished`: callback/context/prompt readers must not
 * learn an undelivered body merely because the browser can render its receipt.
 */
function isQueuedUserTimelineMessage(message: StoredMessage): boolean {
  if (
    message.deliveryStatus !== 'queued' ||
    message.catId !== null ||
    message.source !== undefined ||
    message.userId === 'system' ||
    message.userId === 'scheduler' ||
    message.origin === 'briefing'
  ) {
    return false;
  }
  return message.queueCustody !== undefined;
}

function isOwnerVisibleRecalledUserMessage(message: StoredMessage): boolean {
  return (
    message.deliveryStatus === 'canceled' &&
    message.catId === null &&
    message._tombstone === true &&
    message.recall?.exposure === 'seen'
  );
}

/** Who is viewing */
export type Viewer = { readonly type: 'user' } | { readonly type: 'cat'; readonly catId: CatId };

/**
 * Check if a message is visible to the given viewer.
 *
 * Rules:
 * - User (co-creator) always sees everything
 * - Public messages (visibility undefined or 'public') are visible to all
 * - Revealed whispers (revealedAt set) are visible to all
 * - Unrevealed whispers are only visible to recipients listed in whisperTo
 */
export function canViewMessage(msg: StoredMessage, viewer: Viewer): boolean {
  if (viewer.type === 'user') return true;

  if (!msg.visibility || msg.visibility === 'public') return true;

  if (msg.visibility === 'whisper') {
    if (msg.revealedAt) return true;
    return msg.whisperTo?.includes(viewer.catId) ?? false;
  }

  return false;
}

/**
 * #699: Unified parent eligibility for reply-to inline preview.
 *
 * A fetched parent message is eligible for inline preview only if it passes
 * the SAME predicates used to build prompt context. This prevents leaking
 * system/undelivered/deleted/whisper content via formatMessage preview.
 *
 * Used by: route-helpers cursor-gap fetch, callbacks replyTo validation.
 */
export interface ReplyParentEligibilityOptions {
  /** Thread the child belongs to — parent must be same thread */
  threadId: string;
  /** Viewer context for whisper visibility */
  viewer: Viewer;
  /** The catId of the child message sender — NOT filtered out (own messages are valid parents) */
  childCatId?: CatId | null;
}

/**
 * #699: Can a parent message be safely quoted in a public (non-whisper) reply?
 * Unrevealed whispers must not be quoted in public replies — hydrateReplyPreview
 * fetches raw content without visibility checks, so the preview would leak
 * whisper content to non-recipients.
 *
 * Use AFTER isEligibleReplyParent passes (sender CAN see the parent),
 * when the reply itself is public (e.g. callback posts which have no visibility field).
 */
export function canQuoteInPublicReply(parent: StoredMessage): boolean {
  if (parent.visibility === 'whisper' && !parent.revealedAt) return false;
  return true;
}

/**
 * #699 P1 (gpt52 intake review, cat-cafe#2111): system / briefing messages are
 * internal, non-routable content that must never be quoted as a reply parent or
 * returned via get-message. Single source of truth shared by isEligibleReplyParent,
 * POST /api/messages replyTo validation, and the get-message route — so no path can
 * forget the exclusion (the "fetch + gate" invariant in this file's header).
 */
export function isInternalNonQuotableParent(msg: Pick<StoredMessage, 'userId' | 'origin'>): boolean {
  return msg.userId === 'system' || msg.origin === 'briefing';
}

export function isEligibleReplyParent(parent: StoredMessage, opts: ReplyParentEligibilityOptions): boolean {
  // Must be same thread
  if (parent.threadId !== opts.threadId) return false;
  // Must already be cat-visible published speech; queued user work is browser-only.
  if (!isTimelinePublished(parent)) return false;
  // Must not be deleted
  if (parent.deletedAt) return false;
  // System-generated / briefing messages are internal, non-routable — never valid parents
  // (shared with POST /api/messages replyTo + get-message via isInternalNonQuotableParent)
  if (isInternalNonQuotableParent(parent)) return false;
  // Whisper visibility
  if (!canViewMessage(parent, opts.viewer)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Atomic resolvers — bind "fetch + visibility gate" so callers can't forget.
// All "fetch parent by ID for inline preview" paths must go through these,
// never raw store.getById() + manual predicate.
// ---------------------------------------------------------------------------

export interface ResolveReplyParentOptions extends ReplyParentEligibilityOptions {
  /**
   * When true, additionally block quoting unrevealed whispers in public replies
   * (callback/A2A paths which have no visibility field on the outgoing message).
   */
  publicReply?: boolean;
}

/**
 * Atomically fetch + validate a reply parent for inline preview.
 * Returns the parent message if it passes all eligibility predicates,
 * or null if not found / not eligible / whisper-unsafe for public reply.
 *
 * This is the ONLY sanctioned way to resolve a parent by ID for preview —
 * raw `store.getById()` followed by manual isEligibleReplyParent is forbidden
 * in preview paths (enforced by lint at intake).
 */
export async function resolveVisibleReplyParent(
  store: Pick<IMessageStore, 'getById'>,
  id: string,
  opts: ResolveReplyParentOptions,
): Promise<StoredMessage | null> {
  const msg = await store.getById(id);
  if (!msg || !isEligibleReplyParent(msg, opts)) return null;
  if (opts.publicReply && !canQuoteInPublicReply(msg)) return null;
  return msg;
}
