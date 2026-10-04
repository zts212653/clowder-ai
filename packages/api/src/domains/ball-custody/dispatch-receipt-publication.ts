import type { SocketManager } from '../../infrastructure/websocket/index.js';
import { emitQueueUpdated } from '../../utils/queue-enrichment.js';
import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { SettledDispatchReceipt } from './DispatchReceiptService.js';

export function createDispatchReceiptPublisher(deps: {
  socketManager: Pick<SocketManager, 'emitToUser' | 'broadcastToRoom'>;
  queue: Pick<InvocationQueue, 'list'>;
  messageStore: IMessageStore;
}): (input: SettledDispatchReceipt) => Promise<void> {
  return async ({ threadId, sourceMessageId, ownerId }) => {
    await emitQueueUpdated(
      deps.socketManager,
      ownerId,
      threadId,
      deps.queue.list(threadId, ownerId),
      deps.messageStore,
      'queued_handled',
      { receiptMessageIds: [sourceMessageId] },
    );
    deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'message_receipt_updated', {
      threadId,
      messageId: sourceMessageId,
    });
  };
}
