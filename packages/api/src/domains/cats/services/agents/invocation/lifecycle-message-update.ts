import type { StoredMessage } from '../../stores/ports/MessageStore.js';

interface LifecycleUpdateEmitter {
  emitToUser(userId: string, event: string, data: unknown): void;
}

/**
 * Publish one exact same-id lifecycle snapshot; clients upsert without inventing state. A committed
 * response is the whole truth of its turn, not just its text, so every surface it renders travels
 * with it (tool events, thinking, metadata), whichever path committed it.
 */
export function emitLifecycleMessageUpdated(
  emitter: LifecycleUpdateEmitter,
  userId: string,
  message: StoredMessage,
): void {
  if (!message.lifecycle) return;
  emitter.emitToUser(userId, 'message_lifecycle_updated', {
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
