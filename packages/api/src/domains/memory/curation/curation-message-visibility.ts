import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { isSystemUserMessage, isTimelinePublished } from '../../cats/services/stores/visibility.js';

/** Overview facts come from the owner's public conversation, not scheduler/system logs. */
export function isCurationMessageReadable(message: StoredMessage, ownerUserId: string, threadId: string): boolean {
  return (
    message.threadId === threadId &&
    message.userId === ownerUserId &&
    !isSystemUserMessage(message) &&
    !message.deletedAt &&
    !message._tombstone &&
    !message.recall &&
    message.visibility !== 'whisper' &&
    isTimelinePublished(message)
  );
}
