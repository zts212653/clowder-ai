import type { PreviewVisiblePageAdmission, PreviewVisiblePageAttestation } from '@cat-cafe/shared';

/** Preview commands apply to the current visible thread and return the backend's delivery receipt. */

export interface PreviewAutoOpenEvent {
  port: number;
  path?: string;
  worktreeId?: string;
  threadId?: string;
  eventId?: string;
  targetOrigin?: string;
  visiblePageAdmission?: PreviewVisiblePageAdmission;
}

export type PreviewAutoOpenReceiptReason =
  | 'thread_inactive'
  | 'presentation_lock'
  | 'worktree_mismatch'
  | 'client_inactive'
  | 'visible_page_timeout'
  | 'visible_page_superseded'
  | 'visible_page_unavailable'
  | 'visible_page_load_error'
  | 'visible_page_contract_invalid';

export interface PreviewAutoOpenReceipt {
  status: 'applied' | 'queued' | 'blocked' | 'skipped' | 'rejected';
  eventId: string;
  reason?: PreviewAutoOpenReceiptReason;
  attestation?: PreviewVisiblePageAttestation;
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

export interface PreviewOpenCommand {
  data: PreviewAutoOpenEvent;
  ran: boolean;
}

export function deliverPreviewAutoOpenEvent(input: {
  data: PreviewAutoOpenEvent;
  activeThreadId: string | null;
  clientVisible: boolean;
  presentationLocked: boolean;
  sessionWorktreeId: string | null;
  apply: (data: PreviewAutoOpenEvent) => boolean | void;
}): PreviewAutoOpenReceipt {
  const { data } = input;
  const eventId = data.eventId ?? '';
  if (!input.clientVisible || (data.threadId && data.threadId !== input.activeThreadId))
    return { status: 'skipped', eventId, reason: 'client_inactive' };
  if (input.presentationLocked) return { status: 'blocked', eventId, reason: 'presentation_lock' };
  if (!isPreviewWorktreeScopeAcceptable(input.sessionWorktreeId, data.worktreeId))
    return { status: 'skipped', eventId, reason: 'worktree_mismatch' };
  return input.apply(data) === false
    ? { status: 'skipped', eventId, reason: 'client_inactive' }
    : { status: 'applied', eventId };
}
