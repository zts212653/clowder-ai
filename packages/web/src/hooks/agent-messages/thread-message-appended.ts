import { fireOwnerMentionNotification, useChatStore } from '@/stores/chatStore';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';

/**
 * PR-3a: the owner-room hint the API sends when a message is stored.
 *
 * A standalone message (a post_message that wakes nobody, a cloud return, a thread notice) may reach
 * a page only through its thread room, with no later Queue or lifecycle event. Once background
 * threads stop joining their rooms, this hint is what keeps the Sidebar's unread and the owner
 * mention notification alive. It carries no body: it says "this thread changed", the Sidebar
 * re-reads its canonical snapshot, and the body arrives when the thread is read again.
 */
export interface ThreadMessageAppendedHint {
  threadId: string;
  messageId: string;
  catId?: string;
  mentionsUser?: boolean;
}

export function isThreadMessageAppendedHint(value: unknown): value is ThreadMessageAppendedHint {
  if (!value || typeof value !== 'object') return false;
  const hint = value as Record<string, unknown>;
  return (
    typeof hint.threadId === 'string' &&
    hint.threadId.length > 0 &&
    typeof hint.messageId === 'string' &&
    hint.messageId.length > 0 &&
    (hint.catId === undefined || typeof hint.catId === 'string') &&
    (hint.mentionsUser === undefined || typeof hint.mentionsUser === 'boolean')
  );
}

export function observeThreadMessageAppended(hint: ThreadMessageAppendedHint): void {
  void invalidateSidebarProjection();
  if (!hint.mentionsUser) return;
  // Same rule as a message landing in the store: a background thread always notifies, the open
  // thread only while the page is not focused.
  const isOpenThread = hint.threadId === useChatStore.getState().currentThreadId;
  const pageFocused = typeof document !== 'undefined' && document.hasFocus();
  if (isOpenThread && pageFocused) return;
  fireOwnerMentionNotification({ id: hint.messageId, catId: hint.catId }, hint.threadId);
}
