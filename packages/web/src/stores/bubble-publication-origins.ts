import { type MessageMediaItemSelector, messageMediaItemKey } from '@cat-cafe/shared';
import type { ChatMessage, MessagePublicationOrigin } from './chat-types';

export function retainPublicationOrigin(
  origins: Record<string, MessagePublicationOrigin>,
  projectedItem: MessageMediaItemSelector,
  record: ChatMessage,
  sourceItem: MessageMediaItemSelector,
): void {
  origins[messageMediaItemKey(projectedItem)] = record.projectionPublicationOrigins?.[
    messageMediaItemKey(sourceItem)
  ] ?? {
    messageId: record.id,
    messageRevision: String(record.timestamp),
    item: sourceItem,
  };
}

/**
 * F309: a live bubble runs on the client clock, but a publication names the stored message's own
 * time. Once that time is known, the bubble and the media items it owns take it; items folded in
 * from other records keep theirs.
 */
export function storedRevisionPatch(
  message: Pick<ChatMessage, 'id' | 'projectionPublicationOrigins'>,
  storedTimestamp: number,
): Pick<ChatMessage, 'timestamp' | 'projectionPublicationOrigins'> {
  const origins = message.projectionPublicationOrigins;
  if (!origins) return { timestamp: storedTimestamp };
  const settled = Object.fromEntries(
    Object.entries(origins).map(([key, origin]) => [
      key,
      origin.messageId === message.id ? { ...origin, messageRevision: String(storedTimestamp) } : origin,
    ]),
  );
  return { timestamp: storedTimestamp, projectionPublicationOrigins: settled };
}

/** An id replacement renames every origin that the replaced record owned. */
export function rekeyPublicationOrigins(
  origins: ChatMessage['projectionPublicationOrigins'],
  fromId: string,
  toId: string,
): ChatMessage['projectionPublicationOrigins'] {
  if (!origins || !Object.values(origins).some((origin) => origin.messageId === fromId)) return origins;
  return Object.fromEntries(
    Object.entries(origins).map(([key, origin]) => [
      key,
      origin.messageId === fromId ? { ...origin, messageId: toId } : origin,
    ]),
  );
}

export function retainRichPublicationOrigins(
  origins: Record<string, MessagePublicationOrigin>,
  record: ChatMessage,
  block: NonNullable<NonNullable<ChatMessage['extra']>['rich']>['blocks'][number],
): void {
  if (block.kind === 'media_gallery')
    block.items.forEach((_item, itemIndex) => {
      const selector = { kind: 'media-gallery' as const, blockId: block.id, itemIndex };
      retainPublicationOrigin(origins, selector, record, selector);
    });
  else if (block.kind === 'file') {
    const selector = { kind: 'rich-file' as const, blockId: block.id };
    retainPublicationOrigin(origins, selector, record, selector);
  }
}
