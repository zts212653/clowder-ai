/**
 * F120 × F284: Preview auto-open delivery contract.
 *
 * Admission ≠ visible. POST /api/preview/auto-open previously returned
 * `allowed: true` after a fire-and-forget broadcast, so cats reported
 * "已打开" even when no Hub client applied the event. This module mirrors
 * the F131 workspace-navigation delivery pattern, with one deliberate
 * hardening (review round-2 P1): there is NO legacy fire-and-forget
 * broadcast at all — preview:global / worktree rooms are joinable by any
 * session and leaked events to non-caller observers. The event is emitted
 * exactly once, to the caller's user room (tenant scope), where every
 * client receipt is collected with ack.
 *
 * Receipt statuses:
 * - applied — the client's active thread is the event target; panel + browser
 *   surface updated.
 * - queued  — the event targets another in-scope thread of this session;
 *   written into that thread's ThreadState so returning to it reveals the
 *   preview.
 * - blocked — presentation lock freezes the visible workspace.
 * - skipped — the client is out of scope (hidden browser tab or worktree
 *   mismatch, judged by the target thread's canonical worktree). Skipped
 *   receipts answer promptly (no ack-timeout drag) but never win aggregation.
 */

export type PreviewAutoOpenDeliveryStatus = 'applied' | 'queued' | 'blocked' | 'unconfirmed';

export type PreviewAutoOpenReceiptReason =
  | 'thread_inactive'
  | 'presentation_lock'
  | 'worktree_mismatch'
  | 'client_inactive';

export type PreviewAutoOpenDeliveryReason = PreviewAutoOpenReceiptReason | 'no_client_ack' | 'no_matching_client';

interface PreviewAutoOpenReceipt {
  status: Exclude<PreviewAutoOpenDeliveryStatus, 'unconfirmed'> | 'skipped';
  eventId: string;
  reason?: PreviewAutoOpenReceiptReason;
}

export interface PreviewAutoOpenEmitter {
  socketEmit?: (event: string, data: unknown, room: string) => void;
  socketEmitWithAck?: (event: string, data: unknown, room: string) => Promise<unknown[]>;
}

const STATUS_PRIORITY: Record<Exclude<PreviewAutoOpenReceipt['status'], 'skipped'>, number> = {
  applied: 3,
  blocked: 2,
  queued: 1,
};

const REASON_PRIORITY: Record<PreviewAutoOpenReceiptReason, number> = {
  presentation_lock: 3,
  thread_inactive: 2,
  worktree_mismatch: 1,
  client_inactive: 0,
};

function isReceiptReason(value: unknown): value is PreviewAutoOpenReceiptReason {
  return typeof value === 'string' && Object.hasOwn(REASON_PRIORITY, value);
}

function isReceipt(value: unknown, eventId: string): value is PreviewAutoOpenReceipt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PreviewAutoOpenReceipt>;
  return (
    candidate.eventId === eventId &&
    (candidate.status === 'applied' ||
      candidate.status === 'queued' ||
      candidate.status === 'blocked' ||
      candidate.status === 'skipped') &&
    (candidate.reason === undefined || isReceiptReason(candidate.reason))
  );
}

export function aggregatePreviewAutoOpenReceipts(
  eventId: string,
  values: readonly unknown[],
): {
  deliveryStatus: PreviewAutoOpenDeliveryStatus;
  deliveryReason?: PreviewAutoOpenDeliveryReason;
} {
  const receipts = values.filter((value): value is PreviewAutoOpenReceipt => isReceipt(value, eventId));
  const actionable = receipts
    .filter((receipt) => receipt.status !== 'skipped')
    .sort((a, b) => {
      const statusDelta =
        STATUS_PRIORITY[b.status as keyof typeof STATUS_PRIORITY] -
        STATUS_PRIORITY[a.status as keyof typeof STATUS_PRIORITY];
      if (statusDelta !== 0) return statusDelta;
      return (
        REASON_PRIORITY[(b.reason ?? 'worktree_mismatch') as PreviewAutoOpenReceiptReason] -
        REASON_PRIORITY[(a.reason ?? 'worktree_mismatch') as PreviewAutoOpenReceiptReason]
      );
    });
  const receipt = actionable[0];
  if (!receipt) {
    // Every in-room client answered but none was in scope — distinct from a
    // missing ack (timeout / no client connected).
    if (receipts.length > 0) return { deliveryStatus: 'unconfirmed', deliveryReason: 'no_matching_client' };
    return { deliveryStatus: 'unconfirmed', deliveryReason: 'no_client_ack' };
  }
  return {
    deliveryStatus: receipt.status as PreviewAutoOpenDeliveryStatus,
    ...(receipt.reason ? { deliveryReason: receipt.reason } : {}),
  };
}

/**
 * Emit the auto-open event to the caller's user room with ack.
 *
 * F120 × F284 review round-2 P1: there is deliberately NO legacy
 * fire-and-forget broadcast to preview:global / worktree rooms — those rooms
 * are joinable by any connected session regardless of the caller principal,
 * so they leak eventId/port/path/threadId to non-caller observers. The
 * caller's user room reaches every socket of the caller's own Hub sessions
 * (auto-joined and server-enforced), including pre-ack handlers — those
 * simply never answer, which surfaces as `unconfirmed`, not as a leak.
 */
export async function emitPreviewAutoOpen(
  emitter: PreviewAutoOpenEmitter,
  eventData: { eventId: string; port: number; path?: string; threadId?: string; worktreeId?: string },
  ackRoom: string,
): Promise<ReturnType<typeof aggregatePreviewAutoOpenReceipts>> {
  if (emitter.socketEmitWithAck) {
    const receipts = await emitter.socketEmitWithAck('preview:auto-open', eventData, ackRoom).catch(() => []);
    return aggregatePreviewAutoOpenReceipts(eventData.eventId, receipts);
  }
  return { deliveryStatus: 'unconfirmed', deliveryReason: 'no_client_ack' };
}
