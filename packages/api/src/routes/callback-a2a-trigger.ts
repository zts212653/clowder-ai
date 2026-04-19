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
import { getDefaultCatId, getRoster } from '../config/cat-config-loader.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import { checkRoleCompat, type RoleLookup } from '../domains/cats/services/agents/routing/role-gate.js';
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
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface QueueProcessorLike {
  onInvocationComplete(threadId: string, catId: string, status: 'succeeded' | 'failed' | 'canceled'): Promise<void>;
  tryAutoExecute?(threadId: string): Promise<void>;
}

export interface A2ATriggerDeps {
  router: AgentRouter;
  invocationRecordStore: IInvocationRecordStore;
  socketManager: SocketManager;
  invocationTracker?: InvocationTracker;
  deliveryCursorStore?: DeliveryCursorStore;
  queueProcessor?: QueueProcessorLike;
  /** F122B: InvocationQueue for agent-sourced entries */
  invocationQueue?: Pick<
    InvocationQueue,
    | 'enqueue'
    | 'countAgentEntriesForThread'
    | 'hasQueuedAgentForCat'
    | 'backfillMessageId'
    | 'appendMergedMessageId'
    | 'list'
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
  },
): Promise<{ enqueued: CatId[]; fallback: boolean }> {
  const { log } = deps;
  const { threadId, callerCatId } = opts;
  const triggerMessageId = opts.triggerMessage.id;
  const { deliveryCursorStore } = deps;

  // F167 L3 AC-A7: gate callback-path A2A handoff by role compatibility (designer + coding → reject).
  // Upstream filter: rejected targets never reach invocationQueue/worklist/standalone paths.
  // Emits a2a_role_rejected via socketManager (parity with route-serial text-scan path).
  const roster = getRoster();
  const roleLookup: RoleLookup = (cid) => {
    const entry = roster[cid];
    return entry ? { roles: entry.roles } : undefined;
  };
  const allowedTargets: CatId[] = [];
  const fromCatId = callerCatId ?? opts.triggerMessage.catId ?? getDefaultCatId();
  for (const cat of opts.targetCats) {
    const gate = checkRoleCompat(cat, opts.content, roleLookup);
    if (!gate.allowed) {
      log.info(
        { threadId, catId: cat, fromCat: fromCatId, action: gate.action, reason: gate.reason },
        'F167 L3: callback-a2a role-gate rejected handoff',
      );
      deps.socketManager.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: fromCatId,
          content: JSON.stringify({
            type: 'a2a_role_rejected',
            targetCatId: cat,
            fromCatId,
            action: gate.action,
            reason: gate.reason,
          }),
          timestamp: Date.now(),
        },
        threadId,
      );
      continue;
    }
    allowedTargets.push(cat);
  }
  if (allowedTargets.length === 0) {
    log.info(
      { threadId, triggerMessageId, originalTargets: opts.targetCats },
      'F167 L3: all callback targets rejected',
    );
    return { enqueued: [], fallback: false };
  }
  const targetCats = allowedTargets;

  // F122B: If InvocationQueue is available, enqueue as agent entry (unified dispatch).
  // This replaces both the worklist path and the fallback standalone invocation.
  // Guards mirror worklist protections: depth limit, duplicate detection.
  if (deps.invocationQueue) {
    // F167 L1 AC-A4: streak check must cover modern InvocationQueue path too (no bypass).
    // Only 1:1 A2A (single target + known caller) participates in streak — fan-out is excluded.
    // Streak state lives on the parent's WorklistEntry; if no worklist is active, skip gracefully.
    if (callerCatId !== undefined && targetCats.length === 1) {
      const entry = getWorklist(threadId, opts.parentInvocationId);
      if (entry) {
        const streak = updateStreakOnPush(entry, callerCatId, targetCats[0]);
        if (streak.blockPingPong) {
          log.info(
            { threadId, triggerMessageId, fromCatId, targetCats, pairCount: streak.count },
            'F167 L1: callback A2A (invocationQueue) ping-pong terminated (streak >= 4)',
          );
          deps.socketManager.broadcastAgentMessage(
            {
              type: 'system_info',
              catId: fromCatId,
              content: JSON.stringify({
                type: 'a2a_pingpong_terminated',
                fromCatId,
                targetCatId: targetCats[0],
                pairCount: streak.count,
              }),
              timestamp: Date.now(),
            },
            threadId,
          );
          return { enqueued: [], fallback: false };
        }
        // streak.warnPingPong → injected via buildInvocationContext on next turn, no-op here.
      }
    }

    const MAX_A2A_DEPTH = 10;

    const enqueued: CatId[] = [];
    const queueDiagnostics: Array<{
      catId: CatId;
      outcome: string; // enqueue() returns 'enqueued'|'merged'; 'full' unreachable here (depth guard breaks first)
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
      // Guard 2: Duplicate detection — skip cats already queued as agent entries
      if (deps.invocationQueue.hasQueuedAgentForCat(threadId, catId)) {
        log.info({ threadId, triggerMessageId, catId }, '[F122B] A2A callback: skipping duplicate agent entry for cat');
        continue;
      }
      const result = deps.invocationQueue.enqueue({
        threadId,
        userId: opts.userId,
        content: opts.content,
        source: 'agent',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        callerCatId: callerCatId ?? undefined,
      });
      queueDiagnostics.push({
        catId,
        outcome: result.outcome,
        entryId: result.entry?.id,
        createdAt: result.entry?.createdAt,
      });
      if (result.outcome === 'enqueued' || result.outcome === 'merged') {
        enqueued.push(catId);
        // AC-B6-P1: Link triggerMessage.id so QueueProcessor.executeEntry can markDelivered.
        // Use backfillMessageId for new entries, appendMergedMessageId for merged entries
        // to avoid overwriting the first entry's messageId (cloud P1).
        if (result.entry) {
          if (result.outcome === 'enqueued') {
            deps.invocationQueue.backfillMessageId(threadId, opts.userId, result.entry.id, triggerMessageId);
          } else {
            deps.invocationQueue.appendMergedMessageId(threadId, opts.userId, result.entry.id, triggerMessageId);
          }
        }
      }
    }
    // Best-effort auto-ack mentions (same as worklist path)
    if (deliveryCursorStore && enqueued.length > 0) {
      const ackTargets = enqueued.filter((catId) => opts.triggerMessage.mentions.includes(catId));
      await Promise.allSettled(
        ackTargets.map((catId) => deliveryCursorStore.ackMentionCursor(opts.userId, catId, threadId, triggerMessageId)),
      );
    }
    if (enqueued.length > 0) {
      deps.socketManager.emitToUser(opts.userId, 'queue_updated', {
        threadId,
        queue: deps.invocationQueue.list(threadId, opts.userId),
        action: 'enqueued',
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
    log.info({ threadId, triggerMessageId, enqueued, targetCats }, '[F122B] A2A callback: enqueued to InvocationQueue');
    return { enqueued, fallback: false };
  }

  // Legacy path: F27 worklist + standalone fallback (when invocationQueue dep not wired)
  // F27: Try to push to parent worklist first
  if (hasWorklist(threadId)) {
    const pushResult = pushToWorklist(threadId, targetCats, callerCatId, opts.parentInvocationId, triggerMessageId);
    const enqueued = pushResult.added;
    if (enqueued.length > 0) {
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
    await triggerA2AInvocation(deps, { ...opts, targetCats: nonConflicting });
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

  // Cloud P1 (F167 PR1): must pass FILTERED targetCats — opts.targetCats is the
  // pre-filter list; handing it to triggerA2AInvocation would bypass role-gate.
  await triggerA2AInvocation(deps, { ...opts, targetCats });
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
        socketManager.broadcastAgentMessage({ ...msg, invocationId: createResult.invocationId }, threadId);
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
