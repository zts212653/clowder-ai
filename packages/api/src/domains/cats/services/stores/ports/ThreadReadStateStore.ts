/**
 * Thread Read State Store (F069)
 * Per-user/per-thread read cursor for unread badge persistence.
 */

import type { IMessageStore } from './MessageStore.js';

export interface ThreadReadState {
  userId: string;
  threadId: string;
  lastReadMessageId: string;
  updatedAt: number;
}

export interface ThreadUnreadSummary {
  threadId: string;
  unreadCount: number;
  hasUserMention: boolean;
}

export interface IThreadReadStateStore {
  /** Get read cursor for a user+thread. Returns null if never read. */
  get(userId: string, threadId: string): ThreadReadState | null | Promise<ThreadReadState | null>;
  /** Ack: advance cursor (monotonic — only moves forward). Returns true if advanced. */
  ack(userId: string, threadId: string, messageId: string): boolean | Promise<boolean>;
  /** Bulk get unread summaries for all threads of a user. */
  getUnreadSummaries(
    userId: string,
    threadIds: string[],
    messageStore: IMessageStore,
  ): ThreadUnreadSummary[] | Promise<ThreadUnreadSummary[]>;
  /** Cleanup: delete read state for a thread (cascade on thread delete). */
  deleteByThread(threadId: string): void | Promise<void>;
  /**
   * #1200: Atomic cursor format reconciliation — upgrade v1 → v2 without advancing.
   * CAS: SET newV2 IF current === oldV1. Returns true if reconciled.
   * Used by pre-reconcile before ack() to ensure same-format CAS comparison.
   * Optional: implementations without cross-format concern may omit.
   */
  reconcileReadCursor?(userId: string, threadId: string, oldV1: string, newV2: string): boolean | Promise<boolean>;
}
