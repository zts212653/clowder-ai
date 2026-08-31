/**
 * A2A invocation trigger for MCP callback post_message (F27 rewrite).
 *
 * Callback mentions enter the same InvocationQueue lifecycle as every other
 * message. There is no direct routeExecution fallback.
 */

import type { CatId } from '@cat-cafe/shared';
import type { ActionSuccessorFence } from '../domains/ball-custody/ActionSuccessorAdmissionService.js';
import type { IBallCustodyIngest } from '../domains/ball-custody/BallCustodyIngest.js';
import { buildHandedEvent } from '../domains/ball-custody/ball-custody-events.js';
import type { InvocationQueue, QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  normalizeOwnerAuthProvenance,
  type OwnerAuthProvenance,
} from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import {
  createCrossThreadQueueEntryFromCustody,
  createFanoutQueueCustodyAdmission,
  createInitialCrossThreadQueuedMessageCustody,
  createInitialFanoutQueuedMessageCustody,
  fanoutQueueCarrierIdempotencyKey,
  fanoutQueueCustodyAdmissionId,
  readCompleteCrossThreadQueueCarrierGroups,
  rebindCrossThreadQueueCarrierActionFence,
  sameFanoutCustodyIdentity,
} from '../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import {
  callerActivityFromMessage,
  type DurableA2ALineage,
  readDurableA2ALineage,
} from '../domains/cats/services/agents/routing/durable-a2a-lineage.js';
import type { CallerActivity } from '../domains/cats/services/agents/routing/WorklistRegistry.js';
import {
  getWorklist,
  peekStreakOnPush,
  updateStreakOnPush,
} from '../domains/cats/services/agents/routing/WorklistRegistry.js';
import type {
  AppendMessageInput,
  IMessageStore,
  LifecycleResponseTerminalPatch,
  QueuedMessageCustody,
  StoredMessage,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import {
  commitLifecycleResponseFromAppendInput,
  initializeQueueCustodyWithLifecycleRetry,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import { wrapWithDispatchSpan } from '../infrastructure/telemetry/dispatch-span.js';
import type { CallerTraceContext } from '../infrastructure/telemetry/genai-semconv.js';
import { emitQueueUpdated } from '../utils/queue-enrichment.js';

interface A2ATriggerSocketManager {
  emitToUser(userId: string, event: string, data: unknown): void;
  broadcastAgentMessage(message: unknown, threadId: string): void;
}

interface A2ATriggerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface QueueProcessorLike {
  requestDrain?(threadId: string): Promise<void>;
  /** F216 c3 supersede: releaseSlot force-frees the per-slot processingSlots
   * mutex so the next drain sees a free slot. */
  releaseSlot?(threadId: string, catId: string): void;
}

export interface A2ATriggerDeps {
  socketManager: A2ATriggerSocketManager;
  invocationTracker?: {
    has(threadId: string, catId: string): boolean;
    cancelInvocation(threadId: string, catIds: string[], userId?: string, reason?: string): unknown;
  };
  queueProcessor?: QueueProcessorLike;
  /** #706: MessageStore for queue enrichment (messagePreview in queue_updated SSE). */
  messageStore?: IMessageStore;
  /** F167 Phase T: persist accepted A2A dispatch custody before the child can execute. */
  ballCustody?: IBallCustodyIngest;
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
    | 'commitQueueCustodyAdmission'
    | 'getEntrySnapshot'
    | 'list'
    | 'rollbackEnqueue'
    | 'restoreDurableEntry'
    | 'restoreEntrySnapshotIfUnchanged'
    // F216 c3: removeProcessed clears the superseded processing entry so it cannot re-run.
    | 'removeProcessed'
  >;
  log: A2ATriggerLogger;
}

function emitLifecycleMessageUpdated(
  socketManager: A2ATriggerSocketManager,
  userId: string,
  message: StoredMessage,
): void {
  if (!message.lifecycle) return;
  socketManager.emitToUser(userId, 'message_lifecycle_updated', {
    threadId: message.threadId,
    message: {
      id: message.id,
      ...(message.from ? { from: message.from } : {}),
      catId: message.catId,
      content: message.content,
      lifecycle: message.lifecycle,
      timestamp: message.timestamp,
      ...(message.timelineOrderAt !== undefined ? { timelineOrderAt: message.timelineOrderAt } : {}),
      ...(message.contentBlocks ? { contentBlocks: message.contentBlocks } : {}),
      ...(message.extra ? { extra: message.extra } : {}),
      ...(message.origin ? { origin: message.origin } : {}),
    },
  });
}

export interface A2AFanoutAdmissionPlan {
  requestedTargetCats: readonly CatId[];
  acceptedTargetCats: readonly CatId[];
  streakTargetCats: readonly CatId[];
  stop?:
    | { reason: 'depth'; catId: CatId; currentDepth: number }
    | { reason: 'pingpong'; catId: CatId; pairCount: number };
}

interface A2AFanoutAdmissionOptions {
  targetCats: readonly CatId[];
  content: string;
  userId: string;
  ownerAuthProvenance: OwnerAuthProvenance;
  threadId: string;
  createdAt: number;
  callerCatId?: CatId;
  parentInvocationId?: string;
  isCrossThread?: boolean;
  actionSuccessorFence?: ActionSuccessorFence;
  durableLineage?: DurableA2ALineage;
  callerActivity?: CallerActivity;
}

/**
 * Decide the complete A2A fan-out before the source message is published.
 * This is deliberately read-only: streak mutation and Queue staging happen
 * only after the durable message + admission record has committed.
 */
export function planA2AFanoutAdmission(
  deps: Pick<A2ATriggerDeps, 'invocationQueue'>,
  opts: A2AFanoutAdmissionOptions,
): A2AFanoutAdmissionPlan {
  const invocationQueue = deps.invocationQueue;
  if (!invocationQueue) throw new Error('A2A dispatch requires InvocationQueue');
  const ownerAuthProvenance = normalizeOwnerAuthProvenance(opts.ownerAuthProvenance);
  const streakCallerCatId = opts.targetCats.length === 1 ? opts.callerCatId : undefined;
  const streakEntry = streakCallerCatId ? getWorklist(opts.threadId, opts.parentInvocationId) : null;
  const maxA2ADepth = streakEntry?.maxDepth ?? 10;
  const streakActivity =
    opts.callerActivity ??
    ({
      hadSubstantiveToolCall: false,
      outputLength: opts.content.length,
    } as const);
  const acceptedTargetCats: CatId[] = [];
  const streakTargetCats: CatId[] = [];
  let stop: A2AFanoutAdmissionPlan['stop'];
  let predictedDepth =
    opts.durableLineage?.depth ?? streakEntry?.a2aCount ?? invocationQueue.countAgentEntriesForThread(opts.threadId);
  const streakState = opts.durableLineage ?? streakEntry;

  for (const catId of opts.targetCats) {
    if (predictedDepth >= maxA2ADepth) {
      stop = { reason: 'depth', catId, currentDepth: predictedDepth };
      break;
    }
    const inFlight = opts.actionSuccessorFence
      ? null
      : (invocationQueue.findInFlightAgentEntry?.(
          opts.threadId,
          catId,
          opts.callerCatId,
          opts.parentInvocationId,
          ownerAuthProvenance,
        ) ?? null);
    const willCoalesce = inFlight?.status === 'queued';
    if (streakCallerCatId && streakState && !willCoalesce) {
      const streak = peekStreakOnPush(streakState, streakCallerCatId, catId, streakActivity);
      if (streak.wouldBlock) {
        stop = { reason: 'pingpong', catId, pairCount: streak.count };
        break;
      }
      streakTargetCats.push(catId);
    }
    acceptedTargetCats.push(catId);
    if (!inFlight) predictedDepth += 1;
  }

  return {
    requestedTargetCats: [...opts.targetCats],
    acceptedTargetCats,
    streakTargetCats,
    ...(stop ? { stop } : {}),
  };
}

export function createA2AFanoutAdmissionFromPlan(
  messageId: string,
  plan: A2AFanoutAdmissionPlan,
  opts: A2AFanoutAdmissionOptions,
) {
  return createFanoutQueueCustodyAdmission(messageId, {
    ownerUserId: opts.userId,
    ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
    targetCats: plan.acceptedTargetCats,
    requestedTargetCats: plan.requestedTargetCats,
    intent: 'execute',
    ...(opts.parentInvocationId ? { a2aParentInvocationId: opts.parentInvocationId } : {}),
    ...(opts.isCrossThread ? { receiptScope: 'cross_thread_delivery' as const } : {}),
    ...(opts.actionSuccessorFence ? { actionSuccessorFence: opts.actionSuccessorFence } : {}),
    createdAt: opts.createdAt,
  });
}

export async function commitCompletedResponseAndEnqueueA2ATargets(
  deps: A2ATriggerDeps,
  opts: {
    responseMessageId: string;
    invocationId: string;
    terminal: Pick<LifecycleResponseTerminalPatch, 'status' | 'completedAt' | 'reason'>;
    message: AppendMessageInput;
    targetCats: CatId[];
    userId: string;
    ownerAuthProvenance: OwnerAuthProvenance;
    threadId: string;
    callerCatId: CatId;
    parentInvocationId?: string;
    callerTraceContext?: CallerTraceContext;
  },
): Promise<StoredMessage> {
  if (opts.terminal.status !== 'completed') {
    throw new Error('completed response A2A wake requires a completed terminal');
  }
  if (!deps.messageStore) throw new Error('completed response A2A wake requires MessageStore');
  const causalTriggerMessageId = opts.message.extra?.causal?.triggerMessageId;
  const durableLineage = causalTriggerMessageId
    ? await readDurableA2ALineage(deps.messageStore, causalTriggerMessageId, opts.callerCatId)
    : undefined;
  const admissionOptions: A2AFanoutAdmissionOptions = {
    targetCats: opts.targetCats,
    content: opts.message.content,
    userId: opts.userId,
    ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
    threadId: opts.threadId,
    createdAt: opts.terminal.completedAt,
    callerCatId: opts.callerCatId,
    ...(durableLineage ? { durableLineage } : {}),
    callerActivity: callerActivityFromMessage(opts.message),
    ...(opts.parentInvocationId ? { parentInvocationId: opts.parentInvocationId } : {}),
  };
  const plan = planA2AFanoutAdmission(deps, admissionOptions);
  const stored = await commitLifecycleResponseFromAppendInput(
    deps.messageStore,
    opts.responseMessageId,
    opts.invocationId,
    opts.terminal,
    opts.message,
    plan.acceptedTargetCats.length > 0
      ? (messageId) => createA2AFanoutAdmissionFromPlan(messageId, plan, admissionOptions)
      : undefined,
  );

  if (plan.acceptedTargetCats.length === 0) {
    if (plan.stop?.reason === 'depth') {
      deps.log.warn(
        {
          threadId: opts.threadId,
          triggerMessageId: stored.id,
          catId: plan.stop.catId,
          currentDepth: plan.stop.currentDepth,
        },
        '[F122B] completed response A2A: depth limit reached',
      );
    } else if (plan.stop?.reason === 'pingpong') {
      const worklist = getWorklist(opts.threadId, opts.parentInvocationId);
      if (worklist) {
        updateStreakOnPush(worklist, opts.callerCatId, plan.stop.catId, {
          hadSubstantiveToolCall: false,
          outputLength: opts.message.content.length,
        });
      }
      deps.socketManager.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: opts.callerCatId,
          content: JSON.stringify({
            type: 'a2a_pingpong_terminated',
            fromCatId: opts.callerCatId,
            targetCatId: plan.stop.catId,
            pairCount: plan.stop.pairCount,
          }),
          timestamp: Date.now(),
        },
        opts.threadId,
      );
    }
    return stored;
  }

  await enqueueA2ATargets(deps, {
    targetCats: opts.targetCats,
    content: opts.message.content,
    userId: opts.userId,
    ownerAuthProvenance: opts.ownerAuthProvenance,
    threadId: opts.threadId,
    triggerMessage: stored,
    callerCatId: opts.callerCatId,
    ...(opts.parentInvocationId ? { parentInvocationId: opts.parentInvocationId } : {}),
    ...(opts.callerTraceContext ? { callerTraceContext: opts.callerTraceContext } : {}),
    preplannedAdmission: plan,
  });
  return (await deps.messageStore.getById(stored.id)) ?? stored;
}

/**
 * Enqueue @mentioned cats into the canonical InvocationQueue lifecycle.
 */
export async function enqueueA2ATargets(
  deps: A2ATriggerDeps,
  opts: {
    targetCats: CatId[];
    content: string;
    userId: string;
    /** Inherited unchanged from the authenticated parent invocation, or explicit unknown. */
    ownerAuthProvenance: OwnerAuthProvenance;
    threadId: string;
    triggerMessage: StoredMessage;
    /** The cat that triggered this A2A callback (for worklist caller guard). */
    callerCatId?: CatId;
    /** F108: parentInvocationId for concurrent worklist isolation. */
    parentInvocationId?: string;
    /** F153: caller trace context for cross-route A2A propagation */
    callerTraceContext?: CallerTraceContext;
    /** F167 Phase S: persistent subject/action/slot generation fence. */
    actionSuccessorFence?: ActionSuccessorFence;
    /** Exact policy plan already persisted with a newly appended source message. */
    preplannedAdmission?: A2AFanoutAdmissionPlan;
  },
): Promise<{ enqueued: CatId[]; coalesced?: CatId[] }> {
  if (!deps.invocationQueue || !deps.queueProcessor?.requestDrain) {
    throw new Error('A2A dispatch requires InvocationQueue and QueueProcessor');
  }
  const { log } = deps;
  const { threadId, callerCatId } = opts;
  const ownerAuthProvenance = normalizeOwnerAuthProvenance(opts.ownerAuthProvenance);
  const triggerMessageId = opts.triggerMessage.id;
  const isCrossThread =
    !!opts.triggerMessage.extra?.crossPost?.sourceThreadId &&
    opts.triggerMessage.extra.crossPost.sourceThreadId !== opts.triggerMessage.threadId;
  if (!deps.messageStore) {
    throw new Error('A2A Queue dispatch requires durable message custody');
  }
  let persistedQueueTrigger = await deps.messageStore.getById(triggerMessageId);
  if (
    !persistedQueueTrigger ||
    persistedQueueTrigger.from?.kind !== 'agent' ||
    persistedQueueTrigger.deliveryStatus === 'queued' ||
    persistedQueueTrigger.deliveryStatus === 'canceled' ||
    persistedQueueTrigger.visibility === 'whisper' ||
    persistedQueueTrigger.recall ||
    persistedQueueTrigger._tombstone
  ) {
    throw new Error('A2A Queue dispatch requires one persisted public agent source message');
  }
  // F167 Phase E (KD-20): L3 role-gate retired. Role-based handoff permission is
  // no longer harness-enforced — cat-config.restrictions flows into sender & target
  // prompts (buildTeammateRoster / buildStaticIdentity); cats self-regulate.
  const fromCatId = persistedQueueTrigger.from.catId as CatId;
  if (callerCatId && callerCatId !== fromCatId) {
    throw new Error('A2A Queue dispatch caller does not match persisted MessageFrom');
  }
  const targetCats = opts.targetCats;

  // F153 Phase I (Maine Coon P1): Lazy-create mention_dispatch span + a2a.dispatch.count counter
  // ONLY when a target is about to actually dispatch (passes all guards and reaches a real enqueue
  // invocation). Pre-creating would mint span/counter even when ALL cats are blocked
  // by depth limit / dedup / ping-pong streak — polluting Step Summary
  // a2a_dispatch_count with phantom dispatches.
  let dispatchTraceContext: CallerTraceContext | undefined;
  const ensureDispatchTraceContext = (): CallerTraceContext | undefined => {
    if (dispatchTraceContext === undefined && opts.callerTraceContext) {
      dispatchTraceContext = wrapWithDispatchSpan(opts.callerTraceContext, targetCats.length, fromCatId);
    }
    return dispatchTraceContext;
  };

  // Every A2A child uses the same queue admission path. Guards retain the
  // depth, duplicate, and ping-pong policies at that single boundary.
  {
    const MAX_A2A_DEPTH = 10;

    // F167 L1 AC-A4 + Phase D (cloud Codex P1): streak check must cover modern path
    // AND only fire when we know the target is actually about to enqueue — otherwise
    // a callback that hits depth/dedup would still mutate the counter (reset by
    // substantive content, ++ by inertia), weakening the breaker.
    // Pre-resolve worklist entry once; updateStreakOnPush is called inside the loop.
    const streakCallerCatId = targetCats.length === 1 ? callerCatId : undefined;
    const canTrackStreak = streakCallerCatId !== undefined;
    const streakEntry = canTrackStreak ? getWorklist(threadId, opts.parentInvocationId) : null;
    const streakActivity = {
      hadSubstantiveToolCall: false,
      outputLength: opts.content.length,
    } as const;
    const findInFlightForTarget = (catId: CatId): QueueEntry | null =>
      opts.actionSuccessorFence
        ? null
        : (deps.invocationQueue?.findInFlightAgentEntry?.(
            threadId,
            catId,
            callerCatId,
            opts.parentInvocationId,
            ownerAuthProvenance,
          ) ?? null);

    // The durable admission is the policy decision, not merely the request.
    // Decide the complete fan-out before staging any process-local carrier so a
    // crash can only reconstruct targets the ordinary enqueue path accepted.
    let admittedTargetCats: ReadonlySet<CatId> | undefined;
    const plannedStreakTargets = new Set<CatId>();
    let plannedStop:
      | { reason: 'depth'; catId: CatId; currentDepth: number }
      | { reason: 'pingpong'; catId: CatId; pairCount: number }
      | undefined;
    const admissionOptions: A2AFanoutAdmissionOptions = {
      targetCats,
      content: opts.content,
      userId: opts.userId,
      ownerAuthProvenance,
      threadId,
      createdAt: opts.triggerMessage.timestamp,
      ...(callerCatId ? { callerCatId } : {}),
      ...(opts.parentInvocationId ? { parentInvocationId: opts.parentInvocationId } : {}),
      ...(isCrossThread ? { isCrossThread: true } : {}),
      ...(opts.actionSuccessorFence ? { actionSuccessorFence: opts.actionSuccessorFence } : {}),
    };
    const validatePlan = (plan: A2AFanoutAdmissionPlan): void => {
      if (JSON.stringify(plan.requestedTargetCats) !== JSON.stringify(targetCats)) {
        throw new Error('A2A fan-out admission plan requested-target mismatch');
      }
      if (plan.acceptedTargetCats.some((catId) => !targetCats.includes(catId))) {
        throw new Error('A2A fan-out admission plan contains an unrequested target');
      }
    };
    let activePlan = opts.preplannedAdmission;
    if (activePlan) validatePlan(activePlan);
    if (!persistedQueueTrigger.queueCustody) {
      const existingAdmission = persistedQueueTrigger.queueCustodyAdmission;
      if (existingAdmission) {
        const requestedTargetCats = existingAdmission.requestedTargetCats ?? existingAdmission.targetCats;
        if (JSON.stringify(requestedTargetCats) !== JSON.stringify(targetCats)) {
          throw new Error('A2A fan-out Queue custody admission requested-target mismatch');
        }
        if (
          activePlan &&
          JSON.stringify(activePlan.acceptedTargetCats) !== JSON.stringify(existingAdmission.targetCats)
        ) {
          throw new Error('A2A fan-out Queue custody admission policy-plan mismatch');
        }
        admittedTargetCats = new Set(existingAdmission.targetCats);
      } else {
        activePlan ??= planA2AFanoutAdmission(deps, admissionOptions);
        validatePlan(activePlan);
        const admission = createA2AFanoutAdmissionFromPlan(triggerMessageId, activePlan, admissionOptions);
        const messageStore = deps.messageStore;
        if (!messageStore) throw new Error('A2A Queue dispatch requires durable message custody');
        const admissionResult = await messageStore.initializeQueueCustodyAdmission(triggerMessageId, admission);
        if (admissionResult.kind !== 'initialized' && admissionResult.kind !== 'existing') {
          throw new Error(`A2A fan-out Queue custody admission failed: ${admissionResult.kind}`);
        }
        persistedQueueTrigger = admissionResult.message;
        admittedTargetCats = new Set(admissionResult.message.queueCustodyAdmission?.targetCats ?? []);
      }
      if (activePlan) {
        for (const catId of activePlan.streakTargetCats) plannedStreakTargets.add(catId);
        plannedStop = activePlan.stop;
      }
      if (plannedStop?.reason === 'depth') {
        log.warn(
          {
            threadId,
            triggerMessageId,
            currentDepth: plannedStop.currentDepth,
            catId: plannedStop.catId,
          },
          '[F122B] A2A callback: depth limit reached, skipping remaining targets',
        );
      } else if (plannedStop?.reason === 'pingpong' && streakEntry && streakCallerCatId) {
        updateStreakOnPush(streakEntry, streakCallerCatId, plannedStop.catId, streakActivity);
        log.info(
          {
            threadId,
            triggerMessageId,
            fromCatId,
            catId: plannedStop.catId,
            pairCount: plannedStop.pairCount,
          },
          'F167 L1: callback A2A (invocationQueue) ping-pong terminated (streak >= 4)',
        );
        deps.socketManager.broadcastAgentMessage(
          {
            type: 'system_info',
            catId: fromCatId,
            content: JSON.stringify({
              type: 'a2a_pingpong_terminated',
              fromCatId,
              targetCatId: plannedStop.catId,
              pairCount: plannedStop.pairCount,
            }),
            timestamp: Date.now(),
          },
          threadId,
        );
      }
    }

    const enqueued: CatId[] = [];
    // F-coalesce: cats whose same-turn handoff was MERGED into an existing queued entry.
    // Tracked separately from `enqueued` because callbacks.ts derives body.routed from `enqueued`
    // — a coalesce is NOT a new A2A route (routed must stay []), but the caller's intent IS handled
    // (no duplicate dispatch, mention cursor still advances). Conflating the two falsely reports
    // "已路由" for a merge (the gate-caught regression: callback-a2a-postmsg.test.js).
    const coalesced: CatId[] = [];
    // One persisted source message owns one canonical fan-out admission. Recovery
    // races for that same message must join the same process-local fence instead
    // of minting competing tokens for the idempotently deduped Queue carriers.
    const queueCustodyAdmissionId = fanoutQueueCustodyAdmissionId(triggerMessageId);
    const stagedCustodyEntryIds = new Set<string>();
    const acceptedEntryByCatId = new Map<CatId, QueueEntry>();
    const restoredEntryByCatId = new Map<CatId, QueueEntry>();
    const newlyEnqueuedEntryIds: string[] = [];
    const coalescedEntryRollbacks = new Map<string, { before: QueueEntry; after: QueueEntry }>();
    const rollbackDurableAdmissions = (): void => {
      for (const entryId of newlyEnqueuedEntryIds) {
        deps.invocationQueue?.rollbackEnqueue(threadId, opts.userId, entryId);
      }
      for (const { before, after } of coalescedEntryRollbacks.values()) {
        const restored = deps.invocationQueue?.restoreEntrySnapshotIfUnchanged(after, before) ?? false;
        if (!restored) {
          log.error(
            { threadId, entryId: before.id, triggerMessageId },
            'durable A2A Queue coalesce rollback lost its exact compare-and-swap owner',
          );
        }
      }
    };
    const queueDiagnostics: Array<{
      catId: CatId;
      outcome: string;
      entryId?: string;
      createdAt?: number;
    }> = [];
    const persistedTrigger = persistedQueueTrigger;
    if (persistedTrigger?.queueCustody?.carrierByTargetCatId && deps.messageStore) {
      const existingCustody = persistedTrigger.queueCustody;
      const carrierByTargetCatId = existingCustody.carrierByTargetCatId;
      if (!carrierByTargetCatId) throw new Error('durable Queue custody carrier projection disappeared');
      const missingEntryIds = new Set(
        targetCats.flatMap((catId) => {
          const entryId = carrierByTargetCatId[catId]?.entryId;
          if (!entryId || deps.invocationQueue?.getEntrySnapshot(threadId, opts.userId, entryId)) return [];
          return [entryId];
        }),
      );
      if (missingEntryIds.size > 0) {
        const carrierMessagesByEntryId = await readCompleteCrossThreadQueueCarrierGroups(
          deps.messageStore,
          threadId,
          opts.userId,
          [...missingEntryIds],
        );
        for (const entryId of missingEntryIds) {
          let carrierMessages = carrierMessagesByEntryId.get(entryId);
          if (!carrierMessages) {
            throw new Error(`durable Queue carrier group was not enumerated for ${entryId}`);
          }
          if (!carrierMessages.some((message) => message.id === persistedTrigger.id)) {
            throw new Error(`durable Queue carrier group is incomplete for source ${persistedTrigger.id}/${entryId}`);
          }
          if (opts.actionSuccessorFence) {
            carrierMessages = await rebindCrossThreadQueueCarrierActionFence(
              deps.messageStore,
              carrierMessages,
              entryId,
              opts.actionSuccessorFence,
            );
          }
          const restoredProjection = createCrossThreadQueueEntryFromCustody(carrierMessages, entryId);
          deps.invocationQueue.restoreDurableEntry(restoredProjection);
        }
      }
      for (const catId of targetCats) {
        const entryId = carrierByTargetCatId[catId]?.entryId;
        if (!entryId || !existingCustody.pendingTargetCats.includes(catId)) continue;
        const snapshot = deps.invocationQueue.getEntrySnapshot(threadId, opts.userId, entryId);
        if (!snapshot || !snapshot.targetCats.includes(catId)) {
          throw new Error(`restored Queue carrier disappeared or lost target: ${entryId}/${catId}`);
        }
        restoredEntryByCatId.set(catId, snapshot);
      }
    }
    for (const catId of targetCats) {
      if (admittedTargetCats && !admittedTargetCats.has(catId)) continue;
      const restoredEntry = restoredEntryByCatId.get(catId);
      if (restoredEntry) {
        enqueued.push(catId);
        acceptedEntryByCatId.set(catId, restoredEntry);
        queueDiagnostics.push({
          catId,
          outcome: 'restored',
          entryId: restoredEntry.id,
          createdAt: restoredEntry.createdAt,
        });
        continue;
      }
      // Non-durable calls re-check depth here. Durable calls already persisted
      // their complete accepted/rejected partition before carrier staging.
      const currentDepth = deps.invocationQueue.countAgentEntriesForThread(threadId);
      if (!admittedTargetCats && currentDepth >= MAX_A2A_DEPTH) {
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
      // Action-scoped work has already been single-flighted by its durable lease.
      // Do not coalesce it into an unrelated unfenced handoff or supersede current work.
      const inFlight = findInFlightForTarget(catId);
      if (inFlight) {
        if (inFlight.status === 'queued') {
          const beforeCoalesce = persistedQueueTrigger
            ? deps.invocationQueue.getEntrySnapshot(threadId, inFlight.userId, inFlight.id)
            : null;
          // Not yet dispatched → merge content in place. The target sees both handoffs as one
          // coherent message. No duplicate entry.
          const merged =
            deps.invocationQueue.coalesceContentIntoQueuedAgent?.(
              threadId,
              inFlight.userId,
              inFlight.id,
              opts.content,
              triggerMessageId,
              callerCatId,
              opts.parentInvocationId,
              ownerAuthProvenance,
              catId,
              queueCustodyAdmissionId,
            ) ?? false;
          if (merged) {
            if (persistedQueueTrigger) {
              const afterCoalesce = deps.invocationQueue.getEntrySnapshot(threadId, inFlight.userId, inFlight.id);
              if (!beforeCoalesce || !afterCoalesce) {
                throw new Error('coalesced A2A target lost its exact Queue snapshot');
              }
              coalescedEntryRollbacks.set(inFlight.id, { before: beforeCoalesce, after: afterCoalesce });
            }
            // Merged into an existing queued entry — handled but NOT a new route (see `coalesced` decl).
            coalesced.push(catId);
            if (queueCustodyAdmissionId) stagedCustodyEntryIds.add(inFlight.id);
            acceptedEntryByCatId.set(catId, inFlight);
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
          // current execution completes via onInvocationComplete → requestDrain).
          const trackerRegistered = deps.invocationTracker?.has(threadId, catId) ?? false;
          if (trackerRegistered) {
            // Safe to abort: tracker has the slot, controller exists.
            deps.invocationTracker!.cancelInvocation(threadId, [catId], inFlight.userId, 'preempted');
            // Force-free the per-slot mutex — the async .catch hasn't deleted it yet.
            deps.queueProcessor?.releaseSlot?.(threadId, catId);
            // Remove the superseded processing entry so it cannot re-run.
            deps.invocationQueue?.removeProcessed?.(threadId, inFlight.userId, inFlight.id);
            log.info(
              { threadId, triggerMessageId, catId, supersededEntry: inFlight.id },
              '[F216-c3] supersede: aborted running handoff, follow-up will restart via requestDrain',
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
          // Fall through to enqueue the follow-up as a queued entry; requestDrain (called after
          // enqueue at line ~284) sees the freed slot and auto-starts it.
        }
      }
      // Guard 3 (F167 Phase D cloud Codex P1): streak check fires here — after
      // depth + dedup — so a would-be-skipped target never mutates the counter.
      // Callback path has no tool_use stream → fail-closed on hadSubstantiveToolCall
      // (routing tool ≠ work). outputLength from content still exempts long-form MCP.
      if (streakCallerCatId && streakEntry && (!admittedTargetCats || plannedStreakTargets.has(catId))) {
        const streak = updateStreakOnPush(streakEntry, streakCallerCatId, catId, streakActivity);
        if (!admittedTargetCats && streak.blockPingPong) {
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
      const carrierIdempotencyKey = opts.actionSuccessorFence
        ? `action:${opts.actionSuccessorFence.leaseId}:${opts.actionSuccessorFence.generation}:${catId}`
        : persistedQueueTrigger
          ? fanoutQueueCarrierIdempotencyKey(triggerMessageId, catId)
          : undefined;
      const result = deps.invocationQueue.enqueue({
        from: { kind: 'agent', catId: fromCatId },
        threadId,
        userId: opts.userId,
        kind: 'message_wake',
        ownerAuthProvenance,
        content: opts.content,
        messageId: triggerMessageId,
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        queueCustodyAdmissionId,
        a2aParentInvocationId: opts.parentInvocationId,
        callerTraceContext: ensureDispatchTraceContext(),
        a2aTriggerMessageId: triggerMessageId,
        ...(carrierIdempotencyKey ? { idempotencyKey: carrierIdempotencyKey } : {}),
        ...(opts.actionSuccessorFence ? { actionSuccessorFence: opts.actionSuccessorFence } : {}),
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
          acceptedEntryByCatId.set(catId, result.entry);
          if (!result.deduped) newlyEnqueuedEntryIds.push(result.entry.id);
          if (queueCustodyAdmissionId) stagedCustodyEntryIds.add(result.entry.id);
        }
      }
    }
    const handled = [...enqueued, ...coalesced];
    if (persistedQueueTrigger && targetCats.length > 0) {
      const messageStore = deps.messageStore;
      if (!messageStore) throw new Error('A2A Queue dispatch requires durable message custody');
      const acceptedEntries = handled
        .map((catId) => acceptedEntryByCatId.get(catId))
        .filter((entry): entry is NonNullable<typeof entry> => !!entry);
      if (acceptedEntries.length !== handled.length) {
        rollbackDurableAdmissions();
        throw new Error('accepted A2A target is missing its exact Queue carrier');
      }
      let expectedCustody: QueuedMessageCustody;
      let initialized: Awaited<ReturnType<IMessageStore['initializeQueueCustody']>>;
      try {
        const custodyOptions = {
          requestedTargetCats: targetCats,
          createdAt: opts.triggerMessage.timestamp,
        };
        expectedCustody = isCrossThread
          ? createInitialCrossThreadQueuedMessageCustody(triggerMessageId, acceptedEntries, custodyOptions)
          : createInitialFanoutQueuedMessageCustody(triggerMessageId, acceptedEntries, custodyOptions);
        initialized = await initializeQueueCustodyWithLifecycleRetry(messageStore, triggerMessageId, expectedCustody);
      } catch (error) {
        rollbackDurableAdmissions();
        throw error;
      }
      if (
        initialized.kind === 'not_found' ||
        initialized.kind === 'not_queued' ||
        initialized.kind === 'lifecycle_conflict'
      ) {
        rollbackDurableAdmissions();
        throw new Error(`A2A fan-out Queue custody initialization failed: ${initialized.kind}`);
      }
      const dispatchRefs = initialized.message.lifecycle?.dispatchRefs ?? [];
      if (
        (initialized.message.queueCustody?.status === 'terminal' && expectedCustody.status !== 'terminal') ||
        expectedCustody.allTargetCats.some((targetId) => !dispatchRefs.some((ref) => ref.targetId === targetId)) ||
        !sameFanoutCustodyIdentity(initialized.message.queueCustody, expectedCustody)
      ) {
        rollbackDurableAdmissions();
        throw new Error('A2A fan-out Queue custody identity mismatch');
      }
      if (expectedCustody.failedByCatIds.length > 0) {
        const liveCustody = initialized.message.queueCustody;
        if (!liveCustody) {
          rollbackDurableAdmissions();
          throw new Error('A2A rejected-target lifecycle settlement lost Queue custody');
        }
        const failedAt = Math.max(Date.now(), persistedQueueTrigger.timestamp);
        const failure = await messageStore.commitLifecyclePreAdmissionFailure({
          sourceMessageId: triggerMessageId,
          expectedEntryId: expectedCustody.entryId,
          expectedQueueCustodyRevision: liveCustody.revision,
          requestedTargets: [...expectedCustody.allTargetCats],
          failedTargets: [...expectedCustody.failedByCatIds],
          reason: 'invalid_explicit_target',
          content:
            expectedCustody.failedByCatIds.length === expectedCustody.allTargetCats.length
              ? '消息未能送达：指定的接收对象当前无效。'
              : '消息未能送达：部分指定接收对象当前无效。',
          failedAt,
        });
        if (failure.kind !== 'applied' && failure.kind !== 'replayed') {
          rollbackDurableAdmissions();
          const failureReason = 'reason' in failure ? failure.reason : 'missing';
          throw new Error(`A2A rejected-target lifecycle settlement failed: ${failure.kind}:${failureReason}`);
        }
        emitLifecycleMessageUpdated(deps.socketManager, opts.userId, failure.inputMessage);
        emitLifecycleMessageUpdated(deps.socketManager, opts.userId, failure.failureMessage);
      }
      if (
        queueCustodyAdmissionId &&
        stagedCustodyEntryIds.size > 0 &&
        !deps.invocationQueue.commitQueueCustodyAdmission(threadId, opts.userId, queueCustodyAdmissionId, [
          ...stagedCustodyEntryIds,
        ])
      ) {
        rollbackDurableAdmissions();
        throw new Error('A2A fan-out Queue custody admission changed before commit');
      }
    }
    // Phase T: single-recipient queue acceptance is the machine-confirmed handoff boundary.
    // Persist it before auto-execution can start so route-serial cannot close the parent against
    // a stale holder. A thread ball has one holder: multi-recipient forks must stay on the existing
    // receiver-boundary path rather than pre-writing several mutually-overwriting holders.
    // BallCustodyIngest is idempotent by sourceEventId, so retries/coalesces safely converge.
    if (deps.ballCustody && handled.length === 1) {
      const handedAt = Date.now();
      for (const catId of handled) {
        try {
          await deps.ballCustody.record(
            buildHandedEvent({
              threadId,
              messageId: triggerMessageId,
              fromCatId,
              toCatId: catId,
              at: handedAt,
            }),
          );
        } catch (err) {
          // BallCustodyIngest is a best-effort shadow projection, while InvocationQueue acceptance
          // is the live delivery decision. Once the queue owns this child, a projection write gap
          // must remain observable without escaping into MessageDeliveryService's fail-open
          // broadcast recovery (which would execute both the parent broadcast and the queued child).
          log.warn(
            { err, threadId, triggerMessageId, fromCatId, toCatId: catId },
            '[F167 Phase T] accepted A2A queue handoff custody write failed (best-effort)',
          );
        }
      }
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
      await emitQueueUpdated(
        deps.socketManager,
        opts.userId,
        threadId,
        deps.invocationQueue.list(threadId, opts.userId),
        deps.messageStore ?? null,
        action,
      );
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
    await deps.queueProcessor.requestDrain(threadId);
    log.info(
      { threadId, triggerMessageId, enqueued, coalesced, targetCats },
      enqueued.length > 0
        ? '[F122B] A2A callback: enqueued to InvocationQueue'
        : '[F122B] A2A callback: no new InvocationQueue entries enqueued',
    );
    return { enqueued, coalesced };
  }
}
