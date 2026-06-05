/**
 * A2A invocation trigger for MCP callback post_message (F27 rewrite).
 *
 * BEFORE F27: callback detected @mentions → spawned independent routeExecution
 *   → dual-path bug (double-fire + uncontrollable children + infinite recursion)
 *
 * AFTER F27: callback detected @mentions → pushes targets to parent worklist
 *   → single path, shared AbortController, shared depth limit
 *
 * Fallback: if no parent worklist exists (shouldn't happen in practice,
 * since callbacks only fire during cat execution), creates a standalone
 * invocation as before.
 */

import type { CatId } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getDefaultCatId } from '../config/cat-config-loader.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import { stampVisibleTurn } from '../domains/cats/services/agents/invocation/visible-turn.js';
import {
  getWorklist,
  hasWorklist,
  pushToWorklist,
  updateStreakOnPush,
} from '../domains/cats/services/agents/routing/WorklistRegistry.js';
import { parseIntent } from '../domains/cats/services/context/IntentParser.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { DeliveryCursorStore } from '../domains/cats/services/stores/ports/DeliveryCursorStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { wrapWithDispatchSpan } from '../infrastructure/telemetry/dispatch-span.js';
import type { CallerTraceContext } from '../infrastructure/telemetry/genai-semconv.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface QueueProcessorLike {
  onInvocationComplete(threadId: string, catId: string, status: 'succeeded' | 'failed' | 'canceled'): Promise<void>;
  tryAutoExecute?(threadId: string): Promise<void>;
  /** F216 c3 supersede: reuse the force-send abort-resume coordinate system.
   *  clearPause prevents the aborted invocation's async cleanup from poisoning QueueProcessor state (F39).
   *  releaseSlot force-frees the per-slot processingSlots mutex so tryAutoExecute sees a free slot. */
  clearPause?(threadId: string, catId?: string): void;
  releaseSlot?(threadId: string, catId: string): void;
}

export interface A2ATriggerDeps {
  router: AgentRouter;
  invocationRecordStore: IInvocationRecordStore;
  socketManager: SocketManager;
  invocationTracker?: InvocationTracker;
  deliveryCursorStore?: DeliveryCursorStore;
  queueProcessor?: QueueProcessorLike;
  /** F122B: InvocationQueue for agent-sourced entries.
   *  F-coalesce: + findInFlightAgentEntry / coalesceContentIntoQueuedAgent for same-turn handoff merge. */
  invocationQueue?: Pick<
    InvocationQueue,
    // F-coalesce: Guard 2 replaced hasQueuedAgentForCat with findInFlightAgentEntry +
    // coalesceContentIntoQueuedAgent — the old skip-dedup method is no longer referenced here.
    | 'enqueue'
    | 'countAgentEntriesForThread'
    | 'findInFlightAgentEntry'
    | 'coalesceContentIntoQueuedAgent'
    | 'backfillMessageId'
    | 'list'
    // F216 c3: removeProcessed clears the superseded processing entry so it cannot re-run.
    | 'removeProcessed'
  >;
  log: FastifyBaseLogger;
}

/**
 * Enqueue @mentioned cats into the parent's worklist (F27 unified path).
 *
 * Returns the cats that were actually enqueued. If no parent worklist exists,
 * falls back to standalone invocation (legacy path, should be rare).
 */
export async function enqueueA2ATargets(
  deps: A2ATriggerDeps,
  opts: {
    targetCats: CatId[];
    content: string;
    userId: string;
    threadId: string;
    triggerMessage: StoredMessage;
    /** The cat that triggered this A2A callback (for worklist caller guard). */
    callerCatId?: CatId;
    /** F108: parentInvocationId for concurrent worklist isolation. */
    parentInvocationId?: string;
    /** F153: caller trace context for cross-route A2A propagation */
    callerTraceContext?: CallerTraceContext;
  },
): Promise<{ enqueued: CatId[]; coalesced?: CatId[]; fallback: boolean }> {
  const { log } = deps;
  const { threadId, callerCatId } = opts;
  const triggerMessageId = opts.triggerMessage.id;
  const { deliveryCursorStore } = deps;

  // F167 Phase E (KD-20): L3 role-gate retired. Role-based handoff permission is
  // no longer harness-enforced — cat-config.restrictions flows into sender & target
  // prompts (buildTeammateRoster / buildStaticIdentity); cats self-regulate.
  const fromCatId = callerCatId ?? opts.triggerMessage.catId ?? getDefaultCatId();
  const targetCats = opts.targetCats;

  // F153 Phase I (Maine Coon P1): Lazy-create mention_dispatch span + a2a.dispatch.count counter
  // ONLY when a target is about to actually dispatch (passes all guards and reaches a real enqueue
  // or fallback invocation). Pre-creating would mint span/counter even when ALL cats are blocked
  // by depth limit / dedup / ping-pong streak / empty-conflict fallback — polluting Step Summary
  // a2a_dispatch_count with phantom dispatches.
  let dispatchTraceContext: CallerTraceContext | undefined;
  const ensureDispatchTraceContext = (): CallerTraceContext | undefined => {
    if (dispatchTraceContext === undefined && opts.callerTraceContext) {
      dispatchTraceContext = wrapWithDispatchSpan(opts.callerTraceContext, targetCats.length, fromCatId);
    }
    return dispatchTraceContext;
  };

  // F122B: If InvocationQueue is available, enqueue as agent entry (unified dispatch).
  // This replaces both the worklist path and the fallback standalone invocation.
  // Guards mirror worklist protections: depth limit, duplicate detection.
  if (deps.invocationQueue) {
    const MAX_A2A_DEPTH = 10;

    // F167 L1 AC-A4 + Phase D (cloud Codex P1): streak check must cover modern path
    // AND only fire when we know the target is actually about to enqueue — otherwise
    // a callback that hits depth/dedup would still mutate the counter (reset by
    // substantive content, ++ by inertia), weakening the breaker.
    // Pre-resolve worklist entry once; updateStreakOnPush is called inside the loop.
    const canTrackStreak = callerCatId !== undefined && targetCats.length === 1;
    const streakEntry = canTrackStreak ? getWorklist(threadId, opts.parentInvocationId) : null;

    const enqueued: CatId[] = [];
    // F-coalesce: cats whose same-turn handoff was MERGED into an existing queued entry.
    // Tracked separately from `enqueued` because callbacks.ts derives body.routed from `enqueued`
    // — a coalesce is NOT a new A2A route (routed must stay []), but the caller's intent IS handled
    // (no duplicate dispatch, mention cursor still advances). Conflating the two falsely reports
    // "已路由" for a merge (the gate-caught regression: callback-a2a-postmsg.test.js).
    const coalesced: CatId[] = [];
    const queueDiagnostics: Array<{
      catId: CatId;
      outcome: string;
      entryId?: string;
      createdAt?: number;
    }> = [];
    for (const catId of targetCats) {
      // Guard 1: A2A depth limit — re-check per target to prevent multi-target overflow
      const currentDepth = deps.invocationQueue.countAgentEntriesForThread(threadId);
      if (currentDepth >= MAX_A2A_DEPTH) {
        log.warn(
          { threadId, triggerMessageId, currentDepth, catId },
          '[F122B] A2A callback: depth limit reached, skipping remaining targets',
        );
        break;
      }
      // Guard 2 (F-coalesce): coalesce a caller's repeated same-turn handoffs to the same cat
      // instead of dispatching a duplicate invocation. Replaces the old skip-dedup, which only
      // matched 'queued' entries (so a handoff arriving after the first auto-executed into
      // 'processing' slipped through and ran as a SECOND independent invocation — the bug: the
      // target cat executed the first, possibly-superseded handoff before ever seeing the caller's
      // real follow-up intent).
      const inFlight = deps.invocationQueue.findInFlightAgentEntry?.(threadId, catId, callerCatId) ?? null;
      if (inFlight) {
        if (inFlight.status === 'queued') {
          // Not yet dispatched → merge content in place. The target sees both handoffs as one
          // coherent message (parity with user-message collectUserBatch). No duplicate entry.
          const merged =
            deps.invocationQueue.coalesceContentIntoQueuedAgent?.(
              threadId,
              inFlight.userId,
              inFlight.id,
              opts.content,
              triggerMessageId,
              callerCatId,
            ) ?? false;
          if (merged) {
            // Merged into an existing queued entry — handled but NOT a new route (see `coalesced` decl).
            coalesced.push(catId);
            log.info(
              { threadId, triggerMessageId, catId, mergedInto: inFlight.id },
              '[F-coalesce] merged repeated same-turn handoff into queued agent entry',
            );
            continue;
          }
          // Raced to processing between find and merge → fall through to enqueue a follow-up.
        } else {
          // F216 c3 SUPERSEDE: the first handoff is already processing but the caller sent a
          // second same-turn handoff — last-wins semantics.
          //
          // GUARD: QueueProcessor marks an entry 'processing' (markProcessingById) before
          // executeEntry reaches startAll (which registers the tracker slot). In the pre-start
          // window (markProcessing → startAll, spans invocationRecordStore.create await),
          // tracker.has() returns false and cancelInvocation would return []. If we naively
          // releaseSlot + removeProcessed in that window, the old executeEntry (which captured
          // the entry reference) keeps running AND the follow-up starts = double-execute.
          //
          // Solution: only do the full abort-resume sequence when tracker confirms registration.
          // Pre-start window → graceful degradation to sequential (follow-up runs after the
          // current execution completes via onInvocationComplete → tryAutoExecute).
          const trackerRegistered = deps.invocationTracker?.has(threadId, catId) ?? false;
          if (trackerRegistered) {
            // Safe to abort: tracker has the slot, controller exists.
            deps.invocationTracker!.cancelInvocation(threadId, [catId], inFlight.userId, 'preempted');
            // Drop stale pause the aborted invocation's async cleanup will set (F39).
            deps.queueProcessor?.clearPause?.(threadId, catId);
            // Force-free the per-slot mutex — the async .catch hasn't deleted it yet.
            deps.queueProcessor?.releaseSlot?.(threadId, catId);
            // Remove the superseded processing entry so it cannot re-run.
            deps.invocationQueue?.removeProcessed?.(threadId, inFlight.userId, inFlight.id);
            log.info(
              { threadId, triggerMessageId, catId, supersededEntry: inFlight.id },
              '[F216-c3] supersede: aborted running handoff, follow-up will restart via tryAutoExecute',
            );
          } else {
            // Pre-start window: tracker not yet registered (markProcessing → startAll gap).
            // Cannot cancel via tracker, but CAN remove the entry as a tombstone signal:
            // QueueProcessor.executeEntry checks entry presence after startAll and self-aborts
            // if the entry was removed. Do NOT releaseSlot (slot freed by executeEntry's
            // finally→.then chain after the self-abort return 'canceled').
            deps.invocationQueue?.removeProcessed?.(threadId, inFlight.userId, inFlight.id);
            log.warn(
              { threadId, triggerMessageId, catId, supersededEntry: inFlight.id },
              '[F216-c3] supersede tombstone: entry removed for executeEntry guard (pre-start window)',
            );
          }
          // Fall through to enqueue the follow-up as a queued entry; tryAutoExecute (called after
          // enqueue at line ~284) sees the freed slot and auto-starts it.
        }
      }
      // Guard 3 (F167 Phase D cloud Codex P1): streak check fires here — after
      // depth + dedup — so a would-be-skipped target never mutates the counter.
      // Callback path has no tool_use stream → fail-closed on hadSubstantiveToolCall
      // (routing tool ≠ work). outputLength from content still exempts long-form MCP.
      if (canTrackStreak && streakEntry) {
        const streak = updateStreakOnPush(streakEntry, callerCatId!, catId, {
          hadSubstantiveToolCall: false,
          outputLength: opts.content.length,
        });
        if (streak.blockPingPong) {
          log.info(
            { threadId, triggerMessageId, fromCatId, catId, pairCount: streak.count },
            'F167 L1: callback A2A (invocationQueue) ping-pong terminated (streak >= 4)',
          );
          deps.socketManager.broadcastAgentMessage(
            {
              type: 'system_info',
              catId: fromCatId,
              content: JSON.stringify({
                type: 'a2a_pingpong_terminated',
                fromCatId,
                targetCatId: catId,
                pairCount: streak.count,
              }),
              timestamp: Date.now(),
            },
            threadId,
          );
          break;
        }
        // streak.warnPingPong → injected via buildInvocationContext on next turn, no-op here.
      }
      const result = deps.invocationQueue.enqueue({
        threadId,
        userId: opts.userId,
        content: opts.content,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        callerCatId: callerCatId ?? undefined,
        callerTraceContext: ensureDispatchTraceContext(),
        a2aTriggerMessageId: triggerMessageId,
      });
      queueDiagnostics.push({
        catId,
        outcome: result.outcome,
        entryId: result.entry?.id,
        createdAt: result.entry?.createdAt,
      });
      if (result.outcome === 'enqueued') {
        enqueued.push(catId);
        if (result.entry) {
          deps.invocationQueue.backfillMessageId(threadId, opts.userId, result.entry.id, triggerMessageId);
        }
      }
    }
    // Best-effort auto-ack mentions (same as worklist path).
    // F-coalesce: ack covers BOTH enqueued AND coalesced targets — a coalesced mention WAS handled
    // (merged into an existing queued entry), so its cursor must advance too, otherwise the
    // merged-away mention lingers as a phantom pending backlog.
    const handled = [...enqueued, ...coalesced];
    if (deliveryCursorStore && handled.length > 0) {
      const ackTargets = handled.filter((catId) => opts.triggerMessage.mentions.includes(catId));
      await Promise.allSettled(
        ackTargets.map((catId) => deliveryCursorStore.ackMentionCursor(opts.userId, catId, threadId, triggerMessageId)),
      );
    }
    // queue_updated emits on BOTH a new entry (enqueued) AND a coalesce (云端 codex R4 P2).
    // A coalesce mutates entry.content in place — and the web client's QueueEntryRow renders
    // entry.content, replacing QueuePanel state from each queue_updated event. Without emitting on
    // coalesce, the user keeps seeing the STALE pre-merge handoff until some later unrelated queue
    // event fires, even though the backend will execute the merged content. (My earlier "no visible
    // delta" reasoning was wrong: content IS a rendered field. 46 R3 and I both missed the frontend
    // render dependency; cloud codex caught it.) Gate on `handled` (enqueued ∪ coalesced).
    if (handled.length > 0) {
      // F216 AC-D7: use semantically accurate action — 'coalesced' when content was merged
      // into an existing entry (no new entry created), 'enqueued' when a new entry was added.
      const action = enqueued.length > 0 ? 'enqueued' : 'coalesced';
      deps.socketManager.emitToUser(opts.userId, 'queue_updated', {
        threadId,
        queue: deps.invocationQueue.list(threadId, opts.userId),
        action,
      });
    }
    log.info(
      {
        threadId,
        triggerMessageId,
        callerCatId,
        targetCats,
        queueDiagnostics,
        enqueued,
      },
      '[DIAG/a2a] enqueueA2ATargets queue scan',
    );
    // Trigger auto-execute for entries whose target slot is free
    await deps.queueProcessor?.tryAutoExecute?.(threadId);
    log.info(
      { threadId, triggerMessageId, enqueued, coalesced, targetCats },
      enqueued.length > 0
        ? '[F122B] A2A callback: enqueued to InvocationQueue'
        : '[F122B] A2A callback: no new InvocationQueue entries enqueued',
    );
    return { enqueued, coalesced, fallback: false };
  }

  // Legacy path: F27 worklist + standalone fallback (when invocationQueue dep not wired)
  // F27: Try to push to parent worklist first
  if (hasWorklist(threadId)) {
    // F167 Phase D: fail-closed callerActivity — callback has no tool_use stream,
    // outputLength from content exempts long-form discussion.
    const pushResult = pushToWorklist(threadId, targetCats, callerCatId, opts.parentInvocationId, triggerMessageId, {
      hadSubstantiveToolCall: false,
      outputLength: opts.content.length,
    });
    const enqueued = pushResult.added;
    if (enqueued.length > 0) {
      // F153 Phase I (Maine Coon round-2 P2): legacy worklist callback dispatch must also
      // mint the mention_dispatch span + a2a.dispatch.count counter. Use the lazy helper for
      // its side-effects; the returned trace context is unused here because route-serial
      // (which consumes the worklist) doesn't accept a callerTraceContext at worklist-push
      // time. Empty added / blocked branches still skip this (lazy = idempotent on first call).
      ensureDispatchTraceContext();
      if (deliveryCursorStore) {
        // F27 + #77: Best-effort auto-ack to prevent surprise backlog when cats later
        // call pending-mentions. This intentionally advances the mention-ack cursor
        // using the current trigger message ID (cursor semantics, not a per-message receipt).
        //
        // Best-effort: ack failure should NOT fail /post-message, since the message has
        // already been stored/broadcast; failing would cause retries/duplicates and amplify noise.
        const ackTargets = enqueued.filter((catId) => opts.triggerMessage.mentions.includes(catId));
        const results = await Promise.allSettled(
          ackTargets.map((catId) =>
            deliveryCursorStore.ackMentionCursor(opts.userId, catId, opts.threadId, triggerMessageId),
          ),
        );
        const failed = results
          .map((r, i) => ({ r, catId: ackTargets[i] }))
          .filter((x): x is { r: PromiseRejectedResult; catId: CatId } => x.r.status === 'rejected');
        if (failed.length > 0) {
          log.warn(
            {
              threadId,
              triggerMessageId,
              failedAckCats: failed.map((f) => f.catId),
            },
            '[F27] A2A callback: mention auto-ack failed (best-effort)',
          );
        }
      }
      log.info(
        {
          threadId,
          triggerMessageId,
          enqueued,
          targetCats,
        },
        '[F27] A2A callback: enqueued targets to parent worklist',
      );
      return { enqueued, fallback: false };
    } else if (pushResult.reason === 'not_found') {
      // F122 AC-A3: Race condition — worklist vanished between hasWorklist() and pushToWorklist().
      // Fall through to standalone invocation path below.
      log.warn(
        { threadId, triggerMessageId, targetCats },
        '[F27] A2A callback: worklist vanished between has/push, falling back to standalone',
      );
    } else {
      if (pushResult.blockPingPong) {
        // F167 L1 AC-A4: streak=4 — callback path must broadcast termination,
        // parity with route-serial's inline block emit.
        log.info(
          { threadId, triggerMessageId, fromCatId, targetCats, pairCount: pushResult.pairCount },
          'F167 L1: callback A2A ping-pong terminated (streak >= 4)',
        );
        deps.socketManager.broadcastAgentMessage(
          {
            type: 'system_info',
            catId: fromCatId,
            content: JSON.stringify({
              type: 'a2a_pingpong_terminated',
              fromCatId,
              targetCatId: targetCats[0],
              pairCount: pushResult.pairCount ?? 0,
            }),
            timestamp: Date.now(),
          },
          threadId,
        );
      } else {
        log.info(
          {
            threadId,
            triggerMessageId,
            targetCats,
            reason: pushResult.reason,
          },
          `[F27] A2A callback: targets not enqueued (${pushResult.reason})`,
        );
      }
      return { enqueued, fallback: false };
    }
  }

  // Fallback: no parent worklist — start standalone invocation.
  // F108 slot-aware: tracker.start() only aborts same (threadId, catId) slot,
  // so starting codex won't abort opus. Only skip targets already running.
  const { invocationTracker } = deps;
  if (invocationTracker?.has(threadId)) {
    // Guard: shims may not implement getActiveSlots — fall back to empty (allow all)
    const activeSlotIds = (invocationTracker.getActiveSlots?.(threadId) ?? []).map((s) =>
      typeof s === 'string' ? s : s.catId,
    );
    const nonConflicting = targetCats.filter((catId) => !activeSlotIds.includes(catId));
    if (nonConflicting.length === 0) {
      log.info(
        { threadId, targetCats, activeSlotIds },
        '[F27] A2A fallback skipped: all targets already active in thread slots',
      );
      return { enqueued: [], fallback: true };
    }
    if (nonConflicting.length < targetCats.length) {
      log.info(
        { threadId, targetCats, activeSlotIds, nonConflicting },
        '[F27] A2A fallback: filtered already-active targets, proceeding with remaining',
      );
    }
    // Proceed with non-conflicting targets only
    await triggerA2AInvocation(deps, {
      ...opts,
      targetCats: nonConflicting,
      callerTraceContext: ensureDispatchTraceContext(),
    });
    return { enqueued: nonConflicting, fallback: true };
  }

  // Create standalone invocation like the old triggerA2AInvocation
  log.warn(
    {
      threadId,
      targetCats,
    },
    '[F27] A2A callback: no parent worklist found, falling back to standalone invocation',
  );

  // F167 PR1 history note: originally this path filtered role-gated targets before
  // fallback; Phase E retires L3, so targetCats == opts.targetCats now. Kept the
  // explicit spread for intent clarity and future filter hooks.
  await triggerA2AInvocation(deps, { ...opts, targetCats, callerTraceContext: ensureDispatchTraceContext() });
  return { enqueued: targetCats, fallback: true };
}

/**
 * Legacy standalone invocation (fallback + backward compat).
 * Kept for edge cases where callback fires outside a routeSerial context.
 */
export async function triggerA2AInvocation(
  deps: A2ATriggerDeps,
  opts: {
    targetCats: CatId[];
    content: string;
    userId: string;
    threadId: string;
    triggerMessage: StoredMessage;
    /** F153: caller trace context for cross-route A2A propagation */
    callerTraceContext?: CallerTraceContext;
  },
): Promise<void> {
  const { router, invocationRecordStore, socketManager, invocationTracker, log } = deps;
  const { targetCats, content, userId, threadId, triggerMessage } = opts;
  const statusCatId = targetCats[0] ?? getDefaultCatId();
  const intent = parseIntent(content, targetCats.length);

  // F108 slot-aware: tracker.start(threadId, catId) only aborts the SAME slot,
  // so starting a different cat won't abort the parent. Only skip if all targets
  // are already covered by active slots (redundancy short-circuit).
  const parentActive = invocationTracker?.has(threadId) ?? false;
  if (parentActive) {
    const activeCats = (invocationTracker?.getActiveSlots?.(threadId) ?? []).map((s) =>
      typeof s === 'string' ? s : s.catId,
    );
    // Redundant A2A short-circuit (砚砚 4ee660b defense-in-depth):
    // if parent already includes all targets, skip entirely.
    if (targetCats.length > 0 && targetCats.every((catId) => activeCats.includes(catId))) {
      log.info(
        {
          threadId,
          targetCats,
          activeCats,
          triggerMessageId: triggerMessage.id,
        },
        '[callbacks] A2A skipped: target already covered by active parent invocation',
      );
      return;
    }
    // Targets differ from active slots — safe to proceed because
    // tracker.start() is slot-aware and won't abort other cats' slots.
    log.info(
      {
        threadId,
        targetCats,
        activeCats,
        triggerMessageId: triggerMessage.id,
      },
      '[F27] A2A standalone: parent active in different slots, safe to start new targets',
    );
  }

  const createResult = await invocationRecordStore.create({
    threadId,
    userId,
    targetCats,
    intent: intent.intent,
    idempotencyKey: triggerMessage.id,
  });

  if (createResult.outcome === 'duplicate') return;

  // Safe: no active parent invocation, so tracker.start() won't abort anything unexpected.
  const controller = invocationTracker?.start(threadId, statusCatId, userId, targetCats);
  if (controller?.signal.aborted) {
    invocationTracker?.complete(threadId, statusCatId, controller);
    await invocationRecordStore.update(createResult.invocationId, {
      status: 'canceled',
    });
    return;
  }

  await invocationRecordStore.update(createResult.invocationId, {
    userMessageId: triggerMessage.id,
  });

  const { queueProcessor } = deps;

  // Background execution — fire and forget
  void (async () => {
    let finalStatus: 'succeeded' | 'failed' | 'canceled' = 'failed';
    try {
      await invocationRecordStore.update(createResult.invocationId, {
        status: 'running',
      });

      // #768: Defer intent_mode broadcast until CLI produces first event.
      let intentModeBroadcast = false;

      // F070: track governance block errorCode for recoverable failure marking
      let governanceErrorCode: string | undefined;

      for await (const msg of router.routeExecution(userId, content, threadId, triggerMessage.id, targetCats, intent, {
        ...(controller?.signal ? { signal: controller.signal } : {}),
        parentInvocationId: createResult.invocationId,
        callerTraceContext: opts.callerTraceContext,
        a2aTriggerMessageId: triggerMessage.id,
        // F222 P1: A2A direct execution is not user-origin — suppress frustration detection
        frustrationAutoIssueEligible: false,
      })) {
        // #768: Broadcast intent_mode on first CLI event — proves CLI is alive.
        if (!intentModeBroadcast) {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', {
            threadId,
            mode: intent.intent,
            targetCats,
            invocationId: createResult.invocationId,
          });
          intentModeBroadcast = true;
        }
        if (controller?.signal.aborted) break;
        if (msg.type === 'done' && msg.errorCode) {
          governanceErrorCode = msg.errorCode;
        }
        // F194 Phase Z9 (砚砚 R1 P1-2): unified visible turn stamp via helper.
        socketManager.broadcastAgentMessage(
          { ...msg, ...stampVisibleTurn(createResult.invocationId, msg.invocationId) },
          threadId,
        );
      }

      if (controller?.signal.aborted) {
        finalStatus = 'canceled';
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'canceled',
        });
      } else if (governanceErrorCode) {
        // F070: Governance gate blocked — mark as failed with errorCode for retry
        finalStatus = 'failed';
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'failed',
          error: governanceErrorCode,
        });
      } else {
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'succeeded',
        });
        finalStatus = 'succeeded';
      }
    } catch (err) {
      if (controller?.signal.aborted) {
        finalStatus = 'canceled';
        await invocationRecordStore.update(createResult.invocationId, {
          status: 'canceled',
        });
      } else {
        log.error(`[callbacks] Standalone A2A invocation failed: ${String(err)}`);
        try {
          await invocationRecordStore.update(createResult.invocationId, {
            status: 'failed',
            ...(err instanceof Error ? { error: err.message } : {}),
          });
        } catch {
          /* best-effort */
        }
        socketManager.broadcastAgentMessage(
          {
            type: 'error',
            catId: statusCatId,
            error: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          },
          threadId,
        );
        socketManager.broadcastAgentMessage(
          {
            type: 'done',
            catId: statusCatId,
            isFinal: true,
            timestamp: Date.now(),
          },
          threadId,
        );
      }
    } finally {
      if (controller) {
        invocationTracker?.complete(threadId, statusCatId, controller);
      }
      queueProcessor?.onInvocationComplete(threadId, statusCatId, finalStatus).catch(() => {
        /* best-effort */
      });
    }
  })();
}
