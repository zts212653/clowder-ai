import type { SocketManager } from '../../infrastructure/websocket/index.js';
import type { QueueProcessor } from '../cats/services/agents/invocation/QueueProcessor.js';
import type { ManagedHoldReceiptInput } from './ManagedHoldReceiptService.js';

export function createManagedHoldSettlementPublisher(deps: {
  socketManager?: Pick<SocketManager, 'broadcastToRoom'>;
  queueProcessor: Pick<QueueProcessor, 'tryAutoExecute'>;
  log: { warn(fields: Record<string, unknown>, message: string): void };
}): (input: ManagedHoldReceiptInput) => Promise<void> {
  return async ({ threadId, sourceMessageId }) => {
    try {
      deps.socketManager?.broadcastToRoom(`thread:${threadId}`, 'message_receipt_updated', {
        threadId,
        messageId: sourceMessageId,
      });
    } catch (err) {
      deps.log.warn({ err, threadId, sourceMessageId }, 'Managed hold settled but receipt publication failed');
    }
    // The durable terminal and exact Queue removal already committed. Advance
    // existing admission even while the original child continues; neither UI
    // failure nor a dispatch error may undo that terminal.
    try {
      await deps.queueProcessor.tryAutoExecute(threadId);
    } catch (err) {
      deps.log.warn({ err, threadId, sourceMessageId }, 'Managed hold settled but queued dispatch could not advance');
    }
  };
}
