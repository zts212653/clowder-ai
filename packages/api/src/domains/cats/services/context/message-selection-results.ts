import type { RichBlock } from '@cat-cafe/shared';
import { messageFrom } from '../stores/message-from.js';
import type { StoredMessage } from '../stores/ports/MessageStore.js';
import type {
  MessageSelectionTombstone,
  MessageSelectionTombstoneReason,
  ResolvedMessageSelectionItem,
} from './message-selection-types.js';

function fromFor(message: StoredMessage): NonNullable<StoredMessage['from']> {
  return structuredClone(messageFrom(message));
}

export function tombstone(messageId: string, reason: MessageSelectionTombstoneReason): MessageSelectionTombstone {
  return { status: 'tombstone', messageId, reason };
}

export function projectedItem(
  message: StoredMessage,
  item: { kind: ResolvedMessageSelectionItem['kind']; comment?: string },
  readableContent: string,
  richBlock?: RichBlock,
): ResolvedMessageSelectionItem {
  return {
    status: 'available',
    kind: item.kind,
    messageId: message.id,
    sourceThreadId: message.threadId,
    from: fromFor(message),
    timestamp: message.timestamp,
    readableContent,
    ...(item.comment ? { comment: item.comment } : {}),
    ...(richBlock ? { richBlock } : {}),
  };
}
