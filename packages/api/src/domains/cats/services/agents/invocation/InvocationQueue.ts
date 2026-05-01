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
import { createModuleLogger } from '../../../../../infrastructure/logger.js';

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
  /** Set when entry transitions to 'processing'. Used for stale-processing TTL. */
  processingStartedAt?: number;
  /** F122B: auto-execute without waiting for steer/manual trigger */
  autoExecute: boolean;
  /** F122B: which cat initiated this entry (for A2A/multi_mention display) */
  callerCatId?: string;
  /** F134: sender identity for connector group chat messages (used for UI display) */
  senderMeta?: { id: string; name?: string };
  /** F175: queue-internal priority — urgent entries sort before normal in dequeue */
  priority: 'urgent' | 'normal';
  /** F175: origin category for visual grouping */
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'continuation';
  /** Queue-internal dedup key for agent control-flow work. */
  continuationKey?: string;
  /** F175: user drag-reorder position — explicit values override priority in dequeue */
  position?: number;
  /** F175: skill hint for connector triggers — flows through as promptTags on execution */
  suggestedSkill?: string;
}

export interface EnqueueResult {
  outcome: 'enqueued' | 'full';
  entry?: QueueEntry;
  queuePosition?: number;
}

const MAX_QUEUE_DEPTH = 5;

export function isSystemPinnedQueueEntry(entry: Pick<QueueEntry, 'source' | 'sourceCategory'>): boolean {
  return entry.source === 'agent' && entry.sourceCategory === 'continuation';
}

export class InvocationQueue {
  private readonly log = createModuleLogger('invocation-queue');
  private queues = new Map<string, QueueEntry[]>();

  /** Original content per entryId at enqueue time, for rollbackEnqueue */
  private originalContents = new Map<string, string>();

  private scopeKey(threadId: string, userId: string): string {
    return `${threadId}:${userId}`;
  }

  private queueMatchesThread(q: QueueEntry[], threadId: string): boolean {
    return q.some((entry) => entry.threadId === threadId);
  }

  private getOrCreate(key: string): QueueEntry[] {
    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    return q;
  }

  private static readonly PRIORITY_RANK: Record<string, number> = { urgent: 0, normal: 1 };

  /** F175: multi-dimensional entry comparator for dequeue ordering.
   *  Position is scoped to same-user entries to prevent cross-user queue-jumping in shared threads. */
  private static compareEntries(a: QueueEntry, b: QueueEntry): number {
    const aPinned = isSystemPinnedQueueEntry(a);
    const bPinned = isSystemPinnedQueueEntry(b);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;

    if (a.userId === b.userId) {
      const aHasPos = a.position !== undefined;
      const bHasPos = b.position !== undefined;
      if (aHasPos && !bHasPos) return -1;
      if (!aHasPos && bHasPos) return 1;
      if (aHasPos && bHasPos) return a.position! - b.position!;
    }
    const pDiff = (InvocationQueue.PRIORITY_RANK[a.priority] ?? 1) - (InvocationQueue.PRIORITY_RANK[b.priority] ?? 1);
    if (pDiff !== 0) return pDiff;
    return a.createdAt - b.createdAt;
  }

  /** F175: set explicit dequeue position for drag-reorder. */
  setPosition(threadId: string, userId: string, entryId: string, position: number): boolean {
    const e = this.findEntry(threadId, userId, entryId);
    if (!e || e.status !== 'queued') return false;
    if (isSystemPinnedQueueEntry(e)) return false;
    e.position = position;
    return true;
  }

  /**
   * 预留队列位。容量检查在此完成。
   * 同源同目标的连续消息自动合并。
   */
  enqueue(
    input: Omit<
      QueueEntry,
      | 'id'
      | 'status'
      | 'createdAt'
      | 'mergedMessageIds'
      | 'messageId'
      | 'autoExecute'
      | 'callerCatId'
      | 'priority'
      | 'position'
      | 'suggestedSkill'
    > & {
      autoExecute?: boolean;
      callerCatId?: string;
      priority?: 'urgent' | 'normal';
      suggestedSkill?: string;
    },
  ): EnqueueResult {
    const key = this.scopeKey(input.threadId, input.userId);
    const q = this.getOrCreate(key);

    // F175: capacity check — only user messages are depth-limited
    if (input.source === 'user') {
      const userQueuedCount = q.filter((e) => e.status === 'queued' && e.source === 'user').length;
      if (userQueuedCount >= MAX_QUEUE_DEPTH) {
        return { outcome: 'full' };
      }
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
      priority: input.priority ?? 'normal',
      sourceCategory: input.sourceCategory,
      continuationKey: input.continuationKey,
      suggestedSkill: input.suggestedSkill,
      position: undefined,
    };
    q.push(entry);
    this.originalContents.set(entry.id, input.content);
    return { outcome: 'enqueued', entry: { ...entry }, queuePosition: q.length };
  }

  /** Check if any entry in the thread already carries this messageId (connector retry dedup). */
  hasEntryWithMessageId(threadId: string, messageId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((e) => e.messageId === messageId || e.mergedMessageIds?.includes(messageId))) return true;
    }
    return false;
  }

  /** Backfill messageId on a new entry (null → value). */
  backfillMessageId(threadId: string, userId: string, entryId: string, messageId: string): void {
    const e = this.findEntry(threadId, userId, entryId);
    if (e) e.messageId = messageId;
  }

  /** Rollback an enqueued entry — remove entirely. */
  rollbackEnqueue(threadId: string, userId: string, entryId: string): void {
    this.remove(threadId, userId, entryId);
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

    return q.splice(idx, 1)[0] ?? null;
  }

  /** Shallow copy of all entries sorted by dequeue priority (comparator order). */
  list(threadId: string, userId: string): QueueEntry[] {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return [];
    return [...q].sort(InvocationQueue.compareEntries);
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
    }
    this.queues.delete(key);
    return q;
  }

  /**
   * Move entry up or down in comparator order by swapping positions with its neighbor.
   * Returns false if entry is processing or not found.
   */
  move(threadId: string, userId: string, entryId: string, direction: 'up' | 'down'): boolean {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return false;
    const target = q.find((e) => e.id === entryId);
    if (!target || target.status === 'processing') return false;
    if (isSystemPinnedQueueEntry(target)) return false;

    const queued = q.filter((e) => e.status === 'queued');
    queued.sort(InvocationQueue.compareEntries);
    const sortedIdx = queued.findIndex((e) => e.id === entryId);
    const neighborIdx = direction === 'up' ? sortedIdx - 1 : sortedIdx + 1;
    if (neighborIdx < 0 || neighborIdx >= queued.length) return true;

    for (let i = 0; i < queued.length; i++) {
      queued[i]!.position = i;
    }
    const a = queued[sortedIdx]!;
    const b = queued[neighborIdx]!;
    const tmp = a.position!;
    a.position = b.position!;
    b.position = tmp;
    return true;
  }

  /**
   * Promote a queued entry to first in comparator order by setting its position
   * below all existing positions.
   * Returns false if not found or entry is processing.
   */
  promote(threadId: string, userId: string, entryId: string): boolean {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return false;
    const entry = q.find((e) => e.id === entryId);
    if (!entry || entry.status === 'processing') return false;
    if (isSystemPinnedQueueEntry(entry)) return false;

    const minPos = q.reduce((min, e) => {
      if (e.status === 'queued' && e.position !== undefined && e.position < min) return e.position;
      return min;
    }, 0);
    entry.position = minPos - 1;
    return true;
  }

  /** F175: Mark the highest-priority queued entry as processing (stays in array). */
  markProcessing(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const queued = q.filter((e) => e.status === 'queued');
    if (queued.length === 0) return null;
    queued.sort(InvocationQueue.compareEntries);
    const best = queued[0]!;
    best.status = 'processing';
    best.processingStartedAt = Date.now();
    return { ...best };
  }

  /** F175: Peek at the highest-priority queued entry without mutating state. */
  peekNextQueued(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const queued = q.filter((e) => e.status === 'queued');
    if (queued.length === 0) return null;
    queued.sort(InvocationQueue.compareEntries);
    return { ...queued[0]! };
  }

  /** Rollback a processing entry back to queued (undo markProcessing/markProcessingAcrossUsers). */
  rollbackProcessing(threadId: string, entryId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
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

    return q.splice(idx, 1)[0] ?? null;
  }

  // ── Cross-user methods (system-level only) ──

  /** F175: Find the highest-priority queued entry across all users for a thread. */
  peekOldestAcrossUsers(threadId: string): QueueEntry | null {
    let best: QueueEntry | null = null;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.status !== 'queued') continue;
        if (!best || InvocationQueue.compareEntries(e, best) < 0) {
          best = e;
        }
      }
    }
    return best ? { ...best } : null;
  }

  /** F175: Mark the highest-priority queued entry across users as processing.
   *  skipCatIds: skip entries whose primary target cat is in this set (slot busy). */
  markProcessingAcrossUsers(threadId: string, skipCatIds?: Set<string>): QueueEntry | null {
    let best: QueueEntry | null = null;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.status !== 'queued') continue;
        if (skipCatIds?.has(e.targetCats[0] ?? '')) continue;
        if (!best || InvocationQueue.compareEntries(e, best) < 0) {
          best = e;
        }
      }
    }
    if (!best) return null;
    best.status = 'processing';
    best.processingStartedAt = Date.now();
    return { ...best };
  }

  /** Remove a processing entry across all users for a thread by entryId. */
  removeProcessedAcrossUsers(threadId: string, entryId: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const idx = q.findIndex((e) => e.status === 'processing' && e.id === entryId);
      if (idx !== -1) {
        this.originalContents.delete(entryId);

        return q.splice(idx, 1)[0] ?? null;
      }
    }
    return null;
  }

  /** Get unique userIds that have entries (any status) for this thread. */
  listUsersForThread(threadId: string): string[] {
    const users: string[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId) || q.length === 0) continue;
      users.push(q[0]!.userId);
    }
    return users;
  }

  /** F122B: List all queued autoExecute entries for a thread (for scanning past busy slots). */
  listAutoExecute(threadId: string): QueueEntry[] {
    const result: QueueEntry[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.status !== 'queued' || !e.autoExecute) continue;
        result.push({ ...e });
      }
    }
    return result;
  }

  /** F122B: Count queued+processing agent-sourced entries for a thread (depth tracking).
   *  Queued entries are valid pending work regardless of age; processing entries
   *  have their own stale guard in hasActiveOrQueuedAgentForCat/hasPendingForCat. */
  countAgentEntriesForThread(threadId: string): number {
    let count = 0;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.source !== 'agent') continue;
        count++;
      }
    }
    return count;
  }

  /** F122B: Check if a specific cat already has a queued agent entry for this thread.
   *  Used by callback-a2a-trigger for dedup — only checks 'queued' so that new handoffs
   *  can still be enqueued while an earlier entry is processing.
   */
  hasQueuedAgentForCat(threadId: string, catId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.source === 'agent' && e.status === 'queued' && e.targetCats.includes(catId)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Cross-path dedup: checks processing + fresh queued agent entries.
   * Used by route-serial to prevent text-scan @mention when callback already dispatched.
   *
   * 'processing' entries block only if fresh (< STALE_PROCESSING_THRESHOLD_MS).
   * Zombie processing entries (invocation hung without cleanup) are ignored to
   * prevent permanent A2A routing deadlock.
   *
   * 'queued' entries always block: they are legitimate pending dispatches and
   * listAutoExecute/markProcessingAcrossUsers will still pick them up after a long wait.
   */
  /** @deprecated queued agent entries are no longer expired by age; retained for old migration tests. */
  static readonly STALE_QUEUED_THRESHOLD_MS = 60_000;
  static readonly STALE_PROCESSING_THRESHOLD_MS = 600_000; // 10 minutes

  hasActiveOrQueuedAgentForCat(threadId: string, catId: string): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.source !== 'agent' || !e.targetCats.includes(catId)) continue;

        if (e.status === 'processing') {
          // Use processingStartedAt (when the entry actually began processing),
          // NOT createdAt (when it was enqueued). An entry may sit queued for a
          // long time before being picked up — using createdAt would falsely
          // expire it the moment it starts processing. (P1 fix per codex review)
          const processingAge = now - (e.processingStartedAt ?? e.createdAt);
          if (processingAge < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) {
            this.log?.info(
              {
                threadId,
                catId,
                matchedEntry: {
                  entryId: e.id,
                  status: e.status,
                  processingAgeMs: processingAge,
                  userId: e.userId,
                },
              },
              '[DIAG] hasActiveOrQueuedAgentForCat hit',
            );
            return true;
          }
          // Stale processing — zombie defense
          this.log?.warn(
            {
              threadId,
              catId,
              matchedEntry: {
                entryId: e.id,
                status: e.status,
                processingAgeMs: processingAge,
                userId: e.userId,
              },
            },
            '[DIAG] hasActiveOrQueuedAgentForCat: ignoring stale processing entry (zombie defense)',
          );
          continue;
        }

        if (e.status === 'queued') {
          this.log?.info(
            {
              threadId,
              catId,
              matchedEntry: {
                entryId: e.id,
                status: e.status,
                queuedAgeMs: now - e.createdAt,
                userId: e.userId,
              },
            },
            '[DIAG] hasActiveOrQueuedAgentForCat hit',
          );
          return true;
        }
      }
    }
    return false;
  }

  /** Check for any queued/processing entry targeting a cat, optionally narrowed by source. */
  hasPendingForCat(
    threadId: string,
    catId: string,
    opts?: {
      excludeEntryId?: string;
      sources?: QueueEntry['source'][];
      sourceCategories?: NonNullable<QueueEntry['sourceCategory']>[];
      continuationKey?: string;
    },
  ): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (opts?.excludeEntryId && e.id === opts.excludeEntryId) continue;
        if (!e.targetCats.includes(catId)) continue;
        if (opts?.sources && !opts.sources.includes(e.source)) continue;
        if (opts?.sourceCategories) {
          if (!e.sourceCategory || !opts.sourceCategories.includes(e.sourceCategory)) continue;
        }
        if (opts?.continuationKey !== undefined && e.continuationKey !== opts.continuationKey) continue;

        if (e.status === 'queued') {
          return true;
        }

        if (e.status === 'processing') {
          const processingAge = now - (e.processingStartedAt ?? e.createdAt);
          if (processingAge >= InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) {
            this.log?.warn(
              {
                threadId,
                catId,
                matchedEntry: {
                  entryId: e.id,
                  status: e.status,
                  processingAgeMs: processingAge,
                  userId: e.userId,
                },
              },
              '[DIAG] hasPendingForCat: ignoring stale processing entry (zombie defense)',
            );
            continue;
          }
          return true;
        }
      }
    }
    return false;
  }

  /** F122B: Mark a specific entry as processing by ID (cross-user). */
  markProcessingById(threadId: string, entryId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find((e) => e.id === entryId && e.status === 'queued');
      if (entry) {
        entry.status = 'processing';
        entry.processingStartedAt = Date.now();
        return true;
      }
    }
    return false;
  }

  /**
   * F175: Collect a batch of adjacent user entries for unified execution.
   * Non-user sources always return a single-entry batch.
   * User entries batch while: same source, same intent, same targetCats (set equality).
   * Returns copies — caller is responsible for marking processing.
   */
  collectUserBatch(threadId: string, userId: string): QueueEntry[] {
    const key = this.scopeKey(threadId, userId);
    const q = this.queues.get(key);
    if (!q) return [];

    const queued = q.filter((e) => e.status === 'queued');
    if (queued.length === 0) return [];
    queued.sort(InvocationQueue.compareEntries);

    const first = queued[0]!;
    if (first.source !== 'user') return [{ ...first }];

    const batch: QueueEntry[] = [{ ...first }];
    const firstTargetsSorted = sorted(first.targetCats);
    for (let i = 1; i < queued.length; i++) {
      const e = queued[i]!;
      if (e.source !== 'user' || e.intent !== first.intent || !arraysEqual(sorted(e.targetCats), firstTargetsSorted))
        break;
      batch.push({ ...e });
    }
    return batch;
  }

  /** #555: Whether a specific cat has any queued or processing entries in this thread (any source).
   *  Queued entries remain valid pending work regardless of age; only stale processing
   *  entries are ignored to prevent zombie entries from permanently blocking a cat. */
  hasQueuedOrProcessingForCat(threadId: string, catId: string): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (!e.targetCats.includes(catId)) continue;
        if (e.status === 'queued') {
          return true;
        }
        if (e.status === 'processing') {
          const age = now - (e.processingStartedAt ?? e.createdAt);
          if (age < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) return true;
        }
      }
    }
    return false;
  }

  /** Whether any scope has fresh queued entries for this thread.
   *  Agent-sourced entries are dispatchable pending work regardless of age;
   *  user/connector entries keep the stale guard so old interactive messages
   *  do not permanently force thread-wide queue/busy mode.
   */
  hasQueuedForThread(threadId: string): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (
        q.some((e) => {
          if (e.status !== 'queued') return false;
          if (e.source === 'agent') return true;
          return now - e.createdAt < InvocationQueue.STALE_QUEUED_THRESHOLD_MS;
        })
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether any scope has dispatchable queued work for this thread.
   *
   * This deliberately has no stale queued guard: a queued entry is pending work
   * until it is dispatched, canceled, or cleared. The stale guard in
   * hasQueuedForThread is only for fairness/queue-mode routing decisions.
   */
  hasDispatchableQueuedForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((e) => e.status === 'queued')) return true;
    }
    return false;
  }

  /**
   * Whether any user-sourced message is queued for this thread.
   * Agent/connector-sourced entries are excluded — they have their own
   * per-cat dedup via hasActiveOrQueuedAgentForCat and must NOT block
   * the A2A text-scan fairness gate in routeSerial.
   */
  hasQueuedUserMessagesForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((e) => e.status === 'queued' && e.source === 'user')) return true;
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
