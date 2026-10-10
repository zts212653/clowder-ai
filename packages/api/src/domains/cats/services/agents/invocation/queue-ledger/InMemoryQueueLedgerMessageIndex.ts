import type { QueueLedgerEntry } from './QueueLedger.js';

/**
 * Secondary lookup from a source message to the ledger rows carrying it.
 *
 * The rows remain the only truth; this index exists so `getByMessageIds` answers "which rows belong
 * to this message" without scanning a thread. Every mutation is applied in the same synchronous step
 * as the row mutation it mirrors, which is what lets a lookup treat a dangling entry id as
 * corruption rather than as a benign race.
 */
export class InMemoryQueueLedgerMessageIndex {
  private readonly byThread = new Map<string, Map<string, Set<string>>>();

  index(threadId: string, entries: readonly QueueLedgerEntry[]): void {
    const threadIndex = this.byThread.get(threadId) ?? new Map<string, Set<string>>();
    for (const entry of entries) {
      const messageId = entry.payload.messageId;
      if (!messageId) continue;
      const entryIds = threadIndex.get(messageId) ?? new Set<string>();
      entryIds.add(entry.id);
      threadIndex.set(messageId, entryIds);
    }
    if (threadIndex.size > 0) this.byThread.set(threadId, threadIndex);
  }

  unindex(threadId: string, entries: readonly QueueLedgerEntry[]): void {
    const threadIndex = this.byThread.get(threadId);
    if (!threadIndex) return;
    for (const entry of entries) {
      const messageId = entry.payload.messageId;
      if (!messageId) continue;
      const entryIds = threadIndex.get(messageId);
      entryIds?.delete(entry.id);
      if (entryIds?.size === 0) threadIndex.delete(messageId);
    }
    if (threadIndex.size === 0) this.byThread.delete(threadId);
  }

  /** Entry ids recorded for one message, or undefined when the thread carries no index at all. */
  entryIds(threadId: string, messageId: string): ReadonlySet<string> | undefined {
    return this.byThread.get(threadId)?.get(messageId);
  }

  has(threadId: string): boolean {
    return this.byThread.has(threadId);
  }
}
