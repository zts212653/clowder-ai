/**
 * QueueProcessor
 * 处理 InvocationQueue 中的排队条目：自动出队 + 暂停管理。
 *
 * 两个入口：
 * - onInvocationComplete（系统级）：invocation 完成后调用，succeeded 时自动出队
 * - processNext（用户级）：铲屎官手动触发处理自己的下一条
 */

import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';

/** Minimal interfaces for deps — avoid importing full types for testability */

interface TrackerLike {
  start(threadId: string, catId: string, userId: string, catIds?: string[]): AbortController;
  complete(threadId: string, catId: string, controller?: AbortController): void;
  has(threadId: string, catId?: string): boolean;
}

export interface InvocationRecordStoreLike {
  create(input: Record<string, unknown>): Promise<{ outcome: string; invocationId: string }>;
  update(id: string, data: Record<string, unknown>): Promise<void>;
}

export interface RouterLike {
  routeExecution(
    userId: string,
    content: string,
    threadId: string,
    messageId: string | null,
    targetCats: string[],
    intent: { intent: string },
    opts?: Record<string, unknown>,
  ): AsyncIterable<{ type: string; catId?: string; [key: string]: unknown }>;
  ackCollectedCursors(userId: string, threadId: string, cursors: Map<string, string>): Promise<void>;
}

interface SocketManagerLike {
  broadcastAgentMessage(msg: unknown, threadId: string): void;
  broadcastToRoom(room: string, event: string, data: unknown): void;
  emitToUser(userId: string, event: string, data: unknown): void;
}

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface QueueProcessorDeps {
  queue: InvocationQueue;
  invocationTracker: TrackerLike;
  invocationRecordStore: InvocationRecordStoreLike;
  router: RouterLike;
  socketManager: SocketManagerLike;
  messageStore: IMessageStore;
  log: LoggerLike;
}

/** F122B B6: Completion hook — called when a queue entry finishes execution. */
export type EntryCompleteHook = (
  entryId: string,
  status: 'succeeded' | 'failed' | 'canceled',
  responseText: string,
) => void;

export class QueueProcessor {
  private deps: QueueProcessorDeps;
  /** F108: Per-slot mutex — prevents concurrent double-start per (thread, cat) pair */
  private processingSlots = new Set<string>();
  /** F108: Per-slot pause tracking (set on canceled/failed, cleared on next execution) */
  private pausedSlots = new Map<string, 'canceled' | 'failed'>();
  /** F122B B6: Per-entry completion hooks (for multi-mention response aggregation). */
  private entryCompleteHooks = new Map<string, EntryCompleteHook>();

  constructor(deps: QueueProcessorDeps) {
    this.deps = deps;
  }

  /**
   * F122B B6: Register a completion hook for a specific queue entry.
   * Called by multi-mention dispatch to capture response text for aggregation.
   * Hook is auto-removed after invocation (one-shot).
   */
  registerEntryCompleteHook(entryId: string, hook: EntryCompleteHook): void {
    this.entryCompleteHooks.set(entryId, hook);
  }

  /** F122B B6: Remove a completion hook (e.g. on abort before execution). */
  unregisterEntryCompleteHook(entryId: string): void {
    this.entryCompleteHooks.delete(entryId);
  }

  private static slotKey(threadId: string, catId: string): string {
    return `${threadId}:${catId}`;
  }

  /** Check if a slot's queue is paused (canceled/failed AND has queued entries). */
  isPaused(threadId: string, catId?: string): boolean {
    if (catId) {
      return (
        this.pausedSlots.has(QueueProcessor.slotKey(threadId, catId)) && this.deps.queue.hasQueuedForThread(threadId)
      );
    }
    // Backward compat: check if any slot for this thread is paused
    for (const key of this.pausedSlots.keys()) {
      if (key.startsWith(`${threadId}:`)) {
        if (this.deps.queue.hasQueuedForThread(threadId)) return true;
      }
    }
    return false;
  }

  /** Expose queued-state for route fairness decisions in non-queue entry paths (retry/connector). */
  hasQueuedForThread(threadId: string): boolean {
    return this.deps.queue.hasQueuedForThread(threadId);
  }

  /** Returns pause reason when paused; otherwise undefined. */
  getPauseReason(threadId: string, catId?: string): 'canceled' | 'failed' | undefined {
    if (!this.isPaused(threadId, catId)) return undefined;
    if (catId) {
      return this.pausedSlots.get(QueueProcessor.slotKey(threadId, catId));
    }
    // Backward compat: return first paused slot's reason
    for (const [key, reason] of this.pausedSlots.entries()) {
      if (key.startsWith(`${threadId}:`)) return reason;
    }
    return undefined;
  }

  /**
   * System-level entry: called when an invocation completes.
   * F108: Now slot-aware — catId identifies which slot completed.
   * - succeeded → auto-dequeue oldest across users
   * - canceled/failed → pause slot, notify relevant users
   */
  async onInvocationComplete(
    threadId: string,
    catId: string,
    status: 'succeeded' | 'failed' | 'canceled',
  ): Promise<void> {
    const sk = QueueProcessor.slotKey(threadId, catId);
    if (status === 'succeeded') {
      this.pausedSlots.delete(sk);
      // Auto-dequeue: pick oldest entry across all users
      if (this.deps.queue.hasQueuedForThread(threadId)) {
        await this.tryExecuteNextAcrossUsers(threadId, catId);
      }
    } else {
      // canceled or failed → pause ONLY if there are queued entries to manage.
      if (!this.deps.queue.hasQueuedForThread(threadId)) {
        this.pausedSlots.delete(sk);
        return;
      }
      this.pausedSlots.set(sk, status);
      this.emitPausedToQueuedUsers(threadId, status);
    }
  }

  /**
   * Preemptively clear paused state for a slot.
   * Used by force-send: the old invocation's async cleanup will call
   * onInvocationComplete('canceled'/'failed') which pauses the slot,
   * but force-send already starts a new invocation — the pause is stale.
   */
  clearPause(threadId: string, catId?: string): void {
    if (catId) {
      this.pausedSlots.delete(QueueProcessor.slotKey(threadId, catId));
    } else {
      // Backward compat: clear all paused slots for this thread
      for (const key of [...this.pausedSlots.keys()]) {
        if (key.startsWith(`${threadId}:`)) this.pausedSlots.delete(key);
      }
    }
  }

  /**
   * F108: Force-release the per-slot mutex.
   *
   * Used by queue steer immediate: we cancel the current invocation, but the
   * old queue execution's `.then()` cleanup that deletes the mutex may not have
   * run yet. Releasing early avoids a user-visible false 409 ("queue busy").
   *
   * Idempotent: repeated deletes are safe.
   */
  releaseSlot(threadId: string, catId: string): void {
    this.processingSlots.delete(QueueProcessor.slotKey(threadId, catId));
  }

  /**
   * @deprecated Use releaseSlot(threadId, catId) instead. Kept for backward compat during migration.
   */
  releaseThread(threadId: string): void {
    for (const key of [...this.processingSlots.keys()]) {
      if (key.startsWith(`${threadId}:`)) this.processingSlots.delete(key);
    }
  }

  /**
   * User-level entry: 铲屎官 manually triggers processing their next entry.
   */
  async processNext(threadId: string, userId: string): Promise<{ started: boolean; entry?: QueueEntry }> {
    // Clear all paused slots for this thread (manual resume clears all)
    this.clearPause(threadId);
    return this.tryExecuteNextForUser(threadId, userId);
  }

  /**
   * F122B: Try to auto-execute any queued autoExecute entries whose target cat slot is free.
   * Called immediately after enqueuing an agent entry.
   * Scans past busy-slot entries to find the first executable one.
   */
  async tryAutoExecute(threadId: string): Promise<void> {
    const entries = this.deps.queue.listAutoExecute?.(threadId) ?? [];

    for (const entry of entries) {
      const entryCat = entry.targetCats[0] ?? 'unknown';
      const sk = QueueProcessor.slotKey(threadId, entryCat);
      // Skip if slot is busy (mutex or tracker)
      if (this.processingSlots.has(sk)) continue;
      if (this.deps.invocationTracker.has(threadId, entryCat)) continue;

      // Mark processing and execute
      this.deps.queue.markProcessingById(threadId, entry.id);
      this.processingSlots.add(sk);
      void this.executeEntry(entry).then(
        (status) => {
          this.processingSlots.delete(sk);
          this.onInvocationComplete(threadId, entryCat, status).catch(() => {});
        },
        () => {
          this.processingSlots.delete(sk);
          this.onInvocationComplete(threadId, entryCat, 'failed').catch(() => {});
        },
      );
      return; // One per call — chained via onInvocationComplete
    }
  }

  // ── Internal ──

  private async tryExecuteNextAcrossUsers(
    threadId: string,
    catId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry }> {
    const sk = QueueProcessor.slotKey(threadId, catId);
    // Mutex check — per-slot
    if (this.processingSlots.has(sk)) {
      return { started: false };
    }

    const entry = this.deps.queue.markProcessingAcrossUsers(threadId);
    if (!entry) return { started: false };

    const entryCat = entry.targetCats[0] ?? catId;
    const entrySk = QueueProcessor.slotKey(threadId, entryCat);

    // F108 P1-2 fix: check the *entry's* cat slot, not just the completing cat's slot
    if (this.processingSlots.has(entrySk)) {
      this.deps.queue.rollbackProcessing(threadId, entry.id);
      return { started: false };
    }
    // Fix: skip if cat already has an active invocation via CLI/messages.ts (not in processingSlots).
    // Without this, the completion chain would start a duplicate executeEntry that preempts the
    // CLI's invocation (InvocationTracker.start aborts old controller + InvocationRegistry.create
    // overwrites latestByThreadCat), causing all subsequent CLI callbacks to return stale_ignored.
    if (this.deps.invocationTracker.has(threadId, entryCat)) {
      this.deps.queue.rollbackProcessing(threadId, entry.id);
      return { started: false };
    }

    this.processingSlots.add(entrySk);
    // Fire-and-forget execution — chain onInvocationComplete AFTER mutex release
    void this.executeEntry(entry).then(
      (status) => {
        this.processingSlots.delete(entrySk);
        this.onInvocationComplete(threadId, entryCat, status).catch(() => {});
      },
      () => {
        this.processingSlots.delete(entrySk);
        this.onInvocationComplete(threadId, entryCat, 'failed').catch(() => {});
      },
    );

    return { started: true, entry };
  }

  private async tryExecuteNextForUser(
    threadId: string,
    userId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry }> {
    // F108 P1-3 fix: peek at next entry's target cat to check slot mutex BEFORE marking processing.
    // This prevents entries from getting stuck as 'processing' when the slot is busy.
    const nextEntry = this.deps.queue.peekNextQueued(threadId, userId);
    if (!nextEntry) return { started: false };

    const entryCat = nextEntry.targetCats[0] ?? 'unknown';
    const sk = QueueProcessor.slotKey(threadId, entryCat);

    // Mutex check — per-slot (before mutating queue state)
    if (this.processingSlots.has(sk)) {
      return { started: false };
    }
    // Fix: skip if cat already has an active invocation via CLI/messages.ts (same guard as above)
    if (this.deps.invocationTracker.has(threadId, entryCat)) {
      return { started: false };
    }

    // Now safe to mark processing — slot is available
    const entry = this.deps.queue.markProcessing(threadId, userId);
    if (!entry) return { started: false };

    this.processingSlots.add(sk);
    // Fire-and-forget execution — chain onInvocationComplete AFTER mutex release
    void this.executeEntry(entry).then(
      (status) => {
        this.processingSlots.delete(sk);
        this.onInvocationComplete(threadId, entryCat, status).catch(() => {});
      },
      () => {
        this.processingSlots.delete(sk);
        this.onInvocationComplete(threadId, entryCat, 'failed').catch(() => {});
      },
    );

    return { started: true, entry };
  }

  /**
   * Execute a queue entry — mirrors messages.ts background invocation pipeline.
   * Creates InvocationRecord → tracker.start → route execution → complete → cleanup.
   * Returns final status for chain auto-dequeue (called by tryExecuteNext*).
   */
  private async executeEntry(entry: QueueEntry): Promise<'succeeded' | 'failed' | 'canceled'> {
    const { queue, invocationTracker, invocationRecordStore, router, socketManager, messageStore, log } = this.deps;
    const { threadId, userId, content, targetCats, intent, messageId } = entry;
    const primaryCat = targetCats[0] ?? 'unknown';

    let controller: AbortController | undefined;
    let invocationId: string | undefined;
    let finalStatus: 'succeeded' | 'failed' | 'canceled' = 'failed';
    let responseText = '';

    try {
      // 1. Create InvocationRecord
      const createResult = await invocationRecordStore.create({
        threadId,
        userId,
        targetCats,
        intent,
        idempotencyKey: `queue-${entry.id}`,
      });

      if (createResult.outcome === 'duplicate') {
        log.warn({ threadId, entryId: entry.id }, '[QueueProcessor] Duplicate invocation, skipping');
        finalStatus = 'succeeded';
        return 'succeeded';
      }
      invocationId = createResult.invocationId;

      // 2. Start tracking (slot key = primary target cat)
      controller = invocationTracker.start(threadId, primaryCat, userId, targetCats);

      // 3. Backfill message ID
      if (messageId) {
        await invocationRecordStore.update(invocationId, {
          userMessageId: messageId,
        });
      }

      // 4. Mark running
      await invocationRecordStore.update(invocationId, {
        status: 'running',
      });

      // 5. Broadcast invocation state for queued execution.
      socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', {
        threadId,
        mode: intent,
        targetCats,
        invocationId,
      });

      // 6. Emit queue_updated (processing)
      socketManager.emitToUser(userId, 'queue_updated', {
        threadId,
        queue: queue.list(threadId, userId),
        action: 'processing',
      });

      // F098-D: Mark queued messages as delivered (set deliveredAt = now)
      // F117: Collect full message objects for frontend bubble rendering
      const allMessageIds: string[] = [messageId ?? '', ...(entry.mergedMessageIds ?? [])].filter(Boolean);
      const deliveredNow = Date.now();
      const deliveredIds: string[] = [];
      const deliveredMessages: Array<{
        id: string;
        content: string;
        catId: string | null;
        timestamp: number;
        mentions: readonly string[];
        userId: string;
        contentBlocks?: readonly unknown[];
      }> = [];
      for (const mid of allMessageIds) {
        try {
          const result = await messageStore.markDelivered(mid, deliveredNow);
          if (result) {
            deliveredIds.push(mid);
            deliveredMessages.push({
              id: result.id,
              content: result.content,
              catId: result.catId,
              timestamp: result.timestamp,
              mentions: result.mentions,
              userId: result.userId,
              contentBlocks: result.contentBlocks,
            });
          }
        } catch {
          /* best-effort: delivery timestamp is non-critical */
        }
      }
      // Notify frontend only for successfully persisted IDs (cloud P2: avoid phantom timestamps)
      // F117: Include messages array so frontend can render user bubble on delivery
      if (deliveredIds.length > 0) {
        socketManager.emitToUser(userId, 'messages_delivered', {
          threadId,
          messageIds: deliveredIds,
          deliveredAt: deliveredNow,
          messages: deliveredMessages,
        });
      }

      // 7. Route execution
      const cursorBoundaries = new Map<string, string>();

      // F039 remaining: queued image messages must be visible to cats.
      // Aggregate contentBlocks from the stored user messages (messageId + merged).
      const messageIds: string[] = [messageId ?? '', ...(entry.mergedMessageIds ?? [])].filter(Boolean);
      const contentBlocks: unknown[] = [];
      for (const id of messageIds) {
        try {
          const stored = await messageStore.getById(id);
          if (stored?.contentBlocks && stored.contentBlocks.length > 0) {
            contentBlocks.push(...stored.contentBlocks);
          }
        } catch (err) {
          log.warn(
            { threadId, entryId: entry.id, messageId: id, err },
            '[QueueProcessor] messageStore.getById failed, degrading to text-only execution',
          );
        }
      }

      // F122B B6: Collect response text for completion hook (multi-mention aggregation).
      const hook = this.entryCompleteHooks.get(entry.id);

      for await (const msg of router.routeExecution(
        userId,
        content,
        threadId,
        messageId,
        targetCats,
        { intent },
        {
          ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
          ...(controller.signal ? { signal: controller.signal } : {}),
          queueHasQueuedMessages: (tid: string) => queue.hasQueuedForThread(tid),
          cursorBoundaries,
          ...(invocationId ? { parentInvocationId: invocationId } : {}),
        },
      )) {
        if (hook && msg.catId === primaryCat && msg.type === 'text' && (msg as { content?: string }).content) {
          responseText += (msg as { content?: string }).content;
        }
        socketManager.broadcastAgentMessage({ ...msg, ...(invocationId ? { invocationId } : {}) }, threadId);
      }

      // 8. Check abort before marking succeeded (F122B B6 P1: abort→succeeded bug fix)
      if (controller.signal.aborted) {
        log.info({ threadId, entryId: entry.id }, '[QueueProcessor] Entry aborted during execution');
        await invocationRecordStore.update(invocationId, { status: 'canceled' });
        finalStatus = 'canceled';
        return 'canceled';
      }

      // 9. Ack cursors + mark succeeded
      await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
      await invocationRecordStore.update(invocationId, {
        status: 'succeeded',
      });

      finalStatus = 'succeeded';
      return 'succeeded';
    } catch (err) {
      log.error({ threadId, entryId: entry.id, err }, '[QueueProcessor] executeEntry failed');
      const errMsg = err instanceof Error ? err.message : String(err);
      // Best-effort: mark record failed + broadcast error
      try {
        if (invocationId) {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: errMsg,
          });
        }
        socketManager.broadcastAgentMessage(
          {
            type: 'error',
            catId: targetCats[0] ?? 'system',
            error: errMsg,
            isFinal: true,
            timestamp: Date.now(),
          },
          threadId,
        );
      } catch {
        /* ignore secondary errors */
      }

      return 'failed';
    } finally {
      // Always cleanup tracker + queue
      invocationTracker.complete(threadId, primaryCat, controller);
      queue.removeProcessedAcrossUsers(threadId, entry.id);
      // F122B B6: Fire completion hook (one-shot) and clean up
      const completeHook = this.entryCompleteHooks.get(entry.id);
      if (completeHook) {
        this.entryCompleteHooks.delete(entry.id);
        try {
          completeHook(entry.id, finalStatus, responseText);
        } catch {
          /* best-effort: hook errors must not break queue chain */
        }
      }
      // Chain auto-dequeue is handled by tryExecuteNext* (calls onInvocationComplete
      // AFTER releasing processingThreads mutex to avoid self-blocking).
    }
  }

  /** Emit queue_paused to each user who has queued entries for this thread. */
  private emitPausedToQueuedUsers(threadId: string, reason: 'canceled' | 'failed'): void {
    const users = this.deps.queue.listUsersForThread(threadId);
    for (const userId of users) {
      const userQueue = this.deps.queue.list(threadId, userId);
      if (!userQueue.some((e) => e.status === 'queued')) continue;
      this.deps.socketManager.emitToUser(userId, 'queue_paused', {
        threadId,
        reason,
        queue: userQueue,
      });
    }
  }
}
