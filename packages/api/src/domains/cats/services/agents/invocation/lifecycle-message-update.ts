import { storedMessageSource } from '../../stores/message-source.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';

interface LifecycleUpdateEmitter {
  emitToUser(userId: string, event: string, data: unknown): void;
}

/** Generic same-id stored-message projection, including messages without a member lifecycle. */
export function emitStoredMessageUpdated(
  emitter: LifecycleUpdateEmitter,
  userId: string,
  message: StoredMessage,
): void {
  emitSnapshot(emitter, userId, message, 'message_snapshot_updated');
}

/** Lifecycle consumers retain their strict contract; plugin receipts do not manufacture one. */
export function emitLifecycleMessageUpdated(
  emitter: LifecycleUpdateEmitter,
  userId: string,
  message: StoredMessage,
): void {
  if (!message.lifecycle) return;
  emitSnapshot(emitter, userId, message, 'message_lifecycle_updated');
}

function emitSnapshot(emitter: LifecycleUpdateEmitter, userId: string, message: StoredMessage, event: string): void {
  const source = storedMessageSource(message);
  emitter.emitToUser(userId, event, {
    threadId: message.threadId,
    message: {
      id: message.id,
      ...(message.from ? { from: message.from } : {}),
      catId: message.catId,
      content: message.content,
      ...(message.lifecycle ? { lifecycle: message.lifecycle } : {}),
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
      ...(source ? { source } : {}),
    },
  });
}
