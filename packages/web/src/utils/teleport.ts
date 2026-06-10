/**
 * F227 PR-1 Task 4 — generic teleport to a (threadId, messageId).
 *
 * Unlike cross-post (which resolves invocationId → messageId), teleport takes a
 * REAL messageId directly — Event Memory stores the exact message coordinate, so
 * there is no invocationId lookup. It reuses the cross-post pending/authoritative
 * substrate so a cross-thread jump survives the route remount + the
 * stale-IDB-then-fresh-API-page load sequence (砚砚 R1 P1 rationale).
 *
 * Pure module: callers do the actual DOM scroll via scrollToMessage(). The thread
 * page calls resolvePendingTeleport() with its loaded message ids after render.
 */

export interface PendingTeleport {
  threadId: string;
  messageId: string;
}

// Module-level (not React state): a /thread/A → /thread/B route change remounts
// the chat page, so the pending teleport intent must survive a remount — same
// rationale as crosspost-scroll-target's pendingScroll.
let pendingTeleport: PendingTeleport | null = null;

/** Record the intent to scroll a thread to a message after navigation. */
export function setPendingTeleport(target: PendingTeleport): void {
  pendingTeleport = target;
}

/** Peek the pending teleport for `threadId` without consuming it. */
export function peekPendingTeleport(threadId: string): PendingTeleport | null {
  return pendingTeleport && pendingTeleport.threadId === threadId ? pendingTeleport : null;
}

/**
 * One-shot consume: returns and clears the pending target only when it was set
 * for `threadId`. A mismatched thread leaves the pending target intact.
 */
export function consumePendingTeleport(threadId: string): PendingTeleport | null {
  if (pendingTeleport?.threadId === threadId) {
    const target = pendingTeleport;
    pendingTeleport = null;
    return target;
  }
  return null;
}

export function __resetPendingTeleportForTest(): void {
  pendingTeleport = null;
}

export interface TeleportPlan {
  /** Same thread: scroll the current view to this message id now. */
  scrollNow: string | null;
  /** Different thread: navigate here first; a pending teleport was recorded. */
  navigateTo: string | null;
}

/**
 * Plan a teleport. Same thread → scroll now + record pending (so an out-of-window
 * target still auto-loads via the resolver, P1 砚砚 R1). Different thread (or cold load
 * with no current thread) → record pending + signal navigation; the thread page
 * resolves the pending teleport after it renders.
 */
export function planTeleport(params: {
  threadId: string;
  messageId: string;
  currentThreadId: string | null;
}): TeleportPlan {
  const { threadId, messageId, currentThreadId } = params;
  if (currentThreadId === threadId) {
    // P1 (砚砚 R1): record pending even on the same thread so useChatHistory's
    // older-page resolver can reach a target OUTSIDE the loaded window. scrollNow
    // still handles the common in-window case immediately.
    setPendingTeleport({ threadId, messageId });
    return { scrollNow: messageId, navigateTo: null };
  }
  setPendingTeleport({ threadId, messageId });
  return { scrollNow: null, navigateTo: threadId };
}

/**
 * Resolve a pending teleport against the thread's currently loaded message ids.
 * Mirrors resolveCrossPostScrollTarget's authoritative split:
 *   - hit (id present)               → consume + return id (scroll it, don't re-scroll later)
 *   - miss + authoritative=true      → consume + return null (real paged-out, no infinite retry)
 *   - miss + authoritative=false     → return null but KEEP pending (stale IDB; fresh page may hit)
 */
export function resolvePendingTeleport(
  threadId: string,
  messageIds: readonly string[],
  opts: { authoritative?: boolean } = {},
): string | null {
  const pending = peekPendingTeleport(threadId);
  if (!pending) return null;
  if (messageIds.includes(pending.messageId)) {
    consumePendingTeleport(threadId);
    return pending.messageId;
  }
  if (opts.authoritative) {
    consumePendingTeleport(threadId);
  }
  return null;
}

/**
 * F227 PR-2 P1-1 (砚砚): a full-corpus Event Memory teleport can target a message
 * OLDER than the loaded chat window (history loads 50 at a time). When the target
 * isn't loaded yet but older history remains, the thread should auto-load older
 * pages until it appears — instead of silently switching thread without scrolling.
 *
 * Pure decision (unit-testable); the useChatHistory effect drives the actual fetch.
 *   - found            → no (the resolve path scrolls + consumes)
 *   - no pending       → no
 *   - stale snapshot   → no (wait for the authoritative fresh page first)
 *   - a fetch in flight→ no (don't stack concurrent loads)
 *   - no older history → no (real paged-out / deleted → the resolve path gives up)
 *   - else             → yes (load the next older page, keep the pending teleport)
 */
export function shouldLoadOlderForTeleport(params: {
  hasPending: boolean;
  found: boolean;
  isStale: boolean;
  hasMore: boolean;
  isLoading: boolean;
}): boolean {
  const { hasPending, found, isStale, hasMore, isLoading } = params;
  return hasPending && !found && !isStale && hasMore && !isLoading;
}

/**
 * F227 PR-2 P1 (砚砚 R1): same-thread teleport doesn't change the route, so the
 * messages-effect that runs the resolver never fires. This event lets the caller
 * explicitly nudge useChatHistory to (re)run the SAME older-page resolver — no
 * second paging system.
 */
export const TELEPORT_RESOLVE_EVENT = 'cafe:teleport-resolve';

/** Dispatch the resolver kick (browser-only; no-op under SSR/tests without window). */
export function kickTeleportResolve(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(TELEPORT_RESOLVE_EVENT));
  }
}
