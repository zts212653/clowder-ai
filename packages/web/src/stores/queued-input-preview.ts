import type { ChatMessage, QueueEntry } from './chat-types';

/** Queue remains the owner until delivery; this is a view of its confirmed user inputs. */
export function withQueuedInputPreviews(
  history: readonly ChatMessage[],
  queue: readonly QueueEntry[] | undefined,
  threadId: string,
): readonly ChatMessage[] {
  const ids = new Set(history.map((message) => message.id));
  const pending: ChatMessage[] = [];
  for (const entry of queue ?? []) {
    if (entry.threadId !== threadId || entry.from.kind !== 'user' || !entry.messageId || ids.has(entry.messageId))
      continue;
    ids.add(entry.messageId);
    pending.push({
      id: entry.messageId,
      from: entry.from,
      type: 'user',
      content: entry.content,
      timestamp: entry.messagePreview?.timestamp ?? entry.createdAt,
      queuedEntryId: entry.id,
      ...(entry.messagePreview?.contentBlocks ? { contentBlocks: [...entry.messagePreview.contentBlocks] } : {}),
      ...(entry.messagePreview?.replyTo ? { replyTo: entry.messagePreview.replyTo } : {}),
      ...(entry.messagePreview?.visibility
        ? { visibility: entry.messagePreview.visibility, whisperTo: entry.messagePreview.whisperTo }
        : {}),
    });
  }
  return pending.length ? [...history, ...pending] : history;
}
