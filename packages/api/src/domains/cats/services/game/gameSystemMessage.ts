import type { CatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../stores/ports/MessageStore.js';

interface NarrativeSocketLike {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

export async function appendGameSystemMessage(params: {
  threadId: string;
  content: string;
  messageStore?: IMessageStore;
  socketManager?: NarrativeSocketLike;
  timestamp?: number;
}): Promise<StoredMessage | null> {
  const timestamp = params.timestamp ?? Date.now();
  const stored = params.messageStore
    ? await Promise.resolve(
        params.messageStore.append({
          userId: 'system',
          catId: 'system' as CatId,
          content: params.content,
          mentions: [],
          timestamp,
          threadId: params.threadId,
        }),
      )
    : null;

  params.socketManager?.broadcastToRoom(`thread:${params.threadId}`, 'game:narrative', {
    threadId: params.threadId,
    message: {
      id: stored?.id ?? `game-system-${timestamp}`,
      type: 'system',
      content: params.content,
      timestamp,
    },
  });

  return stored;
}
