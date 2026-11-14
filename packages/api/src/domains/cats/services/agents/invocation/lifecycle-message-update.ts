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
  emitSnapshot(emitter, userId, message, 'message_lifecycle_updated', commit);
}

function emitSnapshot(
  emitter: LifecycleUpdateEmitter,
  userId: string,
  message: StoredMessage,
  event: string,
  commit?: LifecycleCommitMarker,
): void {
  const source = storedMessageSource(message);
  emitter.emitToUser(userId, event, {
    ...(commit ? { commit } : {}),
    threadId: message.threadId,
    message: {
      id: message.id,
      ...(message.from?.kind === 'user' && message.userId === userId && message.clientMessageId
        ? { clientMessageId: message.clientMessageId }
        : {}),
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
