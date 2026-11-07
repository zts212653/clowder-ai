import type { StoredMessage } from '../../stores/ports/MessageStore.js';

interface LifecycleUpdateEmitter {
  emitToUser(userId: string, event: string, data: unknown): void;
}

/**
 * Whether the store applied a terminal now or replayed an identical one. Only the store seam knows
 * (`publishing-message-store.ts`); a page may announce a terminal only when it was `applied`.
 */
export type LifecycleCommitMarker = 'applied' | 'replayed';

/**
 * Publish one exact same-id lifecycle snapshot; clients upsert without inventing state. A committed
 * response is the whole truth of its turn, not just its text, so every surface it renders travels
 * with it (tool events, thinking, metadata), whichever path committed it. Snapshots an exit emits
 * itself carry no commit marker and only update what the page shows.
 */
export function emitLifecycleMessageUpdated(
  emitter: LifecycleUpdateEmitter,
  userId: string,
  message: StoredMessage,
  commit?: LifecycleCommitMarker,
): void {
  if (!message.lifecycle) return;
  emitter.emitToUser(userId, 'message_lifecycle_updated', {
    ...(commit ? { commit } : {}),
    threadId: message.threadId,
    message: {
      id: message.id,
      ...(message.from ? { from: message.from } : {}),
      catId: message.catId,
      content: message.content,
      lifecycle: message.lifecycle,
      timestamp: message.timestamp,
      ...(message.timelineOrderAt !== undefined ? { timelineOrderAt: message.timelineOrderAt } : {}),
      ...(message.contentBlocks ? { contentBlocks: message.contentBlocks } : {}),
      ...(message.toolEvents ? { toolEvents: message.toolEvents } : {}),
      ...(message.thinking ? { thinking: message.thinking } : {}),
      ...(message.metadata ? { metadata: message.metadata } : {}),
      ...(message.mentionsUser ? { mentionsUser: true } : {}),
      ...(message.extra ? { extra: message.extra } : {}),
      ...(message.origin ? { origin: message.origin } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.source ? { source: message.source } : {}),
    },
  });
}
