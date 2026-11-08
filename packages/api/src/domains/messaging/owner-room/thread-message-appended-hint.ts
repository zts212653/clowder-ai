import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';

/**
 * PR-3a (docs/plans/2026-11-05-hub-pr3-background-thread-contract.md 3.8): the owner-room hint for a
 * stored message.
 *
 * A standalone message (a post_message that wakes nobody, a cloud return, a thread notice) may reach
 * a page only through its thread room, with no later Queue or lifecycle event. Once background
 * threads stop joining their rooms, this hint is what keeps the Sidebar's unread and the owner
 * mention notification alive. It carries no body: it says "this thread changed", the page re-reads
 * its canonical Sidebar snapshot, and the body arrives when the thread is read again.
 */
export interface ThreadMessageAppendedHint {
  readonly threadId: string;
  readonly messageId: string;
  readonly catId?: string;
  readonly mentionsUser?: true;
}

export function threadMessageAppendedHint(message: StoredMessage): ThreadMessageAppendedHint | null {
  // Lifecycle messages have their own owner-room channel: response snapshots, delivery failures,
  // and inputs announced by `messages_delivered` when the Queue delivers them.
  if (message.lifecycle) return null;
  // Not visible yet; `messages_delivered` announces it when it is.
  if (message.deliveryStatus === 'queued') return null;
  return {
    threadId: message.threadId,
    messageId: message.id,
    ...(message.catId ? { catId: message.catId } : {}),
    // A whisper's existence may be shown; its owner mention notification is not this hint's to make.
    ...(message.mentionsUser && message.visibility !== 'whisper' ? { mentionsUser: true as const } : {}),
  };
}
