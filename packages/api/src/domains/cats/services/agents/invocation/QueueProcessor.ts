/**
 * QueueProcessor
 * 处理 InvocationQueue 中的排队条目：自动出队 + 暂停管理。
 *
 * 两个入口：
 * - onInvocationComplete（系统级）：invocation 完成后调用，succeeded 时自动出队
 * - processNext（用户级）：team lead手动触发处理自己的下一条
 */

import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';

/** Minimal interfaces for deps — avoid importing full types for testability */

interface TrackerLike {
  start(threadId: string, userId: string, catIds: string[]): AbortController;
  complete(threadId: string, controller?: AbortController): void;
  has(threadId: string): boolean;
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

export class QueueProcessor {
  private deps: QueueProcessorDeps;
  /** Per-thread mutex — prevents concurrent double-start */
  private processingThreads = new Set<string>();
  /** Tracks paused threads (set on canceled/failed, cleared on next execution) */
  private pausedThreads = new Map<string, 'canceled' | 'failed'>();

  constructor(deps: QueueProcessorDeps) {
    this.deps = deps;
  }

  /** Check if a thread's queue is paused (canceled/failed AND has queued entries). */
  isPaused(threadId: string): boolean {
    return this.pausedThreads.has(threadId) && this.deps.queue.hasQueuedForThread(threadId);
  }

  /** Expose queued-state for route fairness decisions in non-queue entry paths (retry/connector). */
  hasQueuedForThread(threadId: string): boolean {
    return this.deps.queue.hasQueuedForThread(threadId);
  }

  /** Returns pause reason when paused; otherwise undefined. */
  getPauseReason(threadId: string): 'canceled' | 'failed' | undefined {
    if (!this.isPaused(threadId)) return undefined;
    return this.pausedThreads.get(threadId);
  }

  /**
   * System-level entry: called when an invocation completes.
   * - succeeded → auto-dequeue oldest across users
   * - canceled/failed → pause, notify relevant users
   */
  async onInvocationComplete(threadId: string, status: 'succeeded' | 'failed' | 'canceled'): Promise<void> {
    if (status === 'succeeded') {
      this.pausedThreads.delete(threadId);
      // Auto-dequeue: pick oldest entry across all users
      if (this.deps.queue.hasQueuedForThread(threadId)) {
        await this.tryExecuteNextAcrossUsers(threadId);
      }
    } else {
      // canceled or failed → pause ONLY if there are queued entries to manage.
      // (Processing-only queue should not be "paused 0" — this is a common steer/force race.)
      if (!this.deps.queue.hasQueuedForThread(threadId)) {
        this.pausedThreads.delete(threadId);
        return;
      }
      this.pausedThreads.set(threadId, status);
      this.emitPausedToQueuedUsers(threadId, status);
    }
  }

  /**
   * Preemptively clear paused state for a thread.
   * Used by force-send: the old invocation's async cleanup will call
   * onInvocationComplete('canceled'/'failed') which pauses the thread,
   * but force-send already starts a new invocation — the pause is stale.
   */
  clearPause(threadId: string): void {
    this.pausedThreads.delete(threadId);
  }

  /**
   * Force-release the per-thread mutex.
   *
   * Used by queue steer immediate: we cancel the current invocation, but the
   * old queue execution's `.then()` cleanup that deletes the mutex may not have
   * run yet. Releasing early avoids a user-visible false 409 ("queue busy").
   *
   * Idempotent: repeated deletes are safe.
   */
  releaseThread(threadId: string): void {
    this.processingThreads.delete(threadId);
  }

  /**
   * User-level entry: team lead manually triggers processing their next entry.
   */
  async processNext(threadId: string, userId: string): Promise<{ started: boolean; entry?: QueueEntry }> {
    this.pausedThreads.delete(threadId);
    return this.tryExecuteNextForUser(threadId, userId);
  }

  // ── Internal ──

  private async tryExecuteNextAcrossUsers(threadId: string): Promise<{ started: boolean; entry?: QueueEntry }> {
    // Mutex check
    if (this.processingThreads.has(threadId)) {
      return { started: false };
    }

    const entry = this.deps.queue.markProcessingAcrossUsers(threadId);
    if (!entry) return { started: false };

    this.processingThreads.add(threadId);
    // Fire-and-forget execution — chain onInvocationComplete AFTER mutex release
    void this.executeEntry(entry).then(
      (status) => {
        this.processingThreads.delete(threadId);
        this.onInvocationComplete(threadId, status).catch(() => {});
      },
      () => {
        this.processingThreads.delete(threadId);
        this.onInvocationComplete(threadId, 'failed').catch(() => {});
      },
    );

    return { started: true, entry };
  }

  private async tryExecuteNextForUser(
    threadId: string,
    userId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry }> {
    // Mutex check
    if (this.processingThreads.has(threadId)) {
      return { started: false };
    }

    const entry = this.deps.queue.markProcessing(threadId, userId);
    if (!entry) return { started: false };

    this.processingThreads.add(threadId);
    // Fire-and-forget execution — chain onInvocationComplete AFTER mutex release
    void this.executeEntry(entry).then(
      (status) => {
        this.processingThreads.delete(threadId);
        this.onInvocationComplete(threadId, status).catch(() => {});
      },
      () => {
        this.processingThreads.delete(threadId);
        this.onInvocationComplete(threadId, 'failed').catch(() => {});
      },
    );

    return { started: true, entry };
  }

  /**
   * Execute a queue entry — mirrors messages.ts background invocation pipeline.
   * Creates InvocationRecord → tracker.start → route execution → complete → cleanup.
   * Returns final status for chain auto-dequeue (called by tryExecuteNext*).
   */
  private async executeEntry(entry: QueueEntry): Promise<'succeeded' | 'failed'> {
    const { queue, invocationTracker, invocationRecordStore, router, socketManager, messageStore, log } = this.deps;
    const { threadId, userId, content, targetCats, intent, messageId } = entry;

    let controller: AbortController | undefined;
    let invocationId: string | undefined;

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
        return 'succeeded';
      }
      invocationId = createResult.invocationId;

      // 2. Start tracking
      controller = invocationTracker.start(threadId, userId, targetCats);

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

      // 5. Emit queue_updated (processing)
      socketManager.emitToUser(userId, 'queue_updated', {
        threadId,
        queue: queue.list(threadId, userId),
        action: 'processing',
      });

      // F098-D: Mark queued messages as delivered (set deliveredAt = now)
      const allMessageIds: string[] = [messageId ?? '', ...(entry.mergedMessageIds ?? [])].filter(Boolean);
      const deliveredNow = Date.now();
      const deliveredIds: string[] = [];
      for (const mid of allMessageIds) {
        try {
          const result = await messageStore.markDelivered(mid, deliveredNow);
          if (result) deliveredIds.push(mid);
        } catch {
          /* best-effort: delivery timestamp is non-critical */
        }
      }
      // Notify frontend only for successfully persisted IDs (cloud P2: avoid phantom timestamps)
      if (deliveredIds.length > 0) {
        socketManager.emitToUser(userId, 'messages_delivered', {
          threadId,
          messageIds: deliveredIds,
          deliveredAt: deliveredNow,
        });
      }

      // 6. Route execution
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
        },
      )) {
        socketManager.broadcastAgentMessage(msg, threadId);
      }

      // 7. Ack cursors + mark succeeded
      await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
      await invocationRecordStore.update(invocationId, {
        status: 'succeeded',
      });

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
      invocationTracker.complete(threadId, controller);
      queue.removeProcessedAcrossUsers(threadId, entry.id);
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
