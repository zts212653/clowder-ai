import type { StoredMessage } from './ports/MessageStore.js';

/** The exact message inputs consumed by memory indexing, after ordinary thread visibility and limit. */
export interface MessageEvidenceProjection {
  id: string;
  content: string;
  catId?: NonNullable<StoredMessage['catId']>;
  threadId: string;
  timestamp: number;
  contentBlocks?: readonly unknown[];
  richBlocks?: readonly unknown[];
}

export function projectMessageEvidence(messages: readonly StoredMessage[]): MessageEvidenceProjection[] {
  return messages
    .filter((message) => message.origin !== 'briefing')
    .map((message) => ({
      id: message.id,
      content: message.content,
      catId: message.catId ?? undefined,
      threadId: message.threadId,
      timestamp: message.timestamp,
      contentBlocks: message.contentBlocks,
      richBlocks: message.extra?.rich?.blocks,
    }));
}
