/**
 * Connector Invoke Trigger
 * Programmatically triggers a cat invocation after a connector message is posted.
 *
 * Phase 3b: Closes the loop — review email → connector message → cat invocation.
 * Uses the same AgentRouter pipeline as POST /api/messages but triggered
 * by the email watcher instead of an HTTP request.
 *
 * BACKLOG #97 Phase 3b
 */

import type { CatId, MessageContent } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getDefaultCatId } from '../../config/cat-config-loader.js';
import type { InvocationQueue } from '../../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationTracker } from '../../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { QueueProcessor } from '../../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { AgentRouter } from '../../domains/cats/services/agents/routing/AgentRouter.js';
import type { PersistenceContext } from '../../domains/cats/services/agents/routing/route-helpers.js';
import type { IInvocationRecordStore } from '../../domains/cats/services/stores/ports/InvocationRecordStore.js';
import { mergeTokenUsage, type TokenUsage } from '../../domains/cats/services/types.js';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import { getMultiMentionOrchestrator } from '../../routes/callback-multi-mention-routes.js';
import type { OutboundDeliveryHook, ThreadMeta } from '../connectors/OutboundDeliveryHook.js';
import type { StreamingOutboundHook } from '../connectors/StreamingOutboundHook.js';

export interface ConnectorInvokeTriggerOptions {
  readonly router: AgentRouter;
  readonly socketManager: SocketManager;
  readonly invocationRecordStore: IInvocationRecordStore;
  readonly invocationTracker: InvocationTracker;
  readonly invocationQueue: InvocationQueue;
  readonly queueProcessor?: QueueProcessor;
  readonly outboundHook?: OutboundDeliveryHook;
  readonly streamingHook?: StreamingOutboundHook;
  readonly threadMetaLookup?: (threadId: string) => ThreadMeta | undefined | Promise<ThreadMeta | undefined>;
  /** Per-cat outbound deliver timeout in ms (default 10000). Prevents hanging deliver from blocking cleanup. */
  readonly deliverTimeoutMs?: number;
  readonly log: FastifyBaseLogger;
}

export interface ConnectorTriggerPolicy {
  /** urgent: preempt active invocation, normal: enqueue behind active work */
  readonly priority?: 'urgent' | 'normal';
  /** optional reason for diagnostics */
  readonly reason?: string;
}

/**
 * Fire-and-forget invocation trigger for connector messages.
 *
 * Flow:
 *   1. Create InvocationRecord (atomic)
 *   2. Start InvocationTracker
 *   3. Run routeExecution in background (fire-and-forget)
 *   4. Broadcast agent messages to WebSocket room
 *   5. Ack cursor boundaries + update status
 */
export class ConnectorInvokeTrigger {
  private readonly opts: ConnectorInvokeTriggerOptions;

  constructor(opts: ConnectorInvokeTriggerOptions) {
    this.opts = opts;
  }

  /** Late-bind outbound hook (set after gateway bootstrap) */
  setOutboundHook(hook: OutboundDeliveryHook): void {
    (this.opts as { outboundHook?: OutboundDeliveryHook }).outboundHook = hook;
  }

  /** Late-bind streaming hook (set after gateway bootstrap) */
  setStreamingHook(hook: StreamingOutboundHook): void {
    (this.opts as { streamingHook?: StreamingOutboundHook }).streamingHook = hook;
  }

  /**
   * Trigger a cat invocation for a connector message.
   * Returns immediately — execution happens in background.
   *
   * @param threadId  Thread where the connector message was posted
   * @param catId     Target cat to invoke
   * @param userId    User context for the invocation
   * @param message   The connector message content (used as invocation trigger)
   * @param messageId The stored connector message ID (for InvocationRecord backfill)
   */
  trigger(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    contentBlocks?: readonly MessageContent[],
    policy?: ConnectorTriggerPolicy,
    sender?: { id: string; name?: string },
  ): void {
    const { invocationTracker } = this.opts;
    const priority = policy?.priority ?? 'normal';

    // Urgent connector policy: preempt active invocation in the same thread.
    // Used for GitHub review comments so cats don't get stuck behind long queue chatter.
    if (priority === 'urgent' && invocationTracker.has(threadId, catId)) {
      this.handleUrgentTrigger(threadId, catId, userId, message, messageId, policy?.reason, sender).catch((err) => {
        this.opts.log.error(`[ConnectorInvokeTrigger] Unhandled: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }

    // Normal connector policy: if this cat is already running in this thread, enqueue.
    if (invocationTracker.has(threadId, catId)) {
      this.enqueueWhileActive(threadId, catId, userId, message, messageId, sender);
      return;
    }

    // No active invocation → direct execution (existing flow)
    this.executeInBackground(threadId, catId, userId, message, messageId, undefined, contentBlocks).catch((err) => {
      // Last-resort guard: prevent unhandledRejection from pre-try errors
      this.opts.log.error(`[ConnectorInvokeTrigger] Unhandled: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private enqueueWhileActive(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    sender?: { id: string; name?: string },
  ): 'full' | 'enqueued' | 'merged' {
    const { invocationQueue, socketManager, log } = this.opts;
    const result = invocationQueue.enqueue({
      threadId,
      userId,
      content: message,
      source: 'connector',
      targetCats: [catId],
      intent: 'execute',
      ...(sender ? { senderMeta: sender } : {}),
    });

    if (result.outcome === 'full') {
      socketManager.emitToUser(userId, 'queue_full_warning', {
        threadId,
        source: 'connector',
        queueSize: invocationQueue.size(threadId, userId),
        queue: invocationQueue.list(threadId, userId),
      });
      log.warn({ threadId, catId, userId }, '[ConnectorInvokeTrigger] Queue full, connector message not enqueued');
      return 'full';
    }

    if (result.entry) {
      if (result.outcome === 'enqueued') {
        invocationQueue.backfillMessageId(threadId, userId, result.entry.id, messageId);
      } else if (result.outcome === 'merged') {
        invocationQueue.appendMergedMessageId(threadId, userId, result.entry.id, messageId);
      }
    }

    socketManager.emitToUser(userId, 'queue_updated', {
      threadId,
      queue: invocationQueue.list(threadId, userId),
      action: result.outcome,
    });
    log.info(
      { threadId, catId, outcome: result.outcome },
      '[ConnectorInvokeTrigger] Queued (active invocation running)',
    );
    return result.outcome;
  }

  private async handleUrgentTrigger(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    reason?: string,
    sender?: { id: string; name?: string },
  ): Promise<void> {
    const { invocationTracker, invocationRecordStore, log } = this.opts;
    const idempotencyKey = `connector-${messageId}`;
    const activeOwner = invocationTracker.getUserId(threadId, catId);
    if (activeOwner && activeOwner !== userId) {
      this.enqueueWhileActive(threadId, catId, userId, message, messageId, sender);
      return;
    }

    // Claim idempotency winner before any cancel side-effect.
    const createResult = await invocationRecordStore.create({
      threadId,
      userId,
      targetCats: [catId],
      intent: 'execute',
      idempotencyKey,
    });
    if (createResult.outcome === 'duplicate') {
      log.info(
        { threadId, catId, invocationId: createResult.invocationId },
        '[ConnectorInvokeTrigger] Urgent duplicate ignored',
      );
      return;
    }

    const cancelResult = invocationTracker.cancel(threadId, catId, userId, 'preempted');
    // F108 P1-4 fix: abort only the target cat's dispatches, not the entire thread
    getMultiMentionOrchestrator().abortBySlot(threadId, catId);
    log.info(
      { threadId, catId, cancelled: cancelResult.cancelled, reason: reason ?? 'connector_urgent' },
      '[ConnectorInvokeTrigger] Urgent connector preempt',
    );

    if (cancelResult.cancelled || !invocationTracker.has(threadId, catId)) {
      if (cancelResult.cancelled) {
        this.opts.queueProcessor?.clearPause(threadId, catId);
      }
      await this.executeInBackground(threadId, catId, userId, message, messageId, createResult.invocationId);
      return;
    }

    if (invocationTracker.has(threadId, catId)) {
      // Avoid queue race: enqueue first while thread is still observed active.
      const enqueueOutcome = this.enqueueWhileActive(threadId, catId, userId, message, messageId, sender);
      if (enqueueOutcome !== 'full') {
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'canceled',
          error: 'urgent preempt fallback to queue',
        });
        return;
      }
      const activeOwner = invocationTracker.getUserId(threadId, catId);
      if (activeOwner && activeOwner !== userId) {
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'failed',
          error: 'urgent fallback queue full with owner mismatch',
        });
        return;
      }
    }

    await this.executeInBackground(threadId, catId, userId, message, messageId, createResult.invocationId);
  }

  private async executeInBackground(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    existingInvocationId?: string,
    contentBlocks?: readonly MessageContent[],
  ): Promise<void> {
    const { router, socketManager, invocationRecordStore, invocationTracker, invocationQueue, log } = this.opts;
    const targetCats: CatId[] = [catId];
    let finalStatus: 'succeeded' | 'failed' | 'canceled' = 'failed';

    // ① Atomic create InvocationRecord
    const createResult = existingInvocationId
      ? { outcome: 'created' as const, invocationId: existingInvocationId }
      : await invocationRecordStore.create({
          threadId,
          userId,
          targetCats,
          intent: 'execute',
          idempotencyKey: `connector-${messageId}`,
        });

    if (createResult.outcome === 'duplicate') {
      log.info(`[ConnectorInvokeTrigger] Duplicate invocation for message ${messageId}, skipping`);
      return;
    }

    // Tracker started here — must be completed in finally no matter what
    const controller = invocationTracker.start(threadId, catId, userId, targetCats);

    const HEARTBEAT_INTERVAL_MS = 30_000;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

    try {
      if (controller?.signal.aborted) {
        finalStatus = 'canceled';
        await invocationRecordStore.update(createResult.invocationId, { status: 'canceled' });
        log.warn(`[ConnectorInvokeTrigger] Thread ${threadId} is being deleted, skipping`);
        return;
      }

      // ② Backfill userMessageId (the connector message that triggered this)
      await invocationRecordStore.update(createResult.invocationId, {
        userMessageId: messageId,
      });

      heartbeatInterval = setInterval(() => {
        socketManager.broadcastToRoom(`thread:${threadId}`, 'heartbeat', { threadId, timestamp: Date.now() });
      }, HEARTBEAT_INTERVAL_MS);

      // ③ Set status running + broadcast intent
      await invocationRecordStore.update(createResult.invocationId, { status: 'running' });

      socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', { threadId, mode: 'execute', targetCats });

      // ④ Run routeExecution and broadcast each agent message
      const cursorBoundaries = new Map<string, string>();
      const persistenceContext: PersistenceContext = { failed: false, errors: [] };
      const collectedUsage = new Map<string, TokenUsage>();
      const collectedTextParts: string[] = [];

      // ISSUE-9: Track per-turn content for individual outbound delivery
      // Cloud-P1-4 fix: use ordered array (not Map) to preserve A→B→A turn boundaries
      const outboundTurns: Array<{
        catId: string;
        textParts: string[];
        richBlocks?: PersistenceContext['richBlocks'];
      }> = [];
      let currentTurnCatId: string | undefined;

      // Phase 4: Start streaming placeholder on external platforms
      // Fire-and-forget for the loop, but save the promise so onStreamEnd can await it
      // to prevent race (onStreamEnd before onStreamStart finishes registering sessions).
      let streamStartPromise: Promise<void> | undefined;
      if (this.opts.streamingHook) {
        streamStartPromise = this.opts.streamingHook
          .onStreamStart(threadId, catId, createResult.invocationId)
          .catch((err) => {
            log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.onStreamStart failed');
          });
      }

      const intent = { intent: 'execute' as const, explicit: false, promptTags: [] as string[] };

      for await (const msg of router.routeExecution(userId, message, threadId, messageId, targetCats, intent, {
        ...(contentBlocks ? { contentBlocks } : {}),
        ...(controller?.signal ? { signal: controller.signal } : {}),
        queueHasQueuedMessages: (tid: string) => invocationQueue.hasQueuedForThread(tid),
        hasQueuedOrActiveAgentForCat: (tid: string, catId: string) =>
          invocationQueue.hasActiveOrQueuedAgentForCat(tid, catId),
        cursorBoundaries,
        persistenceContext,
        parentInvocationId: createResult.invocationId,
      })) {
        // F39 bugfix: stop broadcasting after cancel (drain pipe buffer silently)
        if (controller?.signal.aborted) break;
        if (msg.type === 'done' && msg.catId) {
          if (msg.metadata?.usage) {
            collectedUsage.set(msg.catId, mergeTokenUsage(collectedUsage.get(msg.catId), msg.metadata.usage));
          }
          // ISSUE-9: snapshot richBlocks for current turn before next cat overwrites
          // Cloud-P1-5 fix: only reuse turn if still open (currentTurnCatId matches)
          if (persistenceContext.richBlocks) {
            const turn = outboundTurns[outboundTurns.length - 1];
            if (turn && turn.catId === msg.catId && currentTurnCatId === msg.catId) {
              turn.richBlocks = [...persistenceContext.richBlocks];
            } else {
              // Cat had richBlocks but no text — create a turn
              outboundTurns.push({ catId: msg.catId, textParts: [], richBlocks: [...persistenceContext.richBlocks] });
            }
            persistenceContext.richBlocks = undefined;
          }
          // Close current turn — next text message starts a new turn
          currentTurnCatId = undefined;
        }
        // Collect text content for outbound delivery (final-only)
        if (msg.type === 'text' && typeof msg.content === 'string') {
          collectedTextParts.push(msg.content);
          // ISSUE-9: per-turn text collection (new turn on catId change or after done)
          if (msg.catId) {
            if (msg.catId !== currentTurnCatId) {
              outboundTurns.push({ catId: msg.catId, textParts: [] });
              currentTurnCatId = msg.catId;
            }
            outboundTurns[outboundTurns.length - 1].textParts.push(msg.content);
          }
          // Phase 4: Stream accumulated text to external platforms
          if (this.opts.streamingHook) {
            const accumulated = collectedTextParts.join('');
            this.opts.streamingHook.onStreamChunk(threadId, accumulated, createResult.invocationId).catch((err) => {
              log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.onStreamChunk failed');
            });
          }
        }
        socketManager.broadcastAgentMessage({ ...msg, invocationId: createResult.invocationId }, threadId);
      }

      // ⑤ Finalize: abort guard → persistence check → ack + succeeded
      // F39 P1 fix (砚砚 R1): abort guard after loop — same pattern as messages.ts.
      // When signal aborted and generator ends normally, break exits loop but
      // post-loop code would still run ack+succeeded without this guard.
      if (controller?.signal.aborted) {
        finalStatus = 'canceled';
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'canceled',
        });
        // Skip ack/succeeded — let finally handle cleanup
      } else if (persistenceContext.failed) {
        const errorDetail = persistenceContext.errors.map((e) => `${e.catId}: ${e.error}`).join('; ');
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'failed',
          error: `Connector invoke: message delivered but persistence failed: ${errorDetail}`,
        });
      } else {
        await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'succeeded',
          ...(collectedUsage.size > 0
            ? {
                usageByCat: Object.fromEntries(collectedUsage),
              }
            : {}),
        });
        finalStatus = 'succeeded';

        // ⑥ Outbound delivery: send final text + rich blocks to bound external chats
        const finalContent = collectedTextParts.join('');

        // Phase 4: Finalize streaming — ensure start completed before ending
        if (this.opts.streamingHook) {
          if (streamStartPromise) {
            const STREAM_START_TIMEOUT_MS = 5000;
            await Promise.race([
              streamStartPromise,
              new Promise<void>((resolve) => setTimeout(resolve, STREAM_START_TIMEOUT_MS)),
            ]);
          }
          await this.opts.streamingHook.onStreamEnd(threadId, finalContent, createResult.invocationId).catch((err) => {
            log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.onStreamEnd failed');
          });
        }

        // R1-P1 fix: restore OR condition — richBlocks-only replies must also trigger delivery
        const hasContent = collectedTextParts.length > 0 || outboundTurns.length > 0;
        log.info(
          {
            threadId,
            hasOutboundHook: !!this.opts.outboundHook,
            hasContent,
            textPartsCount: collectedTextParts.length,
            outboundTurnsCount: outboundTurns.length,
            finalContentLen: collectedTextParts.join('').length,
          },
          '[ConnectorInvokeTrigger] Outbound delivery check',
        );
        if (this.opts.outboundHook && hasContent) {
          // Best-effort threadMeta lookup — must not block invocation completion
          let threadMeta;
          try {
            const LOOKUP_TIMEOUT_MS = 2000;
            const rawResult = this.opts.threadMetaLookup?.(threadId);
            if (rawResult) {
              const lookupPromise = Promise.resolve(rawResult).catch((err: unknown) => {
                log.warn({ err, threadId }, '[ConnectorInvokeTrigger] threadMetaLookup late rejection');
                return undefined;
              });
              const timeout = new Promise<undefined>((resolve) =>
                setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS),
              );
              threadMeta = await Promise.race([lookupPromise, timeout]);
            }
          } catch (lookupErr) {
            log.warn(
              { err: lookupErr, threadId },
              '[ConnectorInvokeTrigger] threadMetaLookup failed, falling back to plain reply',
            );
          }

          // ISSUE-9 + Cloud-P1-4: deliver per-turn (ordered, supports A→B→A ping-pong)
          const DELIVER_TIMEOUT_MS = this.opts.deliverTimeoutMs ?? 10_000;
          // Filter out empty turns (silent cats with no text or richBlocks)
          const nonEmptyTurns = outboundTurns.filter(
            (t) => t.textParts.length > 0 || (t.richBlocks && t.richBlocks.length > 0),
          );

          let deliveryFailed = false;
          // Cloud-R4-P2: keep references to in-flight deliver promises so we can
          // schedule late-success cleanup when a delivery times out but later succeeds.
          const inflightDeliverPromises: Promise<void>[] = [];

          if (nonEmptyTurns.length > 1) {
            for (const turn of nonEmptyTurns) {
              const turnContent = turn.textParts.join('');
              const deliverPromise = this.opts.outboundHook.deliver(
                threadId,
                turnContent,
                turn.catId as CatId,
                turn.richBlocks,
                threadMeta,
                undefined,
                messageId,
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
                log.error({ err, threadId, catId: turn.catId }, '[ConnectorInvokeTrigger] Outbound delivery error');
              }
            }
          } else if (nonEmptyTurns.length === 1) {
            const turn = nonEmptyTurns[0];
            const richBlocks = persistenceContext.richBlocks ?? turn.richBlocks;
            const deliverPromise = this.opts.outboundHook.deliver(
              threadId,
              finalContent,
              turn.catId as CatId,
              richBlocks,
              threadMeta,
              undefined,
              messageId,
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
              log.error({ err, threadId }, '[ConnectorInvokeTrigger] Outbound delivery error');
            }
          } else {
            const richBlocks = persistenceContext.richBlocks;
            const deliverPromise = this.opts.outboundHook.deliver(
              threadId,
              finalContent,
              catId,
              richBlocks,
              threadMeta,
              undefined,
              messageId,
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
              log.error({ err, threadId }, '[ConnectorInvokeTrigger] Outbound delivery error');
            }
          }

          // Cloud-P1-R2: only cleanup placeholders if ALL deliveries succeeded
          if (!deliveryFailed && this.opts.streamingHook?.cleanupPlaceholders) {
            await this.opts.streamingHook.cleanupPlaceholders(threadId, createResult.invocationId).catch((err) => {
              log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.cleanupPlaceholders failed');
            });
          } else if (deliveryFailed && this.opts.streamingHook?.cleanupPlaceholders) {
            // Cloud-R4-P2: schedule late-success cleanup — if timed-out deliveries
            // eventually succeed, clean up placeholder cards so the user doesn't see
            // a stale "thinking…" card alongside the real response.
            const cleanupHook = this.opts.streamingHook;
            const scopedInvocationId = createResult.invocationId;
            Promise.allSettled(inflightDeliverPromises).then((results) => {
              const allSucceeded = results.every((r) => r.status === 'fulfilled');
              if (allSucceeded) {
                cleanupHook.cleanupPlaceholders(threadId, scopedInvocationId).catch((err) => {
                  log.warn({ err, threadId }, '[ConnectorInvokeTrigger] Late-success placeholder cleanup failed');
                });
              }
            });
          }
        } else if (this.opts.streamingHook?.cleanupPlaceholders) {
          // Cloud-P1-R3: silent invocation (no content) — still clean up placeholder
          await this.opts.streamingHook.cleanupPlaceholders(threadId, createResult.invocationId).catch((err) => {
            log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.cleanupPlaceholders failed (silent)');
          });
        }
      }

      log.info(
        `[ConnectorInvokeTrigger] Invocation ${createResult.invocationId} completed for ${catId} in thread ${threadId}`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`[ConnectorInvokeTrigger] Invocation failed: ${errorMsg}`);

      // Best-effort status update — don't let this throw mask the original error
      try {
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'failed',
          error: errorMsg,
        });
      } catch {
        /* best-effort */
      }

      socketManager.broadcastAgentMessage(
        {
          type: 'error',
          catId: getDefaultCatId(),
          error: `Connector invoke failed: ${errorMsg}`,
          isFinal: true,
          timestamp: Date.now(),
        },
        threadId,
      );
    } finally {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      invocationTracker.complete(threadId, catId, controller);
      // F39 P1 fix: Notify queue processor for auto-dequeue chain
      // (same pattern as messages.ts and invocations.ts)
      this.opts.queueProcessor?.onInvocationComplete(threadId, catId, finalStatus).catch(() => {
        /* best-effort, don't crash background task */
      });
    }
  }
}
