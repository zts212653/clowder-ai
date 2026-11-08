import type { ChatMessage } from './chat-types';
import { type ChatState, useChatStore } from './chatStore';

/**
 * PR-3a2 (contract §3.11.2): changes to a message — delete, restore, recall, edit, card updates —
 * reach a page only through the thread room. Whatever the page's cache holds when the room is
 * confirmed again after a gap was written before that confirmation (including new replies that
 * arrived through the user room meanwhile), so all of it is pending: only a History read issued
 * after that confirmation may decide it, by the IndexedDB-copy rule (the read's version, or gone).
 *
 * A round starts at the first confirmation in each period the room is wanted — a return to the
 * thread, or the page's first join. A reconnect inside the same period starts no round: an unstable
 * network must not drop the older pages a reader is looking at (a delete missed while reconnecting
 * stays until the next refresh, as before PR-3b).
 */
const generationByThread = new Map<string, number>();

/** The latest round of this thread; a History read records it when it is issued. */
export function currentRecoveryGeneration(threadId: string): number {
  return generationByThread.get(threadId) ?? 0;
}

/** Open a round for this thread and mark every cached copy as pending on it. */
export function beginThreadRecovery(threadId: string, live: () => ChatState = useChatStore.getState): number {
  const generation = currentRecoveryGeneration(threadId) + 1;
  generationByThread.set(threadId, generation);
  const store = live();
  const messages = store.getThreadState(threadId).messages;
  if (messages.length === 0) return generation;
  store.replaceThreadMessages(
    threadId,
    messages.map(
      (message): ChatMessage =>
        // An IndexedDB copy is already decided by any History read.
        message.cachedFrom === 'idb'
          ? message
          : { ...message, cachedFrom: 'unsubscribed', recoveryGeneration: generation },
    ),
  );
  return generation;
}

/** Whether a History read issued in round `issuedAt` may decide this copy. */
export function isDecidedByRead(message: ChatMessage, issuedAt: number | undefined): boolean {
  if (message.cachedFrom === 'idb') return true;
  if (message.cachedFrom !== 'unsubscribed') return false;
  return issuedAt !== undefined && (message.recoveryGeneration ?? 0) <= issuedAt;
}
