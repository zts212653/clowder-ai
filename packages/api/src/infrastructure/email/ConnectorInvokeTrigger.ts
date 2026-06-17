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

import { type CatId, type MessageContent } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getDefaultCatId } from '../../config/cat-config-loader.js';
import type { InvocationQueue } from '../../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationTracker } from '../../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { QueueProcessor } from '../../domains/cats/services/agents/invocation/QueueProcessor.js';
import { stampVisibleTurn } from '../../domains/cats/services/agents/invocation/visible-turn.js';
import type { AgentRouter } from '../../domains/cats/services/agents/routing/AgentRouter.js';
import type { PersistenceContext } from '../../domains/cats/services/agents/routing/route-helpers.js';
import type { IInvocationRecordStore } from '../../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../../domains/cats/services/stores/ports/MessageStore.js';
import { mergeTokenUsage, type TokenUsage } from '../../domains/cats/services/types.js';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import { emitQueueUpdated, enrichQueueEntries } from '../../utils/queue-enrichment.js';

import type { OutboundDeliveryHook, ThreadMeta } from '../connectors/OutboundDeliveryHook.js';
import type { StreamingOutboundHook } from '../connectors/StreamingOutboundHook.js';

export type TriggerOutcome = 'dispatched' | 'enqueued' | 'full';

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
  /** #706: MessageStore for queue enrichment (messagePreview in queue_updated SSE). */
  readonly messageStore?: IMessageStore;
  readonly log: FastifyBaseLogger;
}

export interface ConnectorTriggerPolicy {
  /** F175: urgent entries get priority dequeue, no preemption */
  readonly priority?: 'urgent' | 'normal';
  /** optional reason for diagnostics */
  readonly reason?: string;
  /** F175: origin category for visual grouping */
  readonly sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue';
  /** F140 Phase C: hint which Skill to auto-load (not a hard constraint — cat can override) */
  readonly suggestedSkill?: string;
  /**
   * Optional queue coalescing key for connector bursts that supersede earlier queued work.
   * Later hits reuse the first queued entry: messageIds are merged, but the original content/body stays in place.
   * Once that entry is already processing, follow-up feedback gets a fresh queued wake-up.
   * Queue metadata may still upgrade, e.g. normal COMMENTED feedback becoming urgent CHANGES_REQUESTED.
   */
  readonly coalesceKey?: string;
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
  async trigger(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    contentBlocks?: readonly MessageContent[],
    policy?: ConnectorTriggerPolicy,
    sender?: { id: string; name?: string },
  ): Promise<TriggerOutcome> {
    const { invocationTracker } = this.opts;
    const priority = policy?.priority ?? 'normal';

    // F185 AC-1: thread-level queue/processingSlots gate
    if (this.opts.queueProcessor?.isThreadBusy(threadId)) {
      return this.enqueueWhileActive(
        threadId,
        catId,
        userId,
        message,
        messageId,
        sender,
        priority,
        policy?.sourceCategory,
        policy?.suggestedSkill,
        policy?.coalesceKey,
      );
    }

    // F185 AC-2: atomic thread-level acquire — TOCTOU-safe
    const controller = invocationTracker.tryStartThread(threadId, catId, userId, [catId]);
    if (!controller) {
      return this.enqueueWhileActive(
        threadId,
        catId,
        userId,
        message,
        messageId,
        sender,
        priority,
        policy?.sourceCategory,
        policy?.suggestedSkill,
        policy?.coalesceKey,
      );
    }

    // AC-2+3: dispatch with acquired controller (no separate start() call)
    this.executeInBackground(
      threadId,
      catId,
      userId,
      message,
      messageId,
      undefined,
      contentBlocks,
      policy?.suggestedSkill,
      sender,
      controller,
    ).catch((err) => {
      this.opts.log.error(`[ConnectorInvokeTrigger] Unhandled: ${err instanceof Error ? err.message : String(err)}`);
    });
    return 'dispatched';
  }

  private async enqueueWhileActive(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    sender?: { id: string; name?: string },
    priority: 'urgent' | 'normal' = 'normal',
    sourceCategory?: string,
    suggestedSkill?: string,
    coalesceKey?: string,
  ): Promise<'full' | 'enqueued'> {
    const { invocationQueue, socketManager, log } = this.opts;

    if (invocationQueue.hasEntryWithMessageId(threadId, messageId)) {
      log.info(
        { threadId, messageId },
        '[ConnectorInvokeTrigger] Duplicate connector message already queued, skipping',
      );
      return 'enqueued';
    }

    const result = invocationQueue.enqueue({
      threadId,
      userId,
      content: message,
      ...(coalesceKey
        ? {
            idempotencyKey: `connector:${sourceCategory ?? 'generic'}:${coalesceKey}`,
            dedupeProcessing: false,
          }
        : {}),
      source: 'connector',
      targetCats: [catId],
      intent: 'execute',
      priority,
      ...(sourceCategory
        ? { sourceCategory: sourceCategory as 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue' }
        : {}),
      ...(sender ? { senderMeta: sender } : {}),
      ...(suggestedSkill ? { suggestedSkill } : {}),
    });

    if (result.outcome === 'full') {
      const fullQueue = await enrichQueueEntries(
        invocationQueue.list(threadId, userId),
        this.opts.messageStore ?? null,
      );
      socketManager.emitToUser(userId, 'queue_full_warning', {
        threadId,
        source: 'connector',
        queueSize: invocationQueue.size(threadId, userId),
        queue: fullQueue,
      });
      socketManager.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: getDefaultCatId(),
          content: JSON.stringify({ type: 'connector_skip', reason: 'queue_full', threadId }),
          timestamp: Date.now(),
        },
        threadId,
      );
      log.warn({ threadId, catId, userId }, '[ConnectorInvokeTrigger] Queue full, connector message not enqueued');
      return 'full';
    }

    if (result.entry) {
      invocationQueue.backfillMessageId(threadId, userId, result.entry.id, messageId);
    }

    await emitQueueUpdated(
      socketManager,
      userId,
      threadId,
      invocationQueue.list(threadId, userId),
      this.opts.messageStore ?? null,
      result.outcome,
    );
    log.info(
      { threadId, catId, outcome: result.outcome },
      '[ConnectorInvokeTrigger] Queued (active invocation running)',
    );
    return result.outcome;
  }

  private async executeInBackground(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    existingInvocationId?: string,
    contentBlocks?: readonly MessageContent[],
    suggestedSkill?: string,
    sender?: { id: string; name?: string },
    preAcquiredController?: AbortController,
  ): Promise<void> {
    const { router, socketManager, invocationRecordStore, invocationTracker, invocationQueue, log } = this.opts;
    const targetCats: CatId[] = [catId];
    let finalStatus: 'succeeded' | 'failed' | 'canceled' = 'failed';
    let skipOnComplete = false;

    // R1-P1 fix: move controller before try so finally always releases it (even if create() throws)
    const controller = preAcquiredController ?? invocationTracker.start(threadId, catId, userId, targetCats);

    const HEARTBEAT_INTERVAL_MS = 30_000;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    let invocationId: string | undefined;
    // R4 fix: hoist above try so catch can await it for correct failure cleanup
    // (onStreamEnd → cleanupPlaceholders, per messages.ts cleanupStreamingOnFailure).
    let streamStartPromise: Promise<void> | undefined;

    try {
      // ① Atomic create InvocationRecord (inside try so finally releases controller on throw)
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
        skipOnComplete = true;
        return; // finally releases controller
      }

      invocationId = createResult.invocationId;

      if (controller?.signal.aborted) {
        finalStatus = 'canceled';
        await invocationRecordStore.update(invocationId, { status: 'canceled' });
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

      // #768: Defer intent_mode broadcast until CLI produces first event.
      let intentModeBroadcast = false;

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
      if (this.opts.streamingHook) {
        streamStartPromise = this.opts.streamingHook
          .onStreamStart(threadId, catId, createResult.invocationId, sender)
          .catch((err) => {
            log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.onStreamStart failed');
          });
      }

      // F151: Deliver per-cat turns inside the loop to preserve ordering when
      // post_message callbacks from later cats interleave with earlier outboundTurns.
      const deliveredTurnIndices = new Set<number>();
      const DELIVER_TIMEOUT_MS = this.opts.deliverTimeoutMs ?? 10_000;

      // Start threadMeta lookup early — resolved lazily when first delivery needs it.
      let threadMeta: ThreadMeta | undefined;
      let threadMetaPromise: Promise<ThreadMeta | undefined> | undefined;
      if (this.opts.outboundHook && this.opts.threadMetaLookup) {
        const rawResult = this.opts.threadMetaLookup(threadId);
        if (rawResult) {
          const LOOKUP_TIMEOUT_MS = 2000;
          threadMetaPromise = Promise.race([
            Promise.resolve(rawResult).catch((err: unknown) => {
              log.warn({ err, threadId }, '[ConnectorInvokeTrigger] threadMetaLookup late rejection');
              return undefined;
            }),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS)),
          ]);
        }
      }

      // F140 Phase C: suggestedSkill flows via promptTags → SystemPromptBuilder (hint, not directive)
      const promptTags: string[] = suggestedSkill ? [`skill:${suggestedSkill}`] : [];
      const intent = { intent: 'execute' as const, explicit: false, promptTags };

      for await (const msg of router.routeExecution(userId, message, threadId, messageId, targetCats, intent, {
        ...(contentBlocks ? { contentBlocks } : {}),
        ...(controller?.signal ? { signal: controller.signal } : {}),
        queueHasQueuedMessages: (tid: string) => invocationQueue.hasQueuedNonAgentForThread(tid),
        deferA2AEnqueue: (e) => invocationQueue.enqueue(e as any),
        hasQueuedOrActiveAgentForCat: (tid: string, catId: string) =>
          invocationQueue.hasActiveOrQueuedAgentForCat(tid, catId),
        cursorBoundaries,
        persistenceContext,
        parentInvocationId: createResult.invocationId,
        // F222 P1: Connector-triggered execution is not user-origin — suppress frustration detection
        frustrationAutoIssueEligible: false,
        // #949 P2: Connector-sourced flows have no ball-pass expectation — suppress verdict warning
        verdictPassWarningEnabled: false,
      })) {
        // #768: Broadcast intent_mode on first CLI event — proves CLI is alive.
        if (!intentModeBroadcast) {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', {
            threadId,
            mode: 'execute',
            targetCats,
            invocationId: createResult.invocationId,
          });
          intentModeBroadcast = true;
        }
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
          // F151: Deliver completed cat's turns immediately to preserve ordering
          // when post_message callbacks from later cats fire during the loop.
          if (this.opts.outboundHook) {
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
                  this.opts.outboundHook.deliver(
                    threadId,
                    turnContent,
                    turn.catId as CatId,
                    turn.richBlocks,
                    threadMeta,
                    undefined,
                    messageId,
                  ),
                  new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
                  ),
                ]);
                deliveredTurnIndices.add(i);
              } catch (err) {
                log.error(
                  { err, threadId, catId: turn.catId },
                  '[ConnectorInvokeTrigger] Mid-loop delivery failed, will retry in final phase',
                );
              }
            }
          }
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
        // F194 Phase Z9 (砚砚 R1 P1-2): unified visible turn stamp via helper.
        socketManager.broadcastAgentMessage(
          { ...msg, ...stampVisibleTurn(createResult.invocationId, msg.invocationId) },
          threadId,
        );
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
          // Resolve threadMeta if not yet done (no mid-loop delivery happened)
          if (threadMetaPromise) {
            threadMeta = await threadMetaPromise;
            threadMetaPromise = undefined;
          }

          // ISSUE-9 + Cloud-P1-4: deliver per-turn (ordered, supports A→B→A ping-pong)
          // F151: skip turns already delivered mid-loop
          const nonEmptyTurns = outboundTurns.filter(
            (t, i) =>
              !deliveredTurnIndices.has(i) && (t.textParts.length > 0 || (t.richBlocks && t.richBlocks.length > 0)),
          );

          let deliveryFailed = false;
          // Cloud-R4-P2: keep references to in-flight deliver promises so we can
          // schedule late-success cleanup when a delivery times out but later succeeds.
          const inflightDeliverPromises: Promise<void>[] = [];

          // BUG-5 (2026-03-25): iLink context_token is reusable — SINGLE_TOKEN_CONNECTORS
          // merge logic removed. Each turn now delivers independently for all connectors.
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
          } else if (deliveredTurnIndices.size === 0) {
            // Fallback: no per-turn delivery happened — deliver all content as one
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
            const cleanupHook = this.opts.streamingHook;
            const scopedInvocationId = createResult.invocationId;
            Promise.allSettled(inflightDeliverPromises).then((results) => {
              if (results.every((r) => r.status === 'fulfilled')) {
                cleanupHook.cleanupPlaceholders(threadId, scopedInvocationId).catch((err) => {
                  log.warn(
                    { err, threadId },
                    '[ConnectorInvokeTrigger] Placeholder cleanup failed after late-success delivery',
                  );
                });
              }
            });
          }
        } else {
          // R6+R7 fix: deliver fallback FIRST (with timeout), then cleanup placeholder
          // only on success — preserves "thinking" card if delivery fails (Cloud P2).
          // Timeout prevents adapter hang from blocking finally (Cloud P1).
          // R7: late-success cleanup mirrors normal content-delivery pattern (lines 641-653).
          let silentDeliveryOk = !this.opts.outboundHook; // no hook → proceed to cleanup
          let silentDeliverPromise: Promise<void> | undefined;
          if (this.opts.outboundHook) {
            silentDeliverPromise = this.opts.outboundHook.deliver(
              threadId,
              '处理完成，但未产生回复内容。',
              catId,
              undefined,
              undefined,
              undefined,
              messageId,
            );
            try {
              await Promise.race([
                silentDeliverPromise,
                new Promise<void>((_, reject) =>
                  setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
                ),
              ]);
              silentDeliveryOk = true;
            } catch (deliverErr) {
              log.error({ err: deliverErr, threadId }, '[ConnectorInvokeTrigger] Silent-path outbound delivery failed');
            }
          }
          if (silentDeliveryOk && this.opts.streamingHook?.cleanupPlaceholders) {
            await this.opts.streamingHook.cleanupPlaceholders(threadId, createResult.invocationId).catch((err) => {
              log.warn({ err, threadId }, '[ConnectorInvokeTrigger] StreamingHook.cleanupPlaceholders failed (silent)');
            });
          } else if (silentDeliverPromise && this.opts.streamingHook?.cleanupPlaceholders) {
            // R7: timeout fired but delivery may still succeed — defer cleanup to late-success
            const cleanupHook = this.opts.streamingHook;
            const scopedInvocationId = createResult.invocationId;
            silentDeliverPromise
              .then(() => {
                cleanupHook.cleanupPlaceholders(threadId, scopedInvocationId).catch((err) => {
                  log.warn(
                    { err, threadId },
                    '[ConnectorInvokeTrigger] Silent late-success placeholder cleanup failed',
                  );
                });
              })
              .catch(() => {
                /* delivery truly failed — thinking card stays as fallback UX */
              });
          }
        }
      }

      log.info(
        `[ConnectorInvokeTrigger] Invocation ${createResult.invocationId} completed for ${catId} in thread ${threadId}`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`[ConnectorInvokeTrigger] Invocation failed: ${errorMsg}`);

      // Best-effort status update — don't let this throw mask the original error
      if (invocationId) {
        try {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: errorMsg,
          });
        } catch {
          /* best-effort */
        }
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

      // R4 fix (#873): correct failure cleanup — onStreamEnd transitions sessions
      // from active → pendingCleanup; cleanupPlaceholders alone is a no-op on active
      // sessions. Matches messages.ts cleanupStreamingOnFailure() sequence.
      if (this.opts.streamingHook) {
        try {
          const STREAM_START_TIMEOUT_MS = 5000;
          if (streamStartPromise) {
            await Promise.race([streamStartPromise, new Promise<void>((r) => setTimeout(r, STREAM_START_TIMEOUT_MS))]);
          }
          await this.opts.streamingHook.onStreamEnd(threadId, '', invocationId);
          await this.opts.streamingHook.cleanupPlaceholders?.(threadId, invocationId);
        } catch (cleanupErr) {
          log.warn({ err: cleanupErr, threadId }, '[ConnectorInvokeTrigger] Error-path streaming cleanup failed');
        }
      }

      // #873: Deliver error message to external IM platform so user sees a reply (not silence)
      // R6 fix: timeout prevents adapter hang from blocking finally (Cloud P1).
      if (this.opts.outboundHook) {
        const ERROR_DELIVER_TIMEOUT_MS = this.opts.deliverTimeoutMs ?? 10_000;
        try {
          await Promise.race([
            this.opts.outboundHook.deliver(
              threadId,
              '抱歉，处理消息时遇到问题，请稍后重试。',
              catId,
              undefined,
              undefined,
              undefined,
              messageId,
            ),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('deliver timeout')), ERROR_DELIVER_TIMEOUT_MS),
            ),
          ]);
        } catch (deliverErr) {
          log.error({ err: deliverErr, threadId }, '[ConnectorInvokeTrigger] Error-path outbound delivery failed');
        }
      }
    } finally {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      invocationTracker.complete(threadId, catId, controller);
      // F39 P1 fix: Notify queue processor for auto-dequeue chain
      // R2-P1-B: skip for duplicates — no real invocation happened, notifying 'failed' would pause the slot
      if (!skipOnComplete) {
        this.opts.queueProcessor?.onInvocationComplete(threadId, catId, finalStatus).catch(() => {
          /* best-effort, don't crash background task */
        });
      }
      // F151: Signal adapters that this invocation's delivery batch is complete.
      // Fires on both success AND failure — failed invocations must close the task
      // immediately instead of waiting for TASK_TIMEOUT_MS (P2-1 review fix).
      if (this.opts.streamingHook?.notifyDeliveryBatchDone) {
        const threadStillBusy =
          invocationTracker.has(threadId) || (this.opts.queueProcessor?.isThreadBusy(threadId) ?? false);
        this.opts.streamingHook.notifyDeliveryBatchDone(threadId, !threadStillBusy).catch((err) => {
          log.warn({ err, threadId }, '[ConnectorInvokeTrigger] notifyDeliveryBatchDone failed');
        });
      }
    }
  }
}
