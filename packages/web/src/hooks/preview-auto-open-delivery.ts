/**
 * F120 × F284: Preview auto-open delivery decision (client side).
 *
 * Admission ≠ visible. The socket handler must answer every accepted event
 * with an explicit receipt so the API can tell the cat whether a Hub client
 * actually applied the preview:
 * - applied  — the active thread received it; panel + browser surface updated.
 * - queued   — the event targets another thread; written into that thread's
 *              ThreadState so returning to it reveals the preview.
 * - blocked  — presentation lock freezes the visible workspace.
 * - skipped  — this client is out of scope (hidden tab or worktree mismatch).
 *              Skipped answers promptly so an ineligible tab never stalls the
 *              server's ack collection, but it never wins aggregation.
 */

export interface PreviewAutoOpenEvent {
  port: number;
  path?: string;
  worktreeId?: string;
  threadId?: string;
  eventId?: string;
}

export type PreviewAutoOpenReceiptReason =
  | 'thread_inactive'
  | 'presentation_lock'
  | 'worktree_mismatch'
  | 'client_inactive';

export interface PreviewAutoOpenReceipt {
  status: 'applied' | 'queued' | 'blocked' | 'skipped';
  eventId: string;
  reason?: PreviewAutoOpenReceiptReason;
}

/**
 * Fail-closed worktree-scope filter: a session only applies events for its
 * own worktree (or global broadcasts). Exported for testing.
 */
export function isPreviewWorktreeScopeAcceptable(
  sessionWorktreeId: string | null,
  eventWorktreeId: string | undefined,
): boolean {
  if (sessionWorktreeId) {
    // Session has worktree → accept exact match OR global broadcast (no worktreeId).
    // Reject events from OTHER worktrees (defence-in-depth against cross-session leakage).
    // Global broadcasts are common: cat calls auto-open without worktreeId,
    // or session's worktreeId was set after the first auto-open call.
    return eventWorktreeId === sessionWorktreeId || !eventWorktreeId;
  }
  // Session has no worktree → only accept global events (no worktreeId)
  return !eventWorktreeId;
}

/** Legacy same-thread + worktree predicate kept as a focused compatibility
 * surface for callers/tests that only need the scope decision. */
export function shouldAcceptAutoOpen(
  sessionWorktreeId: string | null,
  eventWorktreeId: string | undefined,
  sessionThreadId: string,
  eventThreadId: string | undefined,
): boolean {
  if (eventThreadId && eventThreadId !== sessionThreadId) return false;
  return isPreviewWorktreeScopeAcceptable(sessionWorktreeId, eventWorktreeId);
}

export function deliverPreviewAutoOpenEvent(input: {
  data: PreviewAutoOpenEvent;
  activeThreadId: string | null;
  /** Only the browser tab visible to the user may apply or accept queue custody. */
  clientVisible: boolean;
  presentationLocked: boolean;
  sessionWorktreeId: string | null;
  /**
   * Resolve the canonical worktree scope of an INACTIVE target thread from its
   * own ThreadState (F063/F284: workspaceWorktreeId is per-thread). Returns
   * `undefined` when the target's scope cannot be proven (no saved state) —
   * callers must fail closed. `null` = the thread exists but has no worktree.
   */
  resolveTargetWorktreeId: (threadId: string) => string | null | undefined;
  apply: (data: PreviewAutoOpenEvent) => void;
  queueForThread: (threadId: string, preview: { port: number; path: string }) => void;
}): PreviewAutoOpenReceipt {
  const { data } = input;
  const eventId = data.eventId ?? '';

  if (!input.clientVisible) {
    return { status: 'skipped', eventId, reason: 'client_inactive' };
  }

  if (input.presentationLocked) {
    return { status: 'blocked', eventId, reason: 'presentation_lock' };
  }

  if (data.threadId && data.threadId !== input.activeThreadId) {
    // Inactive target: judge scope by the TARGET thread's canonical worktree,
    // never by the foreground thread's (review round-3 P1 — a legit event for
    // inactive thread A must not be rejected just because foreground B sits in
    // another worktree). Unprovable scope fails closed with zero writes.
    const targetWorktreeId = input.resolveTargetWorktreeId(data.threadId);
    if (targetWorktreeId === undefined || !isPreviewWorktreeScopeAcceptable(targetWorktreeId, data.worktreeId)) {
      return { status: 'skipped', eventId, reason: 'worktree_mismatch' };
    }
    input.queueForThread(data.threadId, { port: data.port, path: data.path ?? '/' });
    return { status: 'queued', eventId, reason: 'thread_inactive' };
  }

  // Active target: scope is the foreground session's worktree.
  if (!isPreviewWorktreeScopeAcceptable(input.sessionWorktreeId, data.worktreeId)) {
    return { status: 'skipped', eventId, reason: 'worktree_mismatch' };
  }

  input.apply(data);
  return { status: 'applied', eventId };
}
