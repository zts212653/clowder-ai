import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { IMessageStore } from '../../domains/cats/services/stores/ports/MessageStore.js';

export interface ConnectorDeliveryDeps {
  readonly messageStore: IMessageStore;
}

export interface ConnectorDeliveryInput {
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly content: string;
  readonly source: ConnectorSource;
  readonly extra?: NonNullable<
    import('../../domains/cats/services/stores/ports/MessageStore.js').StoredMessage['extra']
  >;
  /** Stable MessageStore key for crash-safe connector delivery retries. */
  readonly idempotencyKey?: string;
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
    from: {
      kind: 'external',
      connectorId: input.source.connector,
      ...(input.source.sender ? { sender: input.source.sender } : {}),
    },
    threadId: input.threadId,
    userId: input.userId,
    content: input.content,
    source: input.source,
    mentions: [input.catId as CatId],
    timestamp: Date.now(),
    deliveryStatus: 'queued',
    ...(input.extra ? { extra: input.extra } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  return { messageId: stored.id, content: input.content };
}
