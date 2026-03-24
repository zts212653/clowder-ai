import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { IMessageStore } from '../../domains/cats/services/stores/ports/MessageStore.js';

export interface ConnectorDeliveryDeps {
  readonly messageStore: IMessageStore;
  readonly socketManager?: {
    broadcastToRoom: (room: string, event: string, data: unknown) => void;
  };
}

export interface ConnectorDeliveryInput {
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly content: string;
  readonly source: ConnectorSource;
}

export interface ConnectorDeliveryResult {
  readonly messageId: string;
  readonly content: string;
}

export async function deliverConnectorMessage(
  deps: ConnectorDeliveryDeps,
  input: ConnectorDeliveryInput,
): Promise<ConnectorDeliveryResult> {
  const stored = await deps.messageStore.append({
    threadId: input.threadId,
    userId: input.userId,
    catId: null,
    content: input.content,
    source: input.source,
    mentions: [input.catId as CatId],
    timestamp: Date.now(),
  });

  deps.socketManager?.broadcastToRoom(`thread:${input.threadId}`, 'connector_message', {
    threadId: input.threadId,
    message: {
      id: stored.id,
      type: 'connector',
      content: input.content,
      source: input.source,
      timestamp: stored.timestamp,
    },
  });

  return { messageId: stored.id, content: input.content };
}
