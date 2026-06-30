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
import type { CallerTraceContext } from '../../../../../infrastructure/telemetry/genai-semconv.js';

export interface QueueEntry {
  id: string;
  threadId: string;
  userId: string;
  /** Optional request-level idempotency key for API replay dedup. */
  idempotencyKey?: string;
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
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'continuation' | 'issue' | 'freshness';
  /** Queue-internal dedup key for agent control-flow work. */
  continuationKey?: string;
  /** F175: user drag-reorder position — explicit values override priority in dequeue */
  position?: number;
  /** F175: skill hint for connector triggers — flows through as promptTags on execution */
  suggestedSkill?: string;
  callerTraceContext?: CallerTraceContext;
  /** Explicit A2A trigger message for stream reply threading. */
  a2aTriggerMessageId?: string;
}

export interface EnqueueResult {
  outcome: 'enqueued' | 'full';
  entry?: QueueEntry;
  queuePosition?: number;
  /** True when enqueue returned an existing active entry by idempotency key. */
  deduped?: boolean;
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

  private static normalizedPriority(input: {
    source: QueueEntry['source'];
    sourceCategory?: QueueEntry['sourceCategory'];
    priority?: QueueEntry['priority'];
  }): QueueEntry['priority'] {
    return input.source === 'agent' && input.sourceCategory !== 'continuation'
      ? 'normal'
      : (input.priority ?? 'normal');
  }

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
      messageId?: string | null;
      /** Defaults true for request replay dedupe; connector coalescing can opt out for in-flight entries. */
      dedupeProcessing?: boolean;
    },
  ): EnqueueResult {
    const key = this.scopeKey(input.threadId, input.userId);
    const q = this.getOrCreate(key);
    const priority = InvocationQueue.normalizedPriority(input);
    const dedupeProcessing = input.dedupeProcessing ?? true;

    // Request replay dedupe: if an active entry already exists for this key in this scope,
    // return it instead of creating a second queue row.
    if (input.idempotencyKey) {
      const existing = q.find(
        (entry) =>
          entry.idempotencyKey === input.idempotencyKey &&
          (entry.status === 'queued' || (dedupeProcessing && entry.status === 'processing')),
      );
      if (existing) {
        if (existing.status === 'queued') {
          const upgradedPriority =
            (InvocationQueue.PRIORITY_RANK[priority] ?? 1) < (InvocationQueue.PRIORITY_RANK[existing.priority] ?? 1);
          if (upgradedPriority) {
            existing.priority = priority;
          }
          if (input.suggestedSkill && (upgradedPriority || !existing.suggestedSkill)) {
            existing.suggestedSkill = input.suggestedSkill;
          }
          if (input.sourceCategory && !existing.sourceCategory) {
            existing.sourceCategory = input.sourceCategory;
          }
        }
        const position = q.findIndex((entry) => entry.id === existing.id);
        return {
          outcome: 'enqueued',
          entry: { ...existing },
          queuePosition: position >= 0 ? position + 1 : undefined,
          deduped: true,
        };
      }
    }

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
      idempotencyKey: input.idempotencyKey,
      content: input.content,
      messageId: input.messageId ?? null,
      mergedMessageIds: [],
      source: input.source,
      targetCats: [...input.targetCats],
      intent: input.intent,
      status: 'queued',
      createdAt: Date.now(),
      autoExecute: input.autoExecute ?? false,
      callerCatId: input.callerCatId,
      senderMeta: input.senderMeta,
      priority,
      sourceCategory: input.sourceCategory,
      continuationKey: input.continuationKey,
      suggestedSkill: input.suggestedSkill,
      callerTraceContext: input.callerTraceContext,
      a2aTriggerMessageId: input.a2aTriggerMessageId,
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
    if (!e) return;
    if (!e.messageId) {
      e.messageId = messageId;
      return;
    }
    if (e.messageId !== messageId && !e.mergedMessageIds.includes(messageId)) {
      e.mergedMessageIds.push(messageId);
    }
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

  /**
   * Find the in-flight (processing) entry occupying a cat's per-cat slot in a thread, across all
   * users. 2026-06-02 (Steer 无法抢占): steer-immediate uses this to locate the entry whose
   * executeEntry holds the slot, so it can tombstone it (removeProcessedAcrossUsers) instead of
   * force-releasing the slot — the tombstone makes executeEntry self-abort at its post-startAll
   * guard, which is race-safe through the pre-start (create-await) window. Returns null if none.
   */
  findProcessingByCat(threadId: string, catId: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find((e) => e.status === 'processing' && (e.targetCats[0] ?? 'unknown') === catId);
      if (entry) return entry;
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
   * F-coalesce: find the best in-flight agent entry to coalesce a same-turn handoff into.
   *
   * Used by callback-a2a-trigger to merge a caller's repeated same-turn handoffs to the same target
   * instead of dispatching duplicate invocations. Resolution PREFERS a mergeable 'queued' entry over
   * a 'processing' one: a queued entry can be merged in place (coalesceContentIntoQueuedAgent),
   * whereas a processing entry is already running and can only be superseded (abort+restart, deferred
   * to F216). So when a cat has BOTH a running entry and a queued follow-up, a third handoff must
   * merge into the queued follow-up — not spawn yet another entry. Hence the two-pass scan.
   *
   * Stale processing entries (zombie invocations past STALE_PROCESSING_THRESHOLD_MS) are ignored so
   * a hung invocation never permanently swallows new handoffs. Returns a copy (never a live ref).
   */
  findInFlightAgentEntry(threadId: string, catId: string, callerCatId?: string): QueueEntry | null {
    // 云端 codex R4 P1: scope to sourceCategory 'a2a'. `source: 'agent'` alone also matches
    // self-continuation entries (QueueProcessor.enqueueContinuation → source:'agent',
    // sourceCategory:'continuation'). Without this filter an A2A handoff to a cat that has a queued
    // continuation would merge INTO the continuation prompt — mixing unrelated control-flow content
    // with another cat's handoff AND suppressing the real A2A route. Only same-category 'a2a' entries
    // are the caller's repeated same-turn handoffs and thus semantically mergeable. (Mirrors the
    // existing sourceCategory discrimination in isSystemPinnedQueueEntry / normalizedPriority.)
    //
    // F216 c0 (砚砚 GPT-5.5 review P1): ALSO scope by callerCatId. Only the SAME caller's repeated
    // same-turn handoffs are mergeable — without this, cat A's queued handoff to a target gets
    // coalesced/superseded by cat B's later handoff to the same target (cross-caller串味). Strict
    // match: both sides must be defined AND equal — an entry with undefined callerCatId is never
    // adopted by an arbitrary caller, and an undefined-caller lookup never adopts anyone (safe
    // direction: prefer a fresh entry over a wrong merge). callerCatId omitted → caller scope off
    // (legacy/test callers that don't care; production callback-a2a-trigger always passes it).
    const matches = (e: QueueEntry): boolean => {
      if (!(e.source === 'agent' && e.sourceCategory === 'a2a' && e.targetCats.includes(catId))) return false;
      if (callerCatId === undefined) return true; // caller scope not requested
      return e.callerCatId !== undefined && e.callerCatId === callerCatId;
    };
    // Pass 1: prefer a mergeable queued entry (in-place coalesce, no abort needed).
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (matches(e) && e.status === 'queued') return { ...e };
      }
    }
    // Pass 2: fall back to a fresh (non-stale) processing entry — caller defers supersede to F216.
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (!matches(e) || e.status !== 'processing') continue;
        const age = now - (e.processingStartedAt ?? e.createdAt);
        if (age < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) return { ...e };
      }
    }
    return null;
  }

  /**
   * F-coalesce: merge new content + messageId into an existing QUEUED agent entry.
   *
   * Only succeeds while the entry is still 'queued' (not yet dispatched) — returns false if it has
   * already started processing (the caller must supersede via abort+restart instead, see F216).
   * Content is appended with a blank-line separator so the target cat sees both handoffs as one
   * coherent message (parity with collectUserBatch's user-message coalescing). The new messageId is
   * tracked in mergedMessageIds so delivery/ack covers both trigger messages.
   */
  coalesceContentIntoQueuedAgent(
    threadId: string,
    userId: string,
    entryId: string,
    content: string,
    messageId?: string,
    callerCatId?: string,
  ): boolean {
    const e = this.findEntry(threadId, userId, entryId);
    if (!e || e.status !== 'queued') return false;
    // 云端 codex R4 P1 (defense-in-depth): only A2A entries are mergeable. findInFlightAgentEntry
    // already scopes to sourceCategory 'a2a', but guard here too so a future caller passing a
    // continuation/other entryId can never splice a handoff into unrelated control-flow content.
    if (!(e.source === 'agent' && e.sourceCategory === 'a2a')) return false;
    // F216 c0 (砚砚 GPT-5.5 review P1): defense-in-depth caller scope — refuse cross-caller merge.
    // findInFlightAgentEntry already caller-scopes, but guard here too so a stale/wrong entryId from
    // a different caller can never splice content. Strict: when callerCatId is provided it must match
    // a defined entry.callerCatId. Omitted → scope off (legacy/test callers).
    if (callerCatId !== undefined && !(e.callerCatId !== undefined && e.callerCatId === callerCatId)) return false;
    e.content = `${e.content}\n\n${content}`;
    if (messageId && e.messageId !== messageId && !e.mergedMessageIds.includes(messageId)) {
      e.mergedMessageIds.push(messageId);
    }
    return true;
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

  hasActiveOrQueuedAgentForCat(threadId: string, catId: string, opts?: { excludeEntryId?: string }): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (opts?.excludeEntryId && e.id === opts.excludeEntryId) continue;
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

  /** F185 AC-6: Whether any non-agent entry (user or connector) is queued for this thread. */
  hasQueuedNonAgentForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((e) => e.status === 'queued' && e.source !== 'agent')) return true;
    }
    return false;
  }

  /**
   * Whether any user-sourced message is queued for this thread (user-only filter).
   * F185 Phase B: text-scan fairness gate now uses hasQueuedNonAgentForThread instead.
   * Retained for backward compatibility but no longer used by fairness gates.
   */
  hasQueuedUserMessagesForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((e) => e.status === 'queued' && e.source === 'user')) return true;
    }
    return false;
  }

  /**
   * #815: Find queued A2A trigger entries whose target cats are all active.
   * Scoped to a single userId — prompt context assembly is per-user, so
   * consuming another user's A2A entry would silently lose their trigger.
   * Returns candidates without removing them — caller performs async
   * delivery-status filtering, then calls `consumeEntriesById` to remove.
   */
  findSubsumedA2ACandidates(threadId: string, userId: string, activeCatSet: Set<string>): QueueEntry[] {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return [];
    const candidates: QueueEntry[] = [];
    for (const e of q) {
      if (e.status !== 'queued') continue;
      if (e.sourceCategory !== 'a2a') continue;
      if (!e.targetCats.every((cat) => activeCatSet.has(cat))) continue;
      candidates.push(e);
    }
    return candidates;
  }

  /**
   * #815: Remove specific entries by ID. Returns removed entries.
   * Used after async filtering of A2A candidates by delivery status.
   */
  consumeEntriesById(entryIds: Set<string>): QueueEntry[] {
    const consumed: QueueEntry[] = [];
    for (const q of this.queues.values()) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (entryIds.has(q[i]!.id)) {
          this.originalContents.delete(q[i]!.id);
          consumed.push(q.splice(i, 1)[0]!);
        }
      }
    }
    if (consumed.length > 0) {
      this.log.info(
        { count: consumed.length, entryIds: consumed.map((e) => e.id) },
        '#815: consumed A2A entries by ID',
      );
    }
    return consumed;
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
