import {
  type PreviewVisiblePageAdmission,
  type PreviewVisiblePageAttestation,
  verifyPreviewVisiblePageAttestation,
} from '@cat-cafe/shared';

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
  | 'client_inactive'
  | 'visible_page_timeout'
  | 'visible_page_superseded'
  | 'visible_page_unavailable'
  | 'visible_page_load_error';

export type PreviewAutoOpenDeliveryReason =
  | PreviewAutoOpenReceiptReason
  | 'no_client_ack'
  | 'no_matching_client'
  | 'visible_page_not_attested'
  | 'visible_page_mismatch'
  | 'visible_page_ambiguous_clients'
  | 'visible_page_contract_invalid';

interface PreviewAutoOpenReceipt {
  status: Exclude<PreviewAutoOpenDeliveryStatus, 'unconfirmed'> | 'skipped' | 'rejected';
  eventId: string;
  reason?: PreviewAutoOpenReceiptReason;
  attestation?: PreviewVisiblePageAttestation;
}

export interface PreviewAutoOpenEventData {
  eventId: string;
  port: number;
  path?: string;
  threadId?: string;
  worktreeId?: string;
  targetOrigin?: string;
  visiblePageAdmission?: PreviewVisiblePageAdmission;
}

export interface PreviewAutoOpenEmitter {
  socketEmit?: (event: string, data: unknown, room: string) => void;
  socketEmitWithAck?: (event: string, data: unknown, room: string, timeoutMs?: number) => Promise<unknown[]>;
}

const STATUS_PRIORITY: Record<'applied' | 'blocked' | 'queued', number> = {
  applied: 3,
  blocked: 2,
  queued: 1,
};

const REASON_PRIORITY: Record<PreviewAutoOpenReceiptReason, number> = {
  presentation_lock: 3,
  thread_inactive: 2,
  worktree_mismatch: 1,
  client_inactive: 0,
  visible_page_timeout: 4,
  visible_page_superseded: 4,
  visible_page_unavailable: 4,
  visible_page_load_error: 4,
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
      candidate.status === 'skipped' ||
      candidate.status === 'rejected') &&
    (candidate.reason === undefined || isReceiptReason(candidate.reason))
  );
}

export interface PreviewAutoOpenDeliveryResult {
  deliveryStatus: PreviewAutoOpenDeliveryStatus;
  deliveryReason?: PreviewAutoOpenDeliveryReason;
  visiblePageAdmission?: {
    verified: boolean;
    targetPort?: number;
    targetOrigin?: string;
    targetPath?: string;
    clientRevision?: string | null;
    mismatches?: string[];
  };
}

function verifyAppliedVisiblePageReceipts(
  event: PreviewAutoOpenEventData,
  admission: PreviewVisiblePageAdmission,
  targetOrigin: string,
  applied: PreviewAutoOpenReceipt[],
): PreviewAutoOpenDeliveryResult {
  if (applied.some((receipt) => receipt.attestation === undefined)) {
    return { deliveryStatus: 'unconfirmed', deliveryReason: 'visible_page_not_attested' };
  }
  const verdicts = applied.map((receipt) =>
    verifyPreviewVisiblePageAttestation(admission, {
      eventId: event.eventId,
      targetPort: event.port,
      targetOrigin,
      targetPath: event.path ?? '/',
      attestation: receipt.attestation,
    }),
  );
  const mismatches = [...new Set(verdicts.flatMap((verdict) => verdict.mismatches))];
  if (mismatches.length > 0) {
    return {
      deliveryStatus: 'unconfirmed',
      deliveryReason: 'visible_page_mismatch',
      visiblePageAdmission: { verified: false, mismatches },
    };
  }
  const proof = applied[0]?.attestation;
  if (!proof) return { deliveryStatus: 'unconfirmed', deliveryReason: 'visible_page_not_attested' };
  return {
    deliveryStatus: 'applied',
    visiblePageAdmission: {
      verified: true,
      targetPort: proof.targetPort,
      targetOrigin: proof.targetOrigin,
      targetPath: proof.targetPath,
      clientRevision: proof.clientRevision,
    },
  };
}

function aggregateVisiblePageReceipts(
  event: PreviewAutoOpenEventData,
  receipts: PreviewAutoOpenReceipt[],
): PreviewAutoOpenDeliveryResult {
  const admission = event.visiblePageAdmission;
  const targetOrigin = event.targetOrigin;
  if (!admission || !targetOrigin) {
    return { deliveryStatus: 'unconfirmed', deliveryReason: 'visible_page_contract_invalid' };
  }
  if (receipts.length === 0) return { deliveryStatus: 'unconfirmed', deliveryReason: 'no_client_ack' };

  const rejected = receipts.find((receipt) => receipt.status === 'rejected');
  if (rejected) {
    return { deliveryStatus: 'unconfirmed', deliveryReason: rejected.reason ?? 'visible_page_not_attested' };
  }
  const applied = receipts.filter((receipt) => receipt.status === 'applied');
  const otherActionable = receipts.filter((receipt) => receipt.status !== 'applied' && receipt.status !== 'skipped');
  if (applied.length > 0 && otherActionable.length > 0) {
    return { deliveryStatus: 'unconfirmed', deliveryReason: 'visible_page_ambiguous_clients' };
  }
  if (applied.length > 0) return verifyAppliedVisiblePageReceipts(event, admission, targetOrigin, applied);
  return aggregateOrdinaryPreviewReceipts(receipts);
}

function aggregateOrdinaryPreviewReceipts(receipts: PreviewAutoOpenReceipt[]): PreviewAutoOpenDeliveryResult {
  const actionable = receipts
    .filter(
      (receipt): receipt is PreviewAutoOpenReceipt & { status: 'applied' | 'blocked' | 'queued' } =>
        receipt.status !== 'skipped' && receipt.status !== 'rejected',
    )
    .sort((a, b) => {
      const statusDelta = STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status];
      if (statusDelta !== 0) return statusDelta;
      return REASON_PRIORITY[b.reason ?? 'worktree_mismatch'] - REASON_PRIORITY[a.reason ?? 'worktree_mismatch'];
    });
  const receipt = actionable[0];
  if (!receipt) {
    return receipts.length > 0
      ? { deliveryStatus: 'unconfirmed', deliveryReason: 'no_matching_client' }
      : { deliveryStatus: 'unconfirmed', deliveryReason: 'no_client_ack' };
  }
  return {
    deliveryStatus: receipt.status,
    ...(receipt.reason ? { deliveryReason: receipt.reason } : {}),
  };
}

export function aggregatePreviewAutoOpenReceipts(
  event: string | PreviewAutoOpenEventData,
  values: readonly unknown[],
): PreviewAutoOpenDeliveryResult {
  const eventId = typeof event === 'string' ? event : event.eventId;
  const receipts = values.filter((value): value is PreviewAutoOpenReceipt => isReceipt(value, eventId));
  return typeof event !== 'string' && event.visiblePageAdmission
    ? aggregateVisiblePageReceipts(event, receipts)
    : aggregateOrdinaryPreviewReceipts(receipts);
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
  eventData: PreviewAutoOpenEventData,
  ackRoom: string,
): Promise<ReturnType<typeof aggregatePreviewAutoOpenReceipts>> {
  if (emitter.socketEmitWithAck) {
    const timeoutMs = eventData.visiblePageAdmission ? 10_000 : undefined;
    const receipts = await emitter
      .socketEmitWithAck('preview:auto-open', eventData, ackRoom, timeoutMs)
      .catch(() => []);
    return aggregatePreviewAutoOpenReceipts(eventData, receipts);
  }
  return { deliveryStatus: 'unconfirmed', deliveryReason: 'no_client_ack' };
}
