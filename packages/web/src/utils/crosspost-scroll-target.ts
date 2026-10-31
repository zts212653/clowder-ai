import type { ChatMessage } from '@/stores/chat-types';

type ScrollTargetCandidate = Pick<ChatMessage, 'id' | 'catId' | 'extra'>;

/**
 * F052: resolve a cross-post source bubble's real DOM message id.
 *
 * A cross-post message in the receiving thread carries `extra.crossPost.sourceInvocationId`
 * (the invocation that issued the cross-post). To scroll the *source* thread to that cat's
 * bubble we resolve the invocation id back to a concrete `message.id` among the loaded
 * messages — never by string-constructing `msg-{inv}-{cat}`, which would couple to the
 * bubble-id format and the turnInvocationId/invocationId precedence (F194 Z3).
 *
 * Two-pass match (precise → fallback):
 *   1. per-turn `turnInvocationId` (bubble-identity SoT — exact turn). PRODUCTION PATH: verified
 *      against live runtime data (2026-06-01) — cross-post's stored `sourceInvocationId` equals
 *      the source bubble's `turnInvocationId` (callbacks.ts stamps the per-turn id, not parent),
 *      and history-loaded messages carry `extra.stream.turnInvocationId`, so this pass lands on
 *      the exact bubble the cat posted from.
 *   2. parent/chain `invocationId` (defense / legacy bubbles that lack a turn id) — falls back to
 *      that cat's first turn under the shared parent. Still far better than scrolling to bottom.
 * `senderCatId` disambiguates an A2A chain where multiple cats share one parent invocationId.
 *
 * Returns undefined when the source bubble is not in the loaded page (paged out); the caller
 * then falls back to default scroll-restore behavior.
 */
export function findCrossPostTargetMessageId(
  messages: readonly ScrollTargetCandidate[],
  sourceInvocationId: string,
  senderCatId: string | undefined,
): string | undefined {
  const matchesCat = (msg: ScrollTargetCandidate): boolean => !senderCatId || msg.catId === senderCatId;

  // Pass 1: precise — per-turn invocation id (F194 Z3 bubble identity SoT).
  for (const msg of messages) {
    if (matchesCat(msg) && msg.extra?.stream?.turnInvocationId === sourceInvocationId) {
      return msg.id;
    }
  }
  // Pass 2: fallback — parent/chain invocation id.
  for (const msg of messages) {
    if (matchesCat(msg) && msg.extra?.stream?.invocationId === sourceInvocationId) {
      return msg.id;
    }
  }
  return undefined;
}

export interface PendingCrossPostScroll {
  threadId: string;
  sourceInvocationId: string;
  senderCatId?: string;
}

// Module-level (not React state): a /thread/A → /thread/B route change remounts the chat
// page, so the pending scroll intent must survive a remount — same rationale as
// scrollPositionsByThread in useChatHistory (clowder-ai#27).
let pendingScroll: PendingCrossPostScroll | null = null;

/** Record the intent to scroll a thread to a cross-post source bubble after navigation. */
export function setPendingCrossPostScroll(target: PendingCrossPostScroll): void {
  pendingScroll = target;
}

/**
 * One-shot consume: returns and clears the pending target only when it was set for `threadId`.
 * A mismatched thread leaves the pending target intact (the user may yet navigate to it).
 */
export function consumePendingCrossPostScroll(threadId: string): PendingCrossPostScroll | null {
  if (pendingScroll && pendingScroll.threadId === threadId) {
    const target = pendingScroll;
    pendingScroll = null;
    return target;
  }
  return null;
}

/** Peek the pending target for `threadId` without consuming it. */
export function peekPendingCrossPostScroll(threadId: string): PendingCrossPostScroll | null {
  return pendingScroll && pendingScroll.threadId === threadId ? pendingScroll : null;
}

export function __resetPendingCrossPostScrollForTest(): void {
  pendingScroll = null;
}

/**
 * Resolve a pending cross-post scroll intent against the currently loaded `messages`.
 *
 * Consumption is split from peeking so a stale-cache miss doesn't throw the intent away:
 *   - hit (target found)               → consume + return its message id (don't re-scroll later)
 *   - miss + opts.authoritative=true   → consume + return null (give up: real paged-out)
 *   - miss + opts.authoritative=false  → return null but KEEP pending
 *
 * Why the authoritative split (砚砚 R1 P1): useChatHistory restores a possibly-stale IndexedDB
 * snapshot (offlineSnapshot=true) before replacing it with the fresh API page (offlineSnapshot
 * =false). A miss against the stale snapshot must not pre-consume the jump — otherwise the fresh
 * page that DOES contain the source bubble never gets a chance to scroll. Only an authoritative
 * miss (fresh page loaded, still not present) is a genuine paged-out fallback.
 */
export function resolveCrossPostScrollTarget(
  threadId: string,
  messages: readonly ScrollTargetCandidate[],
  opts: { authoritative?: boolean } = {},
): string | null {
  const pending = peekPendingCrossPostScroll(threadId);
  if (!pending) return null;
  const targetId = findCrossPostTargetMessageId(messages, pending.sourceInvocationId, pending.senderCatId);
  if (targetId) {
    consumePendingCrossPostScroll(threadId);
    return targetId;
  }
  if (opts.authoritative) {
    consumePendingCrossPostScroll(threadId);
  }
  return null;
}
