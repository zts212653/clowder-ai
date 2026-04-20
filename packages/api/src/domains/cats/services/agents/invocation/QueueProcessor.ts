/**
 * QueueProcessor
 * 处理 InvocationQueue 中的排队条目：自动出队 + 暂停管理。
 *
 * 两个入口：
 * - onInvocationComplete（系统级）：invocation 完成后调用，succeeded 时自动出队
 * - processNext（用户级）：铲屎官手动触发处理自己的下一条
 */

import { resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';

/** Minimal interfaces for deps — avoid importing full types for testability */

interface TrackerLike {
  start(threadId: string, catId: string, userId: string, catIds?: string[]): AbortController;
  startAll(threadId: string, catIds: string[], userId?: string): AbortController;
  complete(threadId: string, catId: string, controller?: AbortController): void;
  completeSlot?(threadId: string, catId: string, controller?: AbortController): void;
  completeAll(threadId: string, catIds: string[], controller?: AbortController): void;
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

/** Minimal outbound delivery interface — avoids importing full OutboundDeliveryHook. */
export interface OutboundDeliveryHookLike {
  deliver(
    threadId: string,
    content: string,
    catId: string,
    richBlocks?: ReadonlyArray<{ kind: string; [key: string]: unknown }>,
    threadMeta?: { threadShortId?: string; threadTitle?: string; deepLinkUrl?: string },
    origin?: string,
    triggerMessageId?: string,
  ): Promise<void>;
}

/** Minimal streaming outbound interface — avoids importing full StreamingOutboundHook. */
export interface StreamingOutboundHookLike {
  onStreamStart(
    threadId: string,
    catId: string,
    invocationId: string,
    senderHint?: { id: string; name?: string },
  ): Promise<void>;
  onStreamChunk(threadId: string, accumulatedText: string, invocationId: string): Promise<void>;
  onStreamEnd(threadId: string, finalText: string, invocationId: string): Promise<void>;
  cleanupPlaceholders?(threadId: string, invocationId: string): Promise<void>;
  /** F151: Signal adapters that delivery batch is complete for a thread. */
  notifyDeliveryBatchDone?(threadId: string, chainDone: boolean): Promise<void>;
}

/** Thread metadata for outbound delivery (deep link, title, etc.) */
interface ThreadMetaLike {
  threadShortId?: string;
  threadTitle?: string;
  deepLinkUrl?: string;
}

export interface QueueProcessorDeps {
  queue: InvocationQueue;
  invocationTracker: TrackerLike;
  invocationRecordStore: InvocationRecordStoreLike;
  router: RouterLike;
  socketManager: SocketManagerLike;
  messageStore: IMessageStore;
  log: LoggerLike;
  /** F088 fix: optional outbound delivery hook (late-bound after gateway bootstrap). */
  outboundHook?: OutboundDeliveryHookLike;
  /** F088 fix: optional streaming outbound hook (late-bound after gateway bootstrap). */
  streamingHook?: StreamingOutboundHookLike;
  /** F088 fix: optional thread metadata lookup for outbound delivery. */
  threadMetaLookup?: (threadId: string) => ThreadMetaLike | undefined | Promise<ThreadMetaLike | undefined>;
}

/** F122B B6: Completion hook — called when a queue entry finishes execution. */
export type EntryCompleteHook = (
  entryId: string,
  status: 'succeeded' | 'failed' | 'canceled',
  responseText: string,
) => void;

export class QueueProcessor {
  private deps: QueueProcessorDeps;
  /** F108: Per-slot mutex — prevents concurrent double-start per (thread, cat) pair.
   *  F118 D4: Map value = processingStartedAt for zombie detection. */
  private processingSlots = new Map<string, number>();
  /** F108: Per-slot pause tracking (set on canceled/failed, cleared on next execution) */
  private pausedSlots = new Map<string, 'canceled' | 'failed'>();
  /** F122B B6: Per-entry completion hooks (for multi-mention response aggregation). */
  private entryCompleteHooks = new Map<string, EntryCompleteHook>();
  /** F118 D4: max age before a processingSlot is considered zombie (default 2.5× CLI timeout = 75min) */
  private processingSlotTtlMs: number;

  constructor(deps: QueueProcessorDeps, opts?: { processingSlotTtlMs?: number }) {
    this.deps = deps;
    this.processingSlotTtlMs = opts?.processingSlotTtlMs ?? 2.5 * resolveCliTimeoutMs(undefined);
  }

  /** F088 fix: Late-bind outbound hook (set after gateway bootstrap). */
  setOutboundHook(hook: OutboundDeliveryHookLike): void {
    (this.deps as { outboundHook?: OutboundDeliveryHookLike }).outboundHook = hook;
  }

  /** F088 fix: Late-bind streaming hook (set after gateway bootstrap). */
  setStreamingHook(hook: StreamingOutboundHookLike): void {
    (this.deps as { streamingHook?: StreamingOutboundHookLike }).streamingHook = hook;
  }

  /** F088 fix: Late-bind threadMetaLookup (set after gateway bootstrap). */
  setThreadMetaLookup(
    lookup: (threadId: string) => ThreadMetaLike | undefined | Promise<ThreadMetaLike | undefined>,
  ): void {
    (this.deps as { threadMetaLookup?: typeof lookup }).threadMetaLookup = lookup;
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

  /**
   * F118 D4: Sweep zombie processingSlots.
   * A slot is zombie when: age > TTL AND invocationTracker has no active slot for the same key.
   * The tracker check prevents false-positive cleanup of genuinely slow invocations.
   */
  private sweepZombieSlots(threadId: string): void {
    const prefix = `${threadId}:`;
    const now = Date.now();
    const ttl = this.processingSlotTtlMs;
    for (const [key, startedAt] of this.processingSlots) {
      if (!key.startsWith(prefix)) continue;
      if (now - startedAt <= ttl) continue;
      // Only release if tracker also has no active invocation — double-confirm zombie
      const parts = key.split(':');
      const catId = parts.slice(1).join(':');
      if (!this.deps.invocationTracker.has(threadId, catId)) {
        this.processingSlots.delete(key);
        this.deps.log.warn({ threadId, catId, ageMs: now - startedAt }, '[F118 D4] zombie processingSlot released');
      }
    }
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

  /** A2A fairness gate: only user-sourced entries should block text-scan A2A. */
  hasQueuedUserMessagesForThread(threadId: string): boolean {
    return this.deps.queue.hasQueuedUserMessagesForThread(threadId);
  }

  /** A2A dedup: check if a specific cat already has a queued or processing entry for this thread. */
  hasQueuedAgentForCat(threadId: string, catId: string): boolean {
    return this.deps.queue.hasQueuedAgentForCat(threadId, catId);
  }

  hasActiveOrQueuedAgentForCat(threadId: string, catId: string): boolean {
    return this.deps.queue.hasActiveOrQueuedAgentForCat(threadId, catId);
  }

  /** F151: Check if thread has any queued or processing entries (used by delivery-batch-done signal). */
  isThreadBusy(threadId: string): boolean {
    if (this.deps.queue.hasQueuedForThread(threadId)) return true;
    const prefix = `${threadId}:`;
    for (const key of this.processingSlots.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** F151: Signal streaming adapters that delivery is done for this thread invocation.
   *  Fires on both success AND failure — failed invocations must close the task
   *  immediately instead of waiting for TASK_TIMEOUT_MS (P2-1 review fix). */
  private signalDeliveryBatchDone(threadId: string, _status: string): void {
    if (!this.deps.streamingHook?.notifyDeliveryBatchDone) return;
    const threadStillBusy = this.deps.invocationTracker.has(threadId) || this.isThreadBusy(threadId);
    this.deps.streamingHook.notifyDeliveryBatchDone(threadId, !threadStillBusy).catch((err) => {
      this.deps.log.warn({ err, threadId }, '[QueueProcessor] notifyDeliveryBatchDone failed');
    });
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
      if (this.deps.queue.hasQueuedForThread(threadId)) {
        await this.tryExecuteNextAcrossUsers(threadId, catId);
        await this.tryAutoExecute(threadId);
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
   * Scans all entries and starts every one whose cat slot is free (parallel multi-cat).
   * Per-cat slot mutex (processingSlots + invocationTracker) prevents conflicts.
   */
  async tryAutoExecute(threadId: string): Promise<void> {
    this.sweepZombieSlots(threadId);
    const entries = (this.deps.queue.listAutoExecute?.(threadId) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    if (entries.length > 0) {
      const now = Date.now();
      this.deps.log.info(
        {
          threadId,
          entryCount: entries.length,
          entries: entries.map((entry) => ({
            id: entry.id,
            targetCat: entry.targetCats[0] ?? 'unknown',
            createdAt: entry.createdAt,
            ageMs: now - entry.createdAt,
          })),
        },
        '[DIAG/a2a] tryAutoExecute candidate scan',
      );
    }

    for (const entry of entries) {
      const entryCat = entry.targetCats[0] ?? 'unknown';
      const sk = QueueProcessor.slotKey(threadId, entryCat);
      // Skip if slot is busy (mutex or tracker)
      if (this.processingSlots.has(sk)) continue;
      if (this.deps.invocationTracker.has(threadId, entryCat)) continue;

      // Guard: markProcessingById may fail if entry was consumed between snapshot and now
      if (!this.deps.queue.markProcessingById(threadId, entry.id)) continue;
      this.processingSlots.set(sk, Date.now());
      void this.executeEntry(entry).then(
        (status) => {
          this.processingSlots.delete(sk);
          this.onInvocationComplete(threadId, entryCat, status).catch(() => {});
          this.signalDeliveryBatchDone(threadId, status);
        },
        () => {
          this.processingSlots.delete(sk);
          this.onInvocationComplete(threadId, entryCat, 'failed').catch(() => {});
          this.signalDeliveryBatchDone(threadId, 'failed');
        },
      );
      // Continue scanning — start all entries with free cat slots (parallel dispatch)
    }
  }

  // ── Internal ──

  private async tryExecuteNextAcrossUsers(
    threadId: string,
    catId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry }> {
    this.sweepZombieSlots(threadId);
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

    this.processingSlots.set(entrySk, Date.now());
    // Fire-and-forget execution — chain onInvocationComplete AFTER mutex release
    void this.executeEntry(entry).then(
      (status) => {
        this.processingSlots.delete(entrySk);
        this.onInvocationComplete(threadId, entryCat, status).catch(() => {});
        this.signalDeliveryBatchDone(threadId, status);
      },
      () => {
        this.processingSlots.delete(entrySk);
        this.onInvocationComplete(threadId, entryCat, 'failed').catch(() => {});
        this.signalDeliveryBatchDone(threadId, 'failed');
      },
    );

    return { started: true, entry };
  }

  private async tryExecuteNextForUser(
    threadId: string,
    userId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry }> {
    this.sweepZombieSlots(threadId);
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

    this.processingSlots.set(sk, Date.now());
    // Fire-and-forget execution — chain onInvocationComplete AFTER mutex release
    void this.executeEntry(entry).then(
      (status) => {
        this.processingSlots.delete(sk);
        this.onInvocationComplete(threadId, entryCat, status).catch(() => {});
        this.signalDeliveryBatchDone(threadId, status);
      },
      () => {
        this.processingSlots.delete(sk);
        this.onInvocationComplete(threadId, entryCat, 'failed').catch(() => {});
        this.signalDeliveryBatchDone(threadId, 'failed');
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
    const cursorBoundaries = new Map<string, string>();

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

      // 2. Start tracking ALL target cats (shared controller for F5/reconnect recovery)
      controller = invocationTracker.startAll(threadId, targetCats, userId);

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

      // 5. intent_mode deferred to first CLI event (#768: avoid "replying" when CLI never starts)
      let intentModeBroadcast = false;

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
      const persistenceContext: { richBlocks?: Array<{ kind: string; [key: string]: unknown }> } = {};
      const collectedTextParts: string[] = [];

      // F088 fix: Track per-turn content for outbound delivery (same pattern as ConnectorInvokeTrigger)
      const outboundTurns: Array<{
        catId: string;
        textParts: string[];
        richBlocks?: Array<{ kind: string; [key: string]: unknown }>;
      }> = [];
      let currentTurnCatId: string | undefined;

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

      // F088 fix: start streaming placeholder on external platforms
      let streamStartPromise: Promise<void> | undefined;
      if (this.deps.streamingHook) {
        streamStartPromise = this.deps.streamingHook
          .onStreamStart(threadId, primaryCat, invocationId, entry.senderMeta)
          .catch((err) => {
            log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamStart failed');
          });
      }

      // F151: Mid-loop delivery to preserve ordering (same fix as ConnectorInvokeTrigger)
      const deliveredTurnIndices = new Set<number>();
      const DELIVER_TIMEOUT_MS = 10_000;
      let threadMeta: ThreadMetaLike | undefined;
      let threadMetaPromise: Promise<ThreadMetaLike | undefined> | undefined;
      if (this.deps.outboundHook && this.deps.threadMetaLookup) {
        const rawResult = this.deps.threadMetaLookup(threadId);
        if (rawResult) {
          const LOOKUP_TIMEOUT_MS = 2000;
          threadMetaPromise = Promise.race([
            Promise.resolve(rawResult).catch((err: unknown) => {
              log.warn({ err, threadId }, '[QueueProcessor] threadMetaLookup late rejection');
              return undefined;
            }),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS)),
          ]);
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
          queueHasQueuedMessages: (tid: string) => queue.hasQueuedUserMessagesForThread(tid),
          hasQueuedOrActiveAgentForCat: (tid: string, catId: string) => queue.hasActiveOrQueuedAgentForCat(tid, catId),
          cursorBoundaries,
          persistenceContext,
          ...(invocationId ? { parentInvocationId: invocationId } : {}),
        },
      )) {
        // #768: Broadcast intent_mode on first CLI event — proves CLI is alive.
        if (!intentModeBroadcast) {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', {
            threadId,
            mode: intent,
            targetCats,
            invocationId,
          });
          intentModeBroadcast = true;
        }
        if (hook && msg.catId === primaryCat && msg.type === 'text' && (msg as { content?: string }).content) {
          responseText += (msg as { content?: string }).content;
        }
        if ((msg.type === 'done' || msg.type === 'error') && msg.catId) {
          invocationTracker.completeSlot?.(threadId, msg.catId, controller);
        }

        // F088 fix: collect per-turn content for outbound delivery
        if (msg.type === 'done' && msg.catId) {
          if (persistenceContext.richBlocks) {
            const turn = outboundTurns[outboundTurns.length - 1];
            if (turn && turn.catId === msg.catId && currentTurnCatId === msg.catId) {
              turn.richBlocks = [...persistenceContext.richBlocks];
            } else {
              outboundTurns.push({ catId: msg.catId, textParts: [], richBlocks: [...persistenceContext.richBlocks] });
            }
            persistenceContext.richBlocks = undefined;
          }
          currentTurnCatId = undefined;
          // F151: Deliver completed cat's turns immediately (same fix as ConnectorInvokeTrigger)
          if (this.deps.outboundHook) {
            if (threadMetaPromise) {
              threadMeta = await threadMetaPromise;
              threadMetaPromise = undefined;
            }
            for (let i = 0; i < outboundTurns.length; i++) {
              if (deliveredTurnIndices.has(i)) continue;
              const turn = outboundTurns[i];
              if (turn.catId !== msg.catId) continue;
              const turnContent = turn.textParts.join('');
              if (!turnContent && !turn.richBlocks?.length) continue;
              try {
                await Promise.race([
                  this.deps.outboundHook.deliver(
                    threadId,
                    turnContent,
                    turn.catId,
                    turn.richBlocks,
                    threadMeta,
                    undefined,
                    messageId ?? undefined,
                  ),
                  new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
                  ),
                ]);
                deliveredTurnIndices.add(i);
              } catch (err) {
                log.error(
                  { err, threadId, catId: turn.catId },
                  '[QueueProcessor] Mid-loop delivery failed, will retry in final phase',
                );
              }
            }
          }
        }
        if (msg.type === 'text' && typeof (msg as Record<string, unknown>).content === 'string') {
          const textContent = (msg as Record<string, unknown>).content as string;
          collectedTextParts.push(textContent);
          if (msg.catId) {
            if (msg.catId !== currentTurnCatId) {
              outboundTurns.push({ catId: msg.catId, textParts: [] });
              currentTurnCatId = msg.catId;
            }
            outboundTurns[outboundTurns.length - 1].textParts.push(textContent);
          }
          if (this.deps.streamingHook) {
            const accumulated = collectedTextParts.join('');
            this.deps.streamingHook.onStreamChunk(threadId, accumulated, invocationId).catch((err) => {
              log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamChunk failed');
            });
          }
        }

        socketManager.broadcastAgentMessage({ ...msg, ...(invocationId ? { invocationId } : {}) }, threadId);
      }

      // 8. Check abort before marking succeeded (F122B B6 P1: abort→succeeded bug fix)
      if (controller.signal.aborted) {
        log.info({ threadId, entryId: entry.id }, '[QueueProcessor] Entry aborted during execution');
        // F148 fix: ack cursors for cats that completed before abort (monotonic CAS, safe to call)
        if (cursorBoundaries.size > 0) {
          await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
        }
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

      // 10. Outbound delivery: send remaining per-turn content to bound external chats
      await this.deliverOutbound(
        threadId,
        primaryCat,
        invocationId!,
        collectedTextParts,
        outboundTurns,
        persistenceContext,
        streamStartPromise,
        log,
        messageId ?? undefined,
        deliveredTurnIndices,
        threadMeta,
      );

      return 'succeeded';
    } catch (err) {
      log.error({ threadId, entryId: entry.id, err }, '[QueueProcessor] executeEntry failed');
      // F148 fix: ack cursors for cats that completed before the exception
      if (cursorBoundaries.size > 0) {
        try {
          await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
        } catch {
          /* best-effort — don't mask the original error */
        }
      }
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
      // Always cleanup tracker + queue (all target cat slots)
      invocationTracker.completeAll(threadId, targetCats, controller);
      queue.removeProcessedAcrossUsers(threadId, entry.id);
      socketManager.emitToUser(userId, 'queue_updated', {
        threadId,
        queue: queue.list(threadId, userId),
        action: 'completed',
      });
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

  /**
   * F088 fix: Deliver collected outbound turns to bound external chats.
   * Mirrors ConnectorInvokeTrigger ⑥ logic: per-turn delivery, streaming cleanup, late-success fallback.
   */
  private async deliverOutbound(
    threadId: string,
    primaryCat: string,
    invocationId: string,
    collectedTextParts: string[],
    outboundTurns: Array<{
      catId: string;
      textParts: string[];
      richBlocks?: Array<{ kind: string; [key: string]: unknown }>;
    }>,
    persistenceContext: { richBlocks?: Array<{ kind: string; [key: string]: unknown }> },
    streamStartPromise: Promise<void> | undefined,
    log: LoggerLike,
    triggerMessageId?: string,
    deliveredTurnIndices?: Set<number>,
    preResolvedMeta?: ThreadMetaLike | undefined,
  ): Promise<void> {
    const finalContent = collectedTextParts.join('');

    // Finalize streaming — ensure start completed before ending
    if (this.deps.streamingHook) {
      if (streamStartPromise) {
        const STREAM_START_TIMEOUT_MS = 5000;
        await Promise.race([
          streamStartPromise,
          new Promise<void>((resolve) => setTimeout(resolve, STREAM_START_TIMEOUT_MS)),
        ]);
      }
      await this.deps.streamingHook.onStreamEnd(threadId, finalContent, invocationId).catch((err) => {
        log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamEnd failed');
      });
    }

    const hasContent = collectedTextParts.length > 0 || outboundTurns.length > 0;
    if (this.deps.outboundHook && hasContent) {
      // F151: Use pre-resolved threadMeta from mid-loop delivery, or do fresh lookup
      let threadMeta: ThreadMetaLike | undefined = preResolvedMeta;
      if (threadMeta === undefined && !(deliveredTurnIndices && deliveredTurnIndices.size > 0)) {
        try {
          const LOOKUP_TIMEOUT_MS = 2000;
          const rawResult = this.deps.threadMetaLookup?.(threadId);
          if (rawResult) {
            const lookupPromise = Promise.resolve(rawResult).catch((err: unknown) => {
              log.warn({ err, threadId }, '[QueueProcessor] threadMetaLookup late rejection');
              return undefined;
            });
            const timeout = new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS),
            );
            threadMeta = await Promise.race([lookupPromise, timeout]);
          }
        } catch (lookupErr) {
          log.warn({ err: lookupErr, threadId }, '[QueueProcessor] threadMetaLookup failed');
        }
      }

      const DELIVER_TIMEOUT_MS = 10_000;
      // F151: skip turns already delivered mid-loop
      const nonEmptyTurns = outboundTurns.filter(
        (t, i) =>
          !(deliveredTurnIndices && deliveredTurnIndices.has(i)) &&
          (t.textParts.length > 0 || (t.richBlocks && t.richBlocks.length > 0)),
      );

      let deliveryFailed = false;
      const inflightDeliverPromises: Promise<void>[] = [];

      // BUG-5 (2026-03-25): iLink context_token is reusable — SINGLE_TOKEN_CONNECTORS
      // merge logic removed. Each turn now delivers independently for all connectors.
      if (nonEmptyTurns.length > 1) {
        for (const turn of nonEmptyTurns) {
          const turnContent = turn.textParts.join('');
          const deliverPromise = this.deps.outboundHook.deliver(
            threadId,
            turnContent,
            turn.catId,
            turn.richBlocks,
            threadMeta,
            undefined,
            triggerMessageId,
          );
          inflightDeliverPromises.push(deliverPromise);
          try {
            await Promise.race([
              deliverPromise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
              ),
            ]);
          } catch (err) {
            deliveryFailed = true;
            log.error({ err, threadId, catId: turn.catId }, '[QueueProcessor] Outbound delivery error');
          }
        }
      } else if (nonEmptyTurns.length === 1) {
        const turn = nonEmptyTurns[0];
        const richBlocks = persistenceContext.richBlocks ?? turn.richBlocks;
        const deliverPromise = this.deps.outboundHook.deliver(
          threadId,
          finalContent,
          turn.catId,
          richBlocks,
          threadMeta,
          undefined,
          triggerMessageId,
        );
        inflightDeliverPromises.push(deliverPromise);
        try {
          await Promise.race([
            deliverPromise,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
            ),
          ]);
        } catch (err) {
          deliveryFailed = true;
          log.error({ err, threadId }, '[QueueProcessor] Outbound delivery error');
        }
      } else if (!(deliveredTurnIndices && deliveredTurnIndices.size > 0)) {
        // Fallback: no per-turn delivery happened — deliver remaining content as one
        const richBlocks = persistenceContext.richBlocks;
        if (richBlocks) {
          const deliverPromise = this.deps.outboundHook.deliver(
            threadId,
            finalContent,
            primaryCat,
            richBlocks,
            threadMeta,
            undefined,
            triggerMessageId,
          );
          inflightDeliverPromises.push(deliverPromise);
          try {
            await Promise.race([
              deliverPromise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
              ),
            ]);
          } catch (err) {
            deliveryFailed = true;
            log.error({ err, threadId }, '[QueueProcessor] Outbound delivery error');
          }
        }
      }

      if (!deliveryFailed && this.deps.streamingHook?.cleanupPlaceholders) {
        await this.deps.streamingHook.cleanupPlaceholders(threadId, invocationId).catch((err) => {
          log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.cleanupPlaceholders failed');
        });
      } else if (deliveryFailed && this.deps.streamingHook?.cleanupPlaceholders) {
        const cleanupFn = this.deps.streamingHook.cleanupPlaceholders.bind(this.deps.streamingHook);
        Promise.allSettled(inflightDeliverPromises).then((results) => {
          if (results.every((r) => r.status === 'fulfilled')) {
            cleanupFn(threadId, invocationId).catch((err) => {
              log.warn({ err, threadId }, '[QueueProcessor] Late-success placeholder cleanup failed');
            });
          }
        });
      }
    } else if (this.deps.streamingHook?.cleanupPlaceholders) {
      await this.deps.streamingHook.cleanupPlaceholders(threadId, invocationId).catch((err) => {
        log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.cleanupPlaceholders failed (silent)');
      });
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
