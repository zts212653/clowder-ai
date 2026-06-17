/**
 * Message Visibility — F35 Whisper + System-user exemption
 * Pure functions for determining whether a message is visible to a given viewer.
 */

import type { CatId } from '@cat-cafe/shared';
import { type IMessageStore, isDelivered, type StoredMessage } from './ports/MessageStore.js';

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
 * system/undelivered/deleted/whisper/stream content via formatMessage preview.
 *
 * Used by: route-helpers cursor-gap fetch, callbacks replyTo validation.
 */
export interface ReplyParentEligibilityOptions {
  /** Thread the child belongs to — parent must be same thread */
  threadId: string;
  /** Viewer context for whisper visibility */
  viewer: Viewer;
  /** When true, other-cat stream messages are hidden (play mode default) */
  hideOtherCatStreams?: boolean;
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
  // Must be delivered (not queued/canceled)
  if (!isDelivered(parent)) return false;
  // Must not be deleted
  if (parent.deletedAt) return false;
  // System-generated / briefing messages are internal, non-routable — never valid parents
  // (shared with POST /api/messages replyTo + get-message via isInternalNonQuotableParent)
  if (isInternalNonQuotableParent(parent)) return false;
  // Whisper visibility
  if (!canViewMessage(parent, opts.viewer)) return false;
  // Play-mode: hide other cats' stream (thinking) messages
  if (opts.hideOtherCatStreams && parent.catId !== null && parent.origin === 'stream') return false;
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
