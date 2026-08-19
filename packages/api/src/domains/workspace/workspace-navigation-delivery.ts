export type WorkspaceNavigationDeliveryStatus = 'applied' | 'queued' | 'blocked' | 'unconfirmed';

type WorkspaceNavigationReceiptReason =
  | 'thread_inactive'
  | 'non_chat_route'
  | 'narrow_viewport'
  | 'presentation_lock'
  | 'persistence_unavailable';

interface WorkspaceNavigationReceipt {
  status: Exclude<WorkspaceNavigationDeliveryStatus, 'unconfirmed'>;
  eventId: string;
  reason?: WorkspaceNavigationReceiptReason;
}

export interface WorkspaceNavigationEmitter {
  socketEmit?: (event: string, data: unknown, room: string) => void;
  socketEmitWithAck?: (event: string, data: unknown, room: string) => Promise<unknown[]>;
}

export const WORKSPACE_NAVIGATION_ACK_ROOM = 'workspace:navigate:ack';

const STATUS_PRIORITY: Record<WorkspaceNavigationReceipt['status'], number> = {
  applied: 3,
  blocked: 2,
  queued: 1,
};

const REASON_PRIORITY: Record<WorkspaceNavigationReceiptReason, number> = {
  presentation_lock: 5,
  persistence_unavailable: 4,
  thread_inactive: 3,
  non_chat_route: 2,
  narrow_viewport: 1,
};

function isReceiptReason(value: unknown): value is WorkspaceNavigationReceiptReason {
  return typeof value === 'string' && Object.hasOwn(REASON_PRIORITY, value);
}

function isReceipt(value: unknown, eventId: string): value is WorkspaceNavigationReceipt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkspaceNavigationReceipt>;
  return (
    candidate.eventId === eventId &&
    (candidate.status === 'applied' || candidate.status === 'queued' || candidate.status === 'blocked') &&
    (candidate.reason === undefined || isReceiptReason(candidate.reason))
  );
}

export function aggregateWorkspaceNavigationReceipts(
  eventId: string,
  values: readonly unknown[],
): {
  deliveryStatus: WorkspaceNavigationDeliveryStatus;
  deliveryReason?: WorkspaceNavigationReceiptReason | 'no_client_ack';
} {
  const receipts = values
    .filter((value): value is WorkspaceNavigationReceipt => isReceipt(value, eventId))
    .sort((a, b) => {
      const statusDelta = STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status];
      if (statusDelta !== 0) return statusDelta;
      return REASON_PRIORITY[b.reason ?? 'narrow_viewport'] - REASON_PRIORITY[a.reason ?? 'narrow_viewport'];
    });
  const receipt = receipts[0];
  if (!receipt) return { deliveryStatus: 'unconfirmed', deliveryReason: 'no_client_ack' };
  return {
    deliveryStatus: receipt.status,
    ...(receipt.reason ? { deliveryReason: receipt.reason } : {}),
  };
}

export async function emitWorkspaceNavigate(
  emitter: WorkspaceNavigationEmitter,
  eventData: { eventId: string },
  legacyRooms: readonly string[],
): Promise<ReturnType<typeof aggregateWorkspaceNavigationReceipts>> {
  for (const room of legacyRooms) {
    emitter.socketEmit?.('workspace:navigate', eventData, room);
  }
  if (emitter.socketEmitWithAck) {
    const receipts = await emitter
      .socketEmitWithAck('workspace:navigate', eventData, WORKSPACE_NAVIGATION_ACK_ROOM)
      .catch(() => []);
    return aggregateWorkspaceNavigationReceipts(eventData.eventId, receipts);
  }
  return { deliveryStatus: 'unconfirmed', deliveryReason: 'no_client_ack' };
}
