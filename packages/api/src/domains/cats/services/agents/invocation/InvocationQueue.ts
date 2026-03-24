/**
 * InvocationQueue
 * Per-thread, per-user FIFO 队列，用于猫猫在跑时排队用户/connector 消息。
 *
 * 与 InvocationTracker（互斥锁，跟踪活跃调用）互补：
 * - InvocationTracker: "谁在跑"
 * - InvocationQueue: "谁在等"
 *
 * scopeKey = `${threadId}:${userId}` — 存储层天然用户隔离。
 * 系统级出队（invocation 完成后）通过 *AcrossUsers 方法跨用户 FIFO。
 */

import { randomUUID } from 'node:crypto';

export interface QueueEntry {
  id: string;
  threadId: string;
  userId: string;
  content: string;
  messageId: string | null;
  mergedMessageIds: string[];
  source: 'user' | 'connector' | 'agent';
  targetCats: string[];
  intent: string;
  status: 'queued' | 'processing';
  createdAt: number;
  /** F122B: auto-execute without waiting for steer/manual trigger */
  autoExecute: boolean;
  /** F122B: which cat initiated this entry (for A2A/multi_mention display) */
  callerCatId?: string;
  /** F134: sender identity for connector group chat messages (used for UI display) */
  senderMeta?: { id: string; name?: string };
}

export interface EnqueueResult {
  outcome: 'enqueued' | 'merged' | 'full';
  entry?: QueueEntry;
  queuePosition?: number;
}

const MAX_QUEUE_DEPTH = 5;

export class InvocationQueue {
  private queues = new Map<string, QueueEntry[]>();

  /** Last pre-merge content per entryId, for rollback */
  private preMergeSnapshots = new Map<string, string>();
  /** Original content per entryId at enqueue time, for rollbackEnqueue */
  private originalContents = new Map<string, string>();

  private scopeKey(threadId: string, userId: string): string {
    return `${threadId}:${userId}`;
  }

  private getOrCreate(key: string): QueueEntry[] {
    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    return q;
  }

  /**
   * 预留队列位。容量检查在此完成。
   * 同源同目标的连续消息自动合并。
   */
  enqueue(
    input: Omit<
      QueueEntry,
      'id' | 'status' | 'createdAt' | 'mergedMessageIds' | 'messageId' | 'autoExecute' | 'callerCatId'
    > & {
      autoExecute?: boolean;
      callerCatId?: string;
    },
  ): EnqueueResult {
    const key = this.scopeKey(input.threadId, input.userId);
    const q = this.getOrCreate(key);

    // Check merge with tail — F134: connector messages never merge (different group senders could collide)
    const tail = q.length > 0 ? q[q.length - 1] : null;
    if (
      tail &&
      tail.status === 'queued' &&
      tail.source === input.source &&
      tail.source !== 'connector' &&
      tail.intent === input.intent &&
      arraysEqual(sorted(tail.targetCats), sorted(input.targetCats))
    ) {
      // Save snapshot for rollback
      this.preMergeSnapshots.set(tail.id, tail.content);
      tail.content += `\n${input.content}`;
      return { outcome: 'merged', entry: { ...tail }, queuePosition: q.indexOf(tail) + 1 };
    }

    // Capacity check (only queued entries count)
    const queuedCount = q.filter((e) => e.status === 'queued').length;
    if (queuedCount >= MAX_QUEUE_DEPTH) {
      return { outcome: 'full' };
    }

    const entry: QueueEntry = {
      id: randomUUID(),
      threadId: input.threadId,
      userId: input.userId,
      content: input.content,
      messageId: null,
      mergedMessageIds: [],
      source: input.source,
      targetCats: [...input.targetCats],
      intent: input.intent,
      status: 'queued',
      createdAt: Date.now(),
      autoExecute: input.autoExecute ?? false,
      callerCatId: input.callerCatId,
      senderMeta: input.senderMeta,
    };
    q.push(entry);
    this.originalContents.set(entry.id, input.content);
    return { outcome: 'enqueued', entry: { ...entry }, queuePosition: q.length };
  }

  /** Backfill messageId on a new entry (null → value). */
  backfillMessageId(threadId: string, userId: string, entryId: string, messageId: string): void {
    const e = this.findEntry(threadId, userId, entryId);
    if (e) e.messageId = messageId;
  }

  /** Append to mergedMessageIds (does NOT overwrite messageId). */
  appendMergedMessageId(threadId: string, userId: string, entryId: string, messageId: string): void {
    const e = this.findEntry(threadId, userId, entryId);
    if (e) e.mergedMessageIds.push(messageId);
  }

  /** Rollback a merge — restore pre-merge content snapshot. */
  rollbackMerge(threadId: string, userId: string, entryId: string): void {
    const e = this.findEntry(threadId, userId, entryId);
    const snapshot = this.preMergeSnapshots.get(entryId);
    if (e && snapshot !== undefined) {
      e.content = snapshot;
      this.preMergeSnapshots.delete(entryId);
    }
  }

  /**
   * Rollback an enqueued entry's write failure.
   * If no merges have occurred → remove entry entirely.
   * If merges exist → strip original content, keep merged content alive.
   * This prevents a race where request A fails after request B merged into A's entry.
   */
  rollbackEnqueue(threadId: string, userId: string, entryId: string): void {
    const e = this.findEntry(threadId, userId, entryId);
    if (!e) return;

    const origContent = this.originalContents.get(entryId);
    // Detect merges: content grew beyond original
    if (origContent !== undefined && e.content !== origContent) {
      // Strip original content prefix, keep merged content
      const prefix = `${origContent}\n`;
      if (e.content.startsWith(prefix)) {
        e.content = e.content.slice(prefix.length);
      }
      // Promote surviving merged message ID so QueueProcessor can link it
      if (e.mergedMessageIds.length > 0) {
        e.messageId = e.mergedMessageIds.shift()!;
      } else {
        e.messageId = null;
      }
      // Clear stale snapshot so rollbackMerge can't reintroduce ghost content
      this.preMergeSnapshots.delete(entryId);
    } else {
      // No merges — safe to remove entirely
      this.remove(threadId, userId, entryId);
    }
    this.originalContents.delete(entryId);
  }

  /** Remove and return the first entry (FIFO). */
  dequeue(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q || q.length === 0) return null;
    return q.shift()!;
  }

  /** Look at the first entry without removing. */
  peek(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    return q?.[0] ?? null;
  }

  /** Remove a specific entry by id. Returns null if not found. */
  remove(threadId: string, userId: string, entryId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const idx = q.findIndex((e) => e.id === entryId);
    if (idx === -1) return null;
    this.originalContents.delete(entryId);
    this.preMergeSnapshots.delete(entryId);
    return q.splice(idx, 1)[0] ?? null;
  }

  /** Shallow copy of all entries for this user in this thread. */
  list(threadId: string, userId: string): QueueEntry[] {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    return q ? [...q] : [];
  }

  /** Count of queued (not processing) entries. */
  size(threadId: string, userId: string): number {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return 0;
    return q.filter((e) => e.status === 'queued').length;
  }

  /** Clear all entries for this user. Returns removed entries. */
  clear(threadId: string, userId: string): QueueEntry[] {
    const key = this.scopeKey(threadId, userId);
    const q = this.queues.get(key);
    if (!q) return [];
    for (const e of q) {
      this.originalContents.delete(e.id);
      this.preMergeSnapshots.delete(e.id);
    }
    this.queues.delete(key);
    return q;
  }

  /**
   * Move entry up or down within the user's queue.
   * Returns false if entry is processing or not found.
   */
  move(threadId: string, userId: string, entryId: string, direction: 'up' | 'down'): boolean {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return false;
    const idx = q.findIndex((e) => e.id === entryId);
    if (idx === -1) return false;
    if (q[idx]?.status === 'processing') return false;

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= q.length) return true; // boundary no-op, idempotent

    const a = q[idx]!;
    const b = q[swapIdx]!;
    q[idx] = b;
    q[swapIdx] = a;
    return true;
  }

  /**
   * Promote a queued entry to the front of queued entries (after any processing entries).
   * Returns false if not found or entry is processing.
   */
  promote(threadId: string, userId: string, entryId: string): boolean {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return false;
    const idx = q.findIndex((e) => e.id === entryId);
    if (idx === -1) return false;
    const entry = q[idx]!;
    if (entry.status === 'processing') return false;

    q.splice(idx, 1);
    const firstQueuedIdx = q.findIndex((e) => e.status === 'queued');
    const insertIdx = firstQueuedIdx === -1 ? q.length : firstQueuedIdx;
    q.splice(insertIdx, 0, entry);
    return true;
  }

  /** Mark the first queued entry as processing (stays in array). */
  markProcessing(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const first = q.find((e) => e.status === 'queued');
    if (!first) return null;
    first.status = 'processing';
    return { ...first };
  }

  /** Peek at the next queued entry without mutating state. */
  peekNextQueued(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const first = q.find((e) => e.status === 'queued');
    return first ? { ...first } : null;
  }

  /** Rollback a processing entry back to queued (undo markProcessing/markProcessingAcrossUsers). */
  rollbackProcessing(threadId: string, entryId: string): boolean {
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      const entry = q.find((e) => e.id === entryId && e.status === 'processing');
      if (entry) {
        entry.status = 'queued';
        return true;
      }
    }
    return false;
  }

  /** Remove a processing entry for this user by entryId. */
  removeProcessed(threadId: string, userId: string, entryId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const idx = q.findIndex((e) => e.status === 'processing' && e.id === entryId);
    if (idx === -1) return null;
    this.originalContents.delete(entryId);
    this.preMergeSnapshots.delete(entryId);
    return q.splice(idx, 1)[0] ?? null;
  }

  // ── Cross-user methods (system-level only) ──

  /** Find the oldest queued entry across all users for a thread. */
  peekOldestAcrossUsers(threadId: string): QueueEntry | null {
    let oldest: QueueEntry | null = null;
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      for (const e of q) {
        if (e.status !== 'queued') continue;
        if (!oldest || e.createdAt < oldest.createdAt) {
          oldest = e;
        }
      }
    }
    return oldest ? { ...oldest } : null;
  }

  /** Mark the oldest queued entry across users as processing. */
  markProcessingAcrossUsers(threadId: string): QueueEntry | null {
    let oldest: { entry: QueueEntry; key: string } | null = null;
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      for (const e of q) {
        if (e.status !== 'queued') continue;
        if (!oldest || e.createdAt < oldest.entry.createdAt) {
          oldest = { entry: e, key };
        }
      }
    }
    if (!oldest) return null;
    oldest.entry.status = 'processing';
    return { ...oldest.entry };
  }

  /** Remove a processing entry across all users for a thread by entryId. */
  removeProcessedAcrossUsers(threadId: string, entryId: string): QueueEntry | null {
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      const idx = q.findIndex((e) => e.status === 'processing' && e.id === entryId);
      if (idx !== -1) {
        this.originalContents.delete(entryId);
        this.preMergeSnapshots.delete(entryId);
        return q.splice(idx, 1)[0] ?? null;
      }
    }
    return null;
  }

  /** Get unique userIds that have entries (any status) for this thread. */
  listUsersForThread(threadId: string): string[] {
    const users: string[] = [];
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`) || q.length === 0) continue;
      const userId = key.slice(threadId.length + 1);
      users.push(userId);
    }
    return users;
  }

  /** F122B: List all queued autoExecute entries for a thread (for scanning past busy slots). */
  listAutoExecute(threadId: string): QueueEntry[] {
    const result: QueueEntry[] = [];
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      for (const e of q) {
        if (e.status === 'queued' && e.autoExecute) result.push({ ...e });
      }
    }
    return result;
  }

  /** F122B: Count queued+processing agent-sourced entries for a thread (depth tracking). */
  countAgentEntriesForThread(threadId: string): number {
    let count = 0;
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      for (const e of q) {
        if (e.source === 'agent') count++;
      }
    }
    return count;
  }

  /** F122B: Check if a specific cat already has a queued agent entry for this thread.
   *  Used by callback-a2a-trigger for dedup — only checks 'queued' so that new handoffs
   *  can still be enqueued while an earlier entry is processing. */
  hasQueuedAgentForCat(threadId: string, catId: string): boolean {
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      for (const e of q) {
        if (e.source === 'agent' && e.status === 'queued' && e.targetCats.includes(catId)) return true;
      }
    }
    return false;
  }

  /** Cross-path dedup: checks both queued AND processing agent entries.
   *  Used by route-serial to prevent text-scan @mention when callback already dispatched. */
  hasActiveOrQueuedAgentForCat(threadId: string, catId: string): boolean {
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      for (const e of q) {
        if (
          e.source === 'agent' &&
          (e.status === 'queued' || e.status === 'processing') &&
          e.targetCats.includes(catId)
        )
          return true;
      }
    }
    return false;
  }

  /** F122B: Mark a specific entry as processing by ID (cross-user). */
  markProcessingById(threadId: string, entryId: string): boolean {
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      const entry = q.find((e) => e.id === entryId && e.status === 'queued');
      if (entry) {
        entry.status = 'processing';
        return true;
      }
    }
    return false;
  }

  /** Whether any user has queued entries for this thread. */
  hasQueuedForThread(threadId: string): boolean {
    for (const [key, q] of this.queues) {
      if (!key.startsWith(`${threadId}:`)) continue;
      if (q.some((e) => e.status === 'queued')) return true;
    }
    return false;
  }

  // ── Internal helpers ──

  private findEntry(threadId: string, userId: string, entryId: string): QueueEntry | undefined {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    return q?.find((e) => e.id === entryId);
  }
}

/** Sort a string array (returns new array). */
function sorted(arr: string[]): string[] {
  return [...arr].sort();
}

/** Compare two sorted string arrays for equality. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
