/**
 * QueueProcessor
 * 处理 InvocationQueue 中的排队条目：自动出队 + 暂停管理。
 *
 * 两个入口：
 * - onInvocationComplete（系统级）：invocation 完成后调用，succeeded 时自动出队
 * - processNext（用户级）：co-creator手动触发处理自己的下一条
 */

import type {
  CatId,
  FreshnessSupplementFailureReason,
  OutputCommitDecision,
  QueueTargetOutcome,
  QueueTerminalConsumptionWitness,
  RichBlock,
} from '@cat-cafe/shared';
import {
  leaseSucceededSubjectNonterminalTotal,
  successorResponsesAfterTerminalState,
  unresolvedSubjectWithoutActiveCustodyTotal,
} from '../../../../../infrastructure/telemetry/instruments.js';
import { emitQueueUpdated, enrichQueueEntries } from '../../../../../utils/queue-enrichment.js';
import type { ActionSuccessorLeaseStore } from '../../../../ball-custody/ActionSuccessorLeaseStore.js';
import {
  resolveQueueTurnCustodyWake,
  retargetTurnCustodyWake,
} from '../../../../ball-custody/turn-custody-wake-provenance.js';
import type { MemoryCueOpportunitySeed } from '../../../../memory/cue/MemoryCueInvocationPromptService.js';
import { readTrustedConnectorMemoryCueSeeds } from '../../../../memory/cue/MemoryCueTrustedConnector.js';
import type { FreshnessAttentionEventLog } from '../../freshness/FreshnessAttentionEventLog.js';
import { scanFreshnessClosurePreflight } from '../../freshness/FreshnessClosurePreflight.js';
import type { FreshnessClosureStore } from '../../freshness/FreshnessClosureStore.js';
import { scanFreshnessSupplementPreflight } from '../../freshness/FreshnessSupplementPreflight.js';
import {
  recordFreshnessClosureStage,
  recordFreshnessClosureTransition,
  recordFreshnessSuccessorPreflightCanceled,
} from '../../freshness/freshness-closure-telemetry.js';
import { recordQueuedHandledTelemetry, recordQueuedSeenTelemetry } from '../../freshness/freshness-queue-telemetry.js';
import {
  freshnessClosureFinalIdempotencyKey,
  projectFreshnessClosure,
  projectFreshnessSupplement,
  SUPPLEMENT_DECLINE_MARKER,
} from '../../freshness/glass-box/FreshnessOutputCommitCoordinator.js';
import type { DeliveryCursorStore } from '../../stores/ports/DeliveryCursorStore.js';
import type {
  InvocationActionLeaseCarrier,
  InvocationRecord,
  InvocationStatus,
} from '../../stores/ports/InvocationRecordStore.js';
import { classifyInvocationRecoveryStatus } from '../../stores/ports/invocation-state-machine.js';
import { hydrateReplyPreview, type IMessageStore, type StoredMessage } from '../../stores/ports/MessageStore.js';
import { projectQueueReceipt } from '../../stores/ports/queued-message-receipt.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import { type AgentMessage, mergeTokenUsage, type TokenUsage } from '../../types.js';
import { createA2ASlotTrackingBridge, type PersistenceContext, type RouteOptions } from '../routing/route-helpers.js';
import {
  accumulateTextAggregate,
  accumulateTextParts,
  flattenTextParts,
  flattenTurnTextParts,
} from '../text-aggregation.js';
import {
  type CollaborationContinuityCapsuleV1,
  extractContinuityCapsuleFromAgentMessage,
  formatContinuationPrompt,
  isCollaborationContinuityCapsuleV1,
} from './CollaborationContinuityCapsule.js';
import { type EnsureTerminalDeps, ensureTerminalStatus, RouteChainCompletionTracker } from './ensureTerminalStatus.js';
import {
  actionSuccessorInvocationIdempotencyKey,
  type InvocationQueue,
  type QueuedHandledResult,
  type QueueEntry,
} from './InvocationQueue.js';
import {
  DEFAULT_INVOCATION_SLOT_TTL_MS,
  type ExactExecutionOwnerState,
  type ExecutionOwnerMatch,
} from './InvocationTracker.js';
import { requireOwnerAuthProvenance } from './owner-auth-provenance.js';
import { PerCatTerminalDispositionCollector } from './PerCatTerminalDispositionCollector.js';
import {
  createCrossThreadQueueEntryFromCustody,
  type QueuedMessageCustodyCoordinator,
} from './QueuedMessageCustodyCoordinator.js';
import { resolveQueueSourceResponseEvidence } from './queue-source-response-evidence.js';
import { requireInvocationRecordUpdate } from './require-invocation-record-update.js';
import {
  type CommitInvocationInput,
  type ConsumedContinuationToken,
  type InvocationFinalStatus,
  type PrepareInvocationInput,
  type PrepareInvocationResult,
  SessionContinuationCoordinator,
  type SessionStrategy,
} from './SessionContinuationCoordinator.js';
import { ToolExecutionPolicyUnavailableError } from './tool-execution-policy.js';
import { stampVisibleTurn } from './visible-turn.js';

/** Minimal interfaces for deps — avoid importing full types for testability */

interface TrackerLike {
  start(threadId: string, catId: string, userId: string, catIds?: string[], executionId?: string): AbortController;
  startAll(threadId: string, catIds: string[], userId?: string, executionId?: string): AbortController;
  tryStartThreadAll?(threadId: string, catIds: string[], userId?: string, executionId?: string): AbortController | null;
  complete(threadId: string, catId: string, controller?: AbortController): void;
  completeSlot?(threadId: string, catId: string, controller?: AbortController): void;
  completeAll(threadId: string, catIds: string[], controller?: AbortController): void;
  trackExternalSlot?(
    threadId: string,
    catId: string,
    controller: AbortController,
    userId?: string,
    catIds?: string[],
    executionId?: string,
  ): boolean;
  has(threadId: string, catId?: string): boolean;
  getUserId?(threadId: string, catId: string): string | null;
  /** F-parallel-cancel: expose a slot's own controller for per-cat cancel isolation. */
  getController?(threadId: string, catId: string): AbortController | undefined;
  classifyExecutionId?(threadId: string, catId: string, executionId: string): ExecutionOwnerMatch;
  /** F254: exact per-cat cancel tombstone for durable terminal witness derivation. */
  getSlotState?(threadId: string, catId: string): 'active' | 'canceled' | 'absent';
  /** F-parallel-cancel: aggregate final status — whole-invocation abort vs per-cat cancel. */
  resolveFinalStatus?(
    threadId: string,
    targetCats: readonly string[],
    batch: { aborted: boolean; reason?: string },
  ): 'succeeded' | 'canceled' | 'canceled_by_user';
  completeByExecutionId(threadId: string, catId: string, executionId: string): ExactExecutionOwnerState;
}

interface QueueExecutionResult {
  status: InvocationFinalStatus;
  invocationId?: string;
  successfulCatIds: string[];
  /** Queue rows actually reserved into this attempt, including F175 batch siblings. */
  attemptedQueueEntryIds: string[];
  /** Exact child that received each target's persisted Queue body. */
  terminalInvocationIdByCatId: Record<string, string>;
  /** Typed terminal clean-stop proof, keyed by the exact child that emitted it. */
  terminalConsumptionByInvocationId: Record<string, QueueTerminalConsumptionWitness>;
  /** The primary row was rolled back to queued after this failed attempt. */
  primaryEntryRequeued?: boolean;
}

interface ProcessingSlotReservation {
  readonly startedAt: number;
  readonly entryId: string;
  readonly userId: string;
  invocationId?: string;
}

interface MarkDeliveredAndEmitResult {
  transitionedIds: string[];
  failedIds: string[];
}

interface PausedQueueNotification {
  userId: string;
  queue: Awaited<ReturnType<typeof enrichQueueEntries>>;
}

interface BoundQueueExecution {
  invocationId: string;
  userIds: ReadonlySet<string>;
}

interface ResolvedBoundQueueExecutions {
  records: Array<{
    invocationId: string;
    status: 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
  }>;
  unresolvedInvocationIds: string[];
}

interface PromptMessagesExposedInput {
  threadId: string;
  userId: string;
  catId: string;
  invocationId: string;
  messageIds: readonly string[];
  seenAt: number;
}

interface PromptMessagesAwakenedInput {
  threadId: string;
  userId: string;
  catId: string;
  invocationId: string;
  messageIds: readonly string[];
  awakenedAt: number;
}

export { readTrustedConnectorMemoryCueSeeds } from '../../../../memory/cue/MemoryCueTrustedConnector.js';

export interface InvocationRecordStoreLike {
  create(input: Record<string, unknown>): Promise<{ outcome: string; invocationId: string }>;
  get?(id: string): InvocationRecord | null | Promise<InvocationRecord | null>;
  update(id: string, data: Record<string, unknown>): Promise<unknown | null>;
}

function isQueueTerminalConsumptionWitness(value: unknown): value is QueueTerminalConsumptionWitness {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === 'terminal_silent' &&
    candidate.projectionState === 'covered_empty' &&
    candidate.wake === 'coordination_terminal'
  );
}

function readOrdinaryInvocationCreated(
  message: unknown,
): { catId: string; invocationId: string; startedAt: number } | null {
  if (!message || typeof message !== 'object') return null;
  const candidate = message as Partial<AgentMessage>;
  if (candidate.type !== 'system_info' || typeof candidate.catId !== 'string' || !candidate.catId) return null;
  const projection = candidate.extra?.turnExecution;
  if (
    typeof candidate.turnInvocationId !== 'string' ||
    !candidate.turnInvocationId ||
    typeof candidate.turnExecutionStartedAt !== 'number' ||
    !Number.isFinite(candidate.turnExecutionStartedAt) ||
    candidate.turnExecutionStartedAt < 0 ||
    projection?.executionKind !== 'ordinary' ||
    projection.invocationId !== candidate.turnInvocationId ||
    typeof projection.parentInvocationId !== 'string' ||
    !projection.parentInvocationId
  ) {
    return null;
  }
  return {
    catId: candidate.catId,
    invocationId: candidate.turnInvocationId,
    startedAt: candidate.turnExecutionStartedAt,
  };
}

function sameActionLeaseCarrier(actual: InvocationActionLeaseCarrier, expected: InvocationActionLeaseCarrier): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === 'none' || expected.kind === 'none') return true;
  return actual.leaseId === expected.leaseId && actual.generation === expected.generation;
}

function isExactReplayableQueueRecord(
  record: InvocationRecord | null,
  expected: {
    threadId: string;
    userId: string;
    targetCats: readonly string[];
    intent: string;
    idempotencyKey: string;
    actionLeaseCarrier: InvocationActionLeaseCarrier;
  },
): record is InvocationRecord & { status: 'queued' | 'failed' } {
  return (
    record !== null &&
    classifyInvocationRecoveryStatus(record.status) === 'replayable' &&
    record.threadId === expected.threadId &&
    record.userId === expected.userId &&
    record.intent === expected.intent &&
    record.idempotencyKey === expected.idempotencyKey &&
    record.targetCats.length === expected.targetCats.length &&
    record.targetCats.every((catId, index) => catId === expected.targetCats[index]) &&
    sameActionLeaseCarrier(record.actionLeaseCarrier, expected.actionLeaseCarrier)
  );
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

/** #813: Minimal thread store interface for passive continuation. */
export interface ThreadStoreLike {
  getMemberSessionStrategy?(
    threadId: string,
    catId: string,
    userId: string,
  ): 'resume' | 'reborn' | undefined | Promise<'resume' | 'reborn' | undefined>;
  setPendingContinuation(
    threadId: string,
    catId: string,
    userId: string,
    entry: { capsule: Record<string, unknown>; createdAt: number },
  ): void | Promise<void>;
  consumePendingContinuation(
    threadId: string,
    catId: string,
    userId: string,
  ):
    | { capsule: Record<string, unknown>; createdAt: number }
    | null
    | Promise<{ capsule: Record<string, unknown>; createdAt: number } | null>;
  /** #836: Check if a cat uses reborn session strategy in this thread.
   *  Reborn cats skip continuation consume/enqueue — every invocation starts fresh. */
  isRebornSession?(threadId: string, catId: string): boolean | Promise<boolean>;
}

export interface SessionContinuationCoordinatorLike {
  resolveSessionStrategy?(threadId: string, catId: string, userId: string): Promise<SessionStrategy>;
  prepareInvocationContext(input: PrepareInvocationInput): Promise<PrepareInvocationResult>;
  commitInvocationOutcome(input: CommitInvocationInput): Promise<void>;
}

/** Minimal outbound delivery interface — avoids importing full OutboundDeliveryHook. */
export interface OutboundDeliveryHookLike {
  deliver(
    threadId: string,
    content: string,
    catId: string,
    richBlocks?: RichBlock[],
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
  onClosureCatchingUp?(threadId: string, catId: CatId, invocationId: string): Promise<void>;
  onClosureBlocked?(threadId: string, catId: CatId, reason: string, invocationId: string): Promise<void>;
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

function isConnectorDeliverable(decision: OutputCommitDecision | undefined): boolean {
  return (
    decision === undefined ||
    decision.kind === 'committed_fresh' ||
    decision.kind === 'committed_degraded_unknown' ||
    decision.kind === 'published_with_unseen'
  );
}

function supplementFailureReason(error: unknown, status: InvocationFinalStatus): FreshnessSupplementFailureReason {
  if (
    error instanceof ToolExecutionPolicyUnavailableError ||
    (error instanceof Error && error.name === 'ToolExecutionPolicyUnavailableError')
  ) {
    return 'read_only_policy_unavailable';
  }
  if (status === 'canceled' || status === 'canceled_by_user') return 'user_cancel';
  if (status === 'failed') return 'provider_failure';
  return 'infrastructure';
}

export interface QueueProcessorDeps {
  queue: InvocationQueue;
  invocationTracker: TrackerLike;
  invocationRecordStore: InvocationRecordStoreLike;
  router: RouterLike;
  socketManager: SocketManagerLike;
  messageStore: IMessageStore;
  /** F254: durable owner for ordinary queued-user lifecycle transitions. */
  queueCustodyCoordinator?: QueuedMessageCustodyCoordinator;
  log: LoggerLike;
  /** F088 fix: optional outbound delivery hook (late-bound after gateway bootstrap). */
  outboundHook?: OutboundDeliveryHookLike;
  /** F088 fix: optional streaming outbound hook (late-bound after gateway bootstrap). */
  streamingHook?: StreamingOutboundHookLike;
  /** F088 fix: optional thread metadata lookup for outbound delivery. */
  threadMetaLookup?: (threadId: string) => ThreadMetaLike | undefined | Promise<ThreadMetaLike | undefined>;
  /** Outbound delivery timeout in ms (default 10_000). Mirrors ConnectorInvokeTrigger. */
  deliverTimeoutMs?: number;
  /** #813: Thread store for passive continuation (write/consume pending continuation). */
  threadStore?: ThreadStoreLike;
  /** F224: continuation lifecycle coordinator boundary. */
  sessionContinuationCoordinator?: SessionContinuationCoordinatorLike;
  /** F254 D1.2b: audit stream for queued_seen → queued_handled closure. */
  freshnessEventLog?: FreshnessAttentionEventLog;
  /** F254 Phase E: typed successor preflight/adoption and crash closure. */
  freshnessClosureStore?: FreshnessClosureStore;
  /** Durable child lifecycle and causal coverage; auth registry is not historical truth. */
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
  /** F167 Phase S.1: carrier preflight plus failed/canceled runtime outcomes; success requires Evidence→Verdict. */
  actionSuccessorLeaseStore?: Pick<ActionSuccessorLeaseStore, 'preflight' | 'preflightOutput' | 'commitOutcome'>;
  /**
   * F254 Phase E (ADR-041 §5): seed the freshness seenCursor when closure adoption
   * injects required bodies — injection must count as seen, or the output gate
   * re-reads a frozen cursor and supersedes every replacement forever.
   */
  deliveryCursorStore?: Pick<DeliveryCursorStore, 'ackSeenCursor'>;
}

/** F122B B6: Completion hook — called when a queue entry finishes execution. */
export type EntryCompleteHook = (
  entryId: string,
  status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
  responseText: string,
) => void;

export type ContinuationEnqueueOutcome =
  | 'enqueued'
  | 'skipped_missing_capsule'
  | 'skipped_invalid_capsule'
  | 'skipped_existing_entry'
  | 'skipped_rate_limited'
  | 'queue_full';

interface AutoResumeSuppression {
  setAt: number;
  executionIds: Set<string>;
  hasAnonymousFence: boolean;
}

export class QueueProcessor {
  private deps: QueueProcessorDeps;
  /** F108: Per-slot mutex — prevents concurrent double-start per (thread, cat) pair.
   *  F118 D4: startedAt supports bounded zombie detection.
   *  F194: the reservation object is the exact pre-start owner; invocationId is
   *  bound immediately after durable record creation. */
  private processingSlots = new Map<string, ProcessingSlotReservation>();
  /** F108: Per-slot pause tracking (set on canceled/failed, cleared on next execution) */
  private pausedSlots = new Map<string, 'canceled' | 'failed'>();
  private pauseEpoch = new Map<string, number>();
  /** Suppress automatic admission per slot while cancelAll/force-reset settles.
   *  Observers use the slot fence; only a canceled execution named by the owning
   *  cancel action may consume it. TTL bounds lock-only/missing-terminal cases. */
  private suppressedAutoResume = new Map<string, AutoResumeSuppression>();
  private static readonly SUPPRESS_TTL_MS = 60_000;
  /** F122B B6: Per-entry completion hooks (for multi-mention response aggregation). */
  private entryCompleteHooks = new Map<string, EntryCompleteHook>();
  /** F118 D4: independent owner-liveness backstop before a processingSlot is considered zombie (default 75min). */
  private processingSlotTtlMs: number;
  private readonly sessionContinuationCoordinator?: SessionContinuationCoordinatorLike;
  /** #502 PR2: bounded auto-continuation guard, in-memory per process. */
  private continuationWindows = new Map<string, number[]>();
  private static readonly CONTINUATION_WINDOW_MS = 60 * 60 * 1000;
  private static readonly MAX_CONTINUATIONS_PER_WINDOW = 5;
  private readonly routeChainTracker = new RouteChainCompletionTracker();

  private broadcastFreshnessClosure(closure: Awaited<ReturnType<FreshnessClosureStore['get']>>): void {
    if (!closure) return;
    const projection = projectFreshnessClosure(closure);
    this.deps.socketManager.broadcastAgentMessage(
      {
        type: 'system_info',
        catId: closure.catId,
        content: JSON.stringify(projection),
        timestamp: projection.updatedAt,
      },
      closure.threadId,
    );
  }

  private broadcastFreshnessSupplement(supplement: Awaited<ReturnType<FreshnessClosureStore['getSupplement']>>): void {
    if (!supplement) return;
    const projection = projectFreshnessSupplement(supplement);
    this.deps.socketManager.broadcastAgentMessage(
      {
        type: 'system_info',
        catId: supplement.catId,
        content: JSON.stringify(projection),
        timestamp: projection.updatedAt,
      },
      supplement.threadId,
    );
  }

  private async recoverDurableSupplementCommit(
    supplement: Awaited<ReturnType<FreshnessClosureStore['getSupplement']>>,
    invocationId: string | undefined,
  ): Promise<{
    supplement: Awaited<ReturnType<FreshnessClosureStore['getSupplement']>>;
    durableBodyFound: boolean;
  }> {
    const store = this.deps.freshnessClosureStore;
    if (
      !store ||
      !supplement ||
      supplement.status !== 'running' ||
      !invocationId ||
      supplement.runningInvocationId !== invocationId
    ) {
      return { supplement, durableBodyFound: false };
    }
    const published = await this.deps.messageStore.getByIdempotencyKey(
      supplement.userId,
      supplement.threadId,
      supplement.id,
    );
    if (!published) return { supplement, durableBodyFound: false };
    try {
      const committed = await store.commitSupplement(supplement.id, {
        invocationId,
        messageId: published.id,
        now: Date.now(),
      });
      return { supplement: committed, durableBodyFound: true };
    } catch (err) {
      this.deps.log.warn(
        { err, supplementId: supplement.id, invocationId, messageId: published.id },
        '[F254] durable supplement body found but aggregate commit recovery failed',
      );
      return { supplement, durableBodyFound: true };
    }
  }

  constructor(deps: QueueProcessorDeps, opts?: { processingSlotTtlMs?: number }) {
    this.deps = deps;
    this.processingSlotTtlMs = opts?.processingSlotTtlMs ?? DEFAULT_INVOCATION_SLOT_TTL_MS;
    this.sessionContinuationCoordinator =
      deps.sessionContinuationCoordinator ?? QueueProcessor.createSessionContinuationCoordinator(deps.threadStore);
  }

  private static createSessionContinuationCoordinator(
    threadStore?: ThreadStoreLike,
  ): SessionContinuationCoordinatorLike | undefined {
    if (!threadStore) return undefined;
    return new SessionContinuationCoordinator({
      threadStore: {
        getMemberSessionStrategy: async (threadId, catId, userId) => {
          if (threadStore.getMemberSessionStrategy) {
            return (await threadStore.getMemberSessionStrategy(threadId, catId, userId)) ?? undefined;
          }
          if (threadStore.isRebornSession && (await threadStore.isRebornSession(threadId, catId))) {
            return 'reborn';
          }
          return undefined;
        },
        consumePendingContinuation: async (threadId, catId, userId) => {
          const entry = await threadStore.consumePendingContinuation(threadId, catId, userId);
          return (entry?.capsule as unknown as CollaborationContinuityCapsuleV1 | undefined) ?? null;
        },
        setPendingContinuation: async (threadId, catId, userId, capsule) => {
          await threadStore.setPendingContinuation(threadId, catId, userId, {
            capsule: capsule as unknown as Record<string, unknown>,
            createdAt: Date.now(),
          });
        },
      },
    });
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

  /** ADR-042: removing a queued carrier must also close its durable responsibility. */
  async finalizeRemovedEntry(
    entry: Pick<QueueEntry, 'freshnessSupplementId'> | null | undefined,
    reason: FreshnessSupplementFailureReason = 'user_cancel',
  ): Promise<void> {
    if (!entry?.freshnessSupplementId || !this.deps.freshnessClosureStore) return;
    try {
      const supplement = await this.deps.freshnessClosureStore.getSupplement(entry.freshnessSupplementId);
      if (supplement?.status !== 'pending') return;
      const failed = await this.deps.freshnessClosureStore.failSupplement(supplement.id, {
        reason,
        now: Date.now(),
      });
      this.broadcastFreshnessSupplement(failed);
    } catch (err) {
      this.deps.log.error(
        { err, supplementId: entry.freshnessSupplementId, reason },
        '[F254] failed to terminalize removed supplement carrier',
      );
    }
  }

  /** A superseded carrier owns both its queue row and every durable message projection. */
  private async finalizeSupersededCarrier(entry: QueueEntry): Promise<void> {
    const supplementCompletion = this.finalizeRemovedEntry(entry, 'user_cancel');
    const messageCompletion = this.finalizeSupersededCarrierMessages(entry);
    await Promise.all([supplementCompletion, messageCompletion]);
  }

  private async finalizeSupersededCarrierMessages(entry: QueueEntry): Promise<void> {
    const messageIds = new Set([entry.messageId ?? '', ...entry.mergedMessageIds].filter(Boolean));
    for (const messageId of messageIds) {
      try {
        const result = await this.deps.messageStore.markCanceled(messageId);
        if (result?.deliveryTransitioned !== true) continue;
        this.deps.socketManager.emitToUser(entry.userId, 'message_deleted', {
          messageId,
          threadId: entry.threadId,
          deletedBy: entry.userId,
        });
      } catch (err) {
        this.deps.log.error(
          { err, messageId, entryId: entry.id },
          '[QueueProcessor] failed to terminalize superseded carrier message',
        );
      }
    }
  }

  private static slotKey(threadId: string, catId: string): string {
    return JSON.stringify([threadId, catId]);
  }

  private static slotMatchesThread(key: string, threadId: string): boolean {
    return QueueProcessor.parseSlotKey(key)?.threadId === threadId;
  }

  private static parseSlotKey(key: string): { threadId: string; catId: string } | null {
    try {
      const parsed = JSON.parse(key);
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === 'string' &&
        typeof parsed[1] === 'string'
      ) {
        return { threadId: parsed[0], catId: parsed[1] };
      }
    } catch {
      // Legacy in-memory keys from older code are not expected after restart.
    }
    const legacySep = key.indexOf(':');
    if (legacySep > 0) {
      return { threadId: key.slice(0, legacySep), catId: key.slice(legacySep + 1) };
    }
    return null;
  }

  private reserveProcessingSlot(key: string, entryId: string, userId: string): ProcessingSlotReservation {
    const reservation: ProcessingSlotReservation = { startedAt: Date.now(), entryId, userId };
    this.processingSlots.set(key, reservation);
    return reservation;
  }

  private releaseProcessingSlot(key: string, reservation: ProcessingSlotReservation): boolean {
    if (this.processingSlots.get(key) !== reservation) return false;
    this.processingSlots.delete(key);
    return true;
  }

  private bindProcessingSlotInvocation(
    key: string,
    reservation: ProcessingSlotReservation,
    invocationId: string,
  ): boolean {
    if (this.processingSlots.get(key) !== reservation) return false;
    reservation.invocationId = invocationId;
    return true;
  }

  private ownsProcessingSlotInvocation(
    key: string,
    reservation: ProcessingSlotReservation,
    invocationId: string,
  ): boolean {
    return this.processingSlots.get(key) === reservation && reservation.invocationId === invocationId;
  }

  private canStartReservedTargetSet(
    threadId: string,
    targetCats: readonly string[],
    primaryCat: string,
    reservation: ProcessingSlotReservation,
    invocationId: string,
  ): boolean {
    if (!this.ownsProcessingSlotInvocation(QueueProcessor.slotKey(threadId, primaryCat), reservation, invocationId)) {
      return false;
    }

    for (const catId of new Set(targetCats)) {
      if (this.deps.invocationTracker.has(threadId, catId)) return false;
      const currentReservation = this.processingSlots.get(QueueProcessor.slotKey(threadId, catId));
      if (!currentReservation) continue;
      if (catId !== primaryCat || currentReservation !== reservation) return false;
    }
    return true;
  }

  private canReplaceExternalTargetSet(threadId: string, catIds: readonly string[], userId: string): boolean {
    for (const catId of catIds) {
      const reservation = this.processingSlots.get(QueueProcessor.slotKey(threadId, catId));
      if (reservation && reservation.userId !== userId) return false;
      if (this.deps.invocationTracker.has(threadId, catId)) {
        const trackerUserId = this.deps.invocationTracker.getUserId?.(threadId, catId);
        if (trackerUserId !== userId) return false;
      }
    }
    return true;
  }

  private completeProcessingSlotByExecutionId(
    threadId: string,
    catId: string,
    invocationId: string,
  ): ExactExecutionOwnerState {
    const key = QueueProcessor.slotKey(threadId, catId);
    const reservation = this.processingSlots.get(key);
    const ownerMatch = this.classifyProcessingSlotByExecutionId(threadId, catId, invocationId);
    if (ownerMatch === 'absent') return 'absent';
    if (ownerMatch === 'replacement' || !reservation) return 'replacement';
    return this.releaseProcessingSlot(key, reservation) ? 'released' : 'replacement';
  }

  private classifyProcessingSlotByExecutionId(
    threadId: string,
    catId: string,
    invocationId: string,
  ): ExecutionOwnerMatch {
    const reservation = this.processingSlots.get(QueueProcessor.slotKey(threadId, catId));
    if (!reservation) return 'absent';
    return reservation.invocationId === invocationId ? 'matching' : 'replacement';
  }

  private hasReplacementExecutionOwner(threadId: string, catId: string, invocationId: string): boolean {
    const trackerOwner = this.deps.invocationTracker.classifyExecutionId
      ? this.deps.invocationTracker.classifyExecutionId(threadId, catId, invocationId)
      : this.deps.invocationTracker.has(threadId, catId)
        ? 'replacement'
        : 'absent';
    return (
      trackerOwner === 'replacement' ||
      this.classifyProcessingSlotByExecutionId(threadId, catId, invocationId) === 'replacement'
    );
  }

  private supersedePausedSlot(key: string): void {
    const epoch = this.pauseEpoch.get(key);
    this.pausedSlots.delete(key);
    if (epoch !== undefined) this.pauseEpoch.set(key, epoch + 1);
  }

  private supersedePausedTerminalEffects(threadId: string, catId: string): void {
    this.supersedePausedSlot(QueueProcessor.slotKey(threadId, catId));
  }

  private runOwnershipValidatedHook(hook: (() => void) | undefined): void {
    hook?.();
  }

  /**
   * Acquire tracker ownership for execution paths that originate outside the queue.
   *
   * This synchronous boundary keeps the processing reservation and tracker projections
   * coherent. Non-preemptive callers fail if either projection is occupied. Replacement
   * callers exact-retire the reservation observed in this turn and immediately install
   * the tracker owner, leaving no await window in which an old queued create can bind.
   */
  acquireExternalExecution(
    threadId: string,
    catIds: string[],
    userId: string,
    options: {
      mode: 'non_preemptive' | 'replacement';
      executionId?: string;
      /**
       * Route-layer cancellation that must run only after the whole target set passes
       * the user-scoped replacement fence. It executes synchronously before any
       * reservation retirement or replacement tracker installation.
       */
      onOwnershipValidated?: () => void;
    },
  ): AbortController | null {
    const uniqueCatIds = [...new Set(catIds)];

    if (options.mode === 'non_preemptive') {
      if (uniqueCatIds.some((catId) => this.processingSlots.has(QueueProcessor.slotKey(threadId, catId)))) {
        return null;
      }
      if (this.deps.invocationTracker.tryStartThreadAll) {
        return this.deps.invocationTracker.tryStartThreadAll(threadId, uniqueCatIds, userId, options.executionId);
      }
      if (uniqueCatIds.some((catId) => this.deps.invocationTracker.has(threadId, catId))) return null;
      return this.deps.invocationTracker.startAll(threadId, uniqueCatIds, userId, options.executionId);
    }

    if (!this.canReplaceExternalTargetSet(threadId, uniqueCatIds, userId)) {
      this.deps.log.info(
        { threadId, targetCats: uniqueCatIds, replacementExecutionId: options.executionId },
        '[QueueProcessor] external replacement rejected by user-scoped owner fence',
      );
      return null;
    }

    this.runOwnershipValidatedHook(options.onOwnershipValidated);

    const retiredReservations: Array<{ catId: string; entryId: string; invocationId?: string }> = [];
    for (const catId of uniqueCatIds) {
      const key = QueueProcessor.slotKey(threadId, catId);
      const reservation = this.processingSlots.get(key);
      if (!reservation || !this.releaseProcessingSlot(key, reservation)) continue;
      // Replacement owns the old queue carrier's terminal transition now. Retiring only
      // the in-memory reservation would leave a create-blocked row permanently hidden in
      // `processing`; tombstone the exact row synchronously so the old coroutine observes
      // the same supersede signal if it later resumes.
      const removedEntry = this.deps.queue.removeProcessedAcrossUsers(threadId, reservation.entryId);
      // The row and its durable message/supplement projections are one carrier responsibility.
      // Keep acquisition await-free, but start the contained/idempotent terminalizer as
      // soon as the exact tombstone succeeds so a create-blocked coroutine is irrelevant.
      if (removedEntry) void this.finalizeSupersededCarrier(removedEntry);
      retiredReservations.push({
        catId,
        entryId: reservation.entryId,
        ...(reservation.invocationId ? { invocationId: reservation.invocationId } : {}),
      });
    }
    if (retiredReservations.length > 0) {
      this.deps.log.info(
        { threadId, replacementExecutionId: options.executionId, retiredReservations },
        '[QueueProcessor] external replacement retired exact processing reservations',
      );
    }
    const controller = this.deps.invocationTracker.startAll(threadId, uniqueCatIds, userId, options.executionId);
    if (!controller.signal.aborted) {
      for (const catId of uniqueCatIds) this.supersedePausedTerminalEffects(threadId, catId);
    }
    return controller;
  }

  /**
   * F118 D4: Sweep zombie processingSlots.
   * A slot is zombie when: age > TTL AND invocationTracker has no active slot for the same key.
   * The tracker check prevents false-positive cleanup of genuinely slow invocations.
   */
  private sweepZombieSlots(threadId: string): void {
    const now = Date.now();
    const ttl = this.processingSlotTtlMs;
    for (const [key, reservation] of this.processingSlots) {
      if (!QueueProcessor.slotMatchesThread(key, threadId)) continue;
      if (now - reservation.startedAt <= ttl) continue;
      // Only release if tracker also has no active invocation — double-confirm zombie
      const catId = QueueProcessor.parseSlotKey(key)?.catId;
      if (!catId) continue;
      if (!this.deps.invocationTracker.has(threadId, catId)) {
        this.releaseProcessingSlot(key, reservation);
        this.deps.log.warn(
          { threadId, catId, entryId: reservation.entryId, ageMs: now - reservation.startedAt },
          '[F118 D4] zombie processingSlot released',
        );
      }
    }
  }

  /** Check if a slot's queue is paused (canceled/failed AND has queued entries). */
  isPaused(threadId: string, catId?: string): boolean {
    if (catId) {
      return (
        this.pausedSlots.has(QueueProcessor.slotKey(threadId, catId)) && this.hasDispatchableQueuedForThread(threadId)
      );
    }
    // Backward compat: check if any slot for this thread is paused
    for (const key of this.pausedSlots.keys()) {
      if (QueueProcessor.slotMatchesThread(key, threadId)) {
        if (this.hasDispatchableQueuedForThread(threadId)) return true;
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

  /** F185 Phase B: non-agent fairness gate for text-scan A2A — user + connector block, agent does not. */
  hasQueuedNonAgentForThread(threadId: string): boolean {
    return this.deps.queue.hasQueuedNonAgentForThread(threadId);
  }

  /** F254 D1.1: queued freshness input scoped to the cat that would process it. */
  getQueuedFreshnessMessagesForCat(
    threadId: string,
    userId: string,
    catId: string,
  ): Array<{ entryId: string; source: string; content: string; callerCatId?: string; messageId?: string | null }> {
    return this.deps.queue.getQueuedFreshnessMessagesForCat(threadId, userId, catId);
  }

  /**
   * Bind only Queue entries whose complete persisted bodies were placed in the
   * current invocation prompt. This is the prompt-transport analogue of an
   * explicit full-body get_thread_context read.
   */
  async markPromptMessagesSeen(input: PromptMessagesExposedInput): Promise<void> {
    const exposed = new Set(input.messageIds);
    let receiptChanged = false;

    for (const candidate of this.deps.queue.list(input.threadId, input.userId)) {
      if (candidate.status !== 'queued' && candidate.status !== 'processing') continue;
      if (!candidate.targetCats.includes(input.catId)) continue;
      const entryMessageIds = this.queueEntryMessageIds(candidate);
      if (entryMessageIds.length === 0) continue;
      if (entryMessageIds.some((messageId) => !exposed.has(messageId))) continue;

      const before = this.deps.queue.getEntrySnapshot(input.threadId, input.userId, candidate.id);
      if (candidate.status === 'queued') {
        this.deps.queue.markQueuedSeen(
          input.threadId,
          input.userId,
          candidate.id,
          input.catId,
          input.invocationId,
          input.seenAt,
        );
      } else {
        this.deps.queue.markProcessingSeen(
          input.threadId,
          input.userId,
          candidate.id,
          [input.catId],
          input.invocationId,
          input.seenAt,
        );
      }
      const persistedEntry = this.deps.queue.getEntrySnapshot(input.threadId, input.userId, candidate.id);
      const newlySeen =
        !(before?.queuedSeenByCatIds ?? []).includes(input.catId) &&
        (persistedEntry?.queuedSeenByCatIds ?? []).includes(input.catId);
      const exposureChanged =
        !(before?.queuedBodyExposures ?? []).some(
          (exposure) => exposure.targetCatId === input.catId && exposure.invocationId === input.invocationId,
        ) &&
        (persistedEntry?.queuedBodyExposures ?? []).some(
          (exposure) => exposure.targetCatId === input.catId && exposure.invocationId === input.invocationId,
        );
      const evidenceChanged =
        before?.queuedSeenInvocationIdByCatId?.[input.catId] !==
        persistedEntry?.queuedSeenInvocationIdByCatId?.[input.catId];
      let reminderSeen = false;
      if (persistedEntry && this.deps.queueCustodyCoordinator) {
        await this.deps.queueCustodyCoordinator.persistEntry(persistedEntry);
        reminderSeen = await this.deps.queueCustodyCoordinator.markReminderSeen(
          persistedEntry,
          input.catId,
          input.invocationId,
        );
      }
      if ([newlySeen, evidenceChanged, exposureChanged, reminderSeen].some(Boolean)) receiptChanged = true;
      if (newlySeen) recordQueuedSeenTelemetry();
    }

    if (receiptChanged) {
      await emitQueueUpdated(
        this.deps.socketManager,
        input.userId,
        input.threadId,
        this.deps.queue.list(input.threadId, input.userId),
        this.deps.messageStore,
        'queued_seen',
      );
    }
  }

  /**
   * Persist the exact child-created boundary before the generator can advance
   * to prompt exposure. This is intentionally separate from queued_seen.
   */
  async markPromptMessagesAwakened(input: PromptMessagesAwakenedInput): Promise<void> {
    const exposed = new Set(input.messageIds);
    let receiptChanged = false;

    for (const candidate of this.deps.queue.list(input.threadId, input.userId)) {
      if (candidate.status !== 'queued' && candidate.status !== 'processing') continue;
      if (!candidate.targetCats.includes(input.catId)) continue;
      const entryMessageIds = this.queueEntryMessageIds(candidate);
      if (entryMessageIds.length === 0 || entryMessageIds.some((messageId) => !exposed.has(messageId))) continue;

      const changed = this.deps.queue.markQueuedAwakened(
        input.threadId,
        input.userId,
        candidate.id,
        input.catId,
        input.invocationId,
        input.awakenedAt,
      );
      if (!changed) continue;
      const persistedEntry = this.deps.queue.getEntrySnapshot(input.threadId, input.userId, candidate.id);
      if (persistedEntry && this.deps.queueCustodyCoordinator) {
        await this.deps.queueCustodyCoordinator.persistEntry(persistedEntry);
      }
      receiptChanged = true;
    }

    if (receiptChanged) {
      await emitQueueUpdated(
        this.deps.socketManager,
        input.userId,
        input.threadId,
        this.deps.queue.list(input.threadId, input.userId),
        this.deps.messageStore,
        'queued_awakened',
      );
    }
  }

  /** F254 D1.2b: clear stale retry read evidence before reusing an InvocationRecord id. */
  clearQueuedSeenInvocationForCats(threadId: string, catIds: readonly string[], invocationId: string): number {
    return this.deps.queue.clearQueuedSeenInvocationForCats(threadId, catIds, invocationId);
  }

  /** F185 Phase B: thin enqueue wrapper for deferred A2A entries from retry/invocations path. */
  enqueueRaw(input: Parameters<InvocationQueue['enqueue']>[0]) {
    return this.deps.queue.enqueue(input);
  }

  /** A2A dedup: check if a specific cat already has a queued or processing entry for this thread. */
  hasQueuedAgentForCat(threadId: string, catId: string): boolean {
    return this.deps.queue.hasQueuedAgentForCat(threadId, catId);
  }

  hasActiveOrQueuedAgentForCat(threadId: string, catId: string): boolean {
    return this.deps.queue.hasActiveOrQueuedAgentForCat(threadId, catId);
  }

  hasPendingForCat(threadId: string, userId: string, catId: string): boolean {
    return this.deps.queue.hasPendingForCat(threadId, catId, { userId });
  }

  /** #555: Cat-specific busy check — covers processingSlots + queue entries for this cat. */
  isCatBusy(threadId: string, catId: string): boolean {
    const reservation = this.processingSlots.get(QueueProcessor.slotKey(threadId, catId));
    if (reservation && Date.now() - reservation.startedAt < this.processingSlotTtlMs) return true;
    return this.deps.queue.hasQueuedOrProcessingForCat(threadId, catId);
  }

  /**
   * QueueProcessor slots are keyed only by thread + cat, while both tracker and queue entry
   * ownership include userId. Terminal recovery may release the non-user-scoped slot only when
   * every live owner signal is absent or belongs to the requesting user.
   */
  canReleaseSlotForUser(threadId: string, catId: string, requestUserId: string): boolean {
    if (this.deps.invocationTracker.has(threadId, catId)) {
      const trackerUserId = this.deps.invocationTracker.getUserId?.(threadId, catId);
      if (trackerUserId !== requestUserId) return false;
    }
    const processingEntry = this.deps.queue.findProcessingByCat(threadId, catId);
    return !processingEntry || processingEntry.userId === requestUserId;
  }

  async enqueueContinuation(input: {
    threadId: string;
    userId: string;
    ownerAuthProvenance: import('./owner-auth-provenance.js').OwnerAuthProvenance;
    catId: string;
    capsule?: CollaborationContinuityCapsuleV1 | null;
    excludeEntryId?: string;
  }): Promise<{ outcome: ContinuationEnqueueOutcome; entry?: QueueEntry }> {
    const { threadId, userId, catId, capsule, excludeEntryId } = input;
    const ownerAuthProvenance = requireOwnerAuthProvenance(input.ownerAuthProvenance);
    if (!capsule) {
      this.deps.log.warn({ threadId, catId }, '[QueueProcessor] continuation skipped: missing capsule');
      return { outcome: 'skipped_missing_capsule' };
    }
    if (!isCollaborationContinuityCapsuleV1(capsule)) {
      this.deps.log.warn({ threadId, catId }, '[QueueProcessor] continuation skipped: invalid capsule');
      return { outcome: 'skipped_invalid_capsule' };
    }
    if (capsule.threadId !== threadId || capsule.catId !== catId) {
      this.deps.log.warn(
        {
          threadId,
          catId,
          capsuleThreadId: capsule.threadId,
          capsuleCatId: capsule.catId,
        },
        '[QueueProcessor] continuation skipped: capsule target mismatch',
      );
      return { outcome: 'skipped_invalid_capsule' };
    }

    const now = Date.now();
    const key = `${threadId}:${catId}`;
    const recent = (this.continuationWindows.get(key) ?? []).filter(
      (t) => now - t < QueueProcessor.CONTINUATION_WINDOW_MS,
    );
    if (recent.length >= QueueProcessor.MAX_CONTINUATIONS_PER_WINDOW) {
      this.setContinuationWindow(key, recent);
      this.deps.log.warn({ threadId, catId }, '[QueueProcessor] continuation skipped: rate limited');
      return { outcome: 'skipped_rate_limited' };
    }

    const continuationKey = QueueProcessor.continuationKey(capsule);
    if (
      this.deps.queue.hasPendingForCat(threadId, catId, {
        excludeEntryId,
        sources: ['agent'],
        sourceCategories: ['continuation'],
        continuationKey,
      })
    ) {
      this.setContinuationWindow(key, recent);
      this.deps.log.info(
        { threadId, catId, continuationKey },
        '[QueueProcessor] continuation skipped: pending entry exists',
      );
      return { outcome: 'skipped_existing_entry' };
    }

    const result = this.deps.queue.enqueue({
      threadId,
      userId,
      ownerAuthProvenance,
      content: formatContinuationPrompt(capsule),
      source: 'agent',
      sourceCategory: 'continuation',
      continuationKey,
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
      callerCatId: catId,
      priority: 'urgent',
    });
    if (result.outcome === 'full' || !result.entry) {
      this.setContinuationWindow(key, recent);
      this.deps.log.warn({ threadId, catId }, '[QueueProcessor] continuation skipped: queue full');
      return { outcome: 'queue_full' };
    }

    recent.push(now);
    this.setContinuationWindow(key, recent);
    await emitQueueUpdated(
      this.deps.socketManager,
      userId,
      threadId,
      this.deps.queue.list(threadId, userId),
      this.deps.messageStore,
      'continuation_enqueued',
    );
    return { outcome: 'enqueued', entry: result.entry };
  }

  private static continuationKey(capsule: CollaborationContinuityCapsuleV1): string {
    const seal = capsule.seal;
    const sealPart = seal ? `${seal.sessionId}:${seal.sessionSeq}` : `created:${capsule.createdAt}`;
    return `${capsule.threadId}:${capsule.catId}:${capsule.invocationId ?? 'unknown-invocation'}:${sealPart}`;
  }

  private setContinuationWindow(key: string, recent: number[]): void {
    if (recent.length === 0) {
      this.continuationWindows.delete(key);
      return;
    }
    this.continuationWindows.set(key, recent);
  }

  private async persistQueueEntry(entry: QueueEntry | null | undefined): Promise<void> {
    if (!entry || !this.deps.queueCustodyCoordinator) return;
    await this.deps.queueCustodyCoordinator.persistEntry(entry);
  }

  private queueEntryMessageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
    return [entry.messageId ?? '', ...entry.mergedMessageIds].filter(Boolean);
  }

  private async hasDurableMessageCustody(entry: QueueEntry): Promise<boolean> {
    let managed = 0;
    let unmanaged = 0;
    for (const messageId of this.queueEntryMessageIds(entry)) {
      let message;
      try {
        message = await this.deps.messageStore.getById(messageId);
      } catch (err) {
        if (this.deps.queueCustodyCoordinator) throw err;
        unmanaged += 1;
        continue;
      }
      if (!message?.queueCustody) {
        unmanaged += 1;
        continue;
      }
      const targetCarriers = message.queueCustody.carrierByTargetCatId;
      if (targetCarriers) {
        if (entry.targetCats.some((catId) => targetCarriers[catId]?.entryId !== entry.id)) {
          throw new Error(`queued message per-target carrier mismatch for ${messageId}`);
        }
      } else if (message.queueCustody.entryId !== entry.id) {
        throw new Error(`queued message custody entry mismatch for ${messageId}`);
      }
      if (message.queueCustody.status === 'terminal') {
        throw new Error(`terminal queue custody still has a live Queue entry: ${entry.id}`);
      }
      managed += 1;
    }
    if (managed > 0 && unmanaged > 0) {
      throw new Error(`partial queue custody binding for entry ${entry.id}`);
    }
    return managed > 0;
  }

  private async resolveQueueTargetOutcome(
    threadId: string,
    handled: QueuedHandledResult,
    catId: string,
    invocationId: string,
    handledAt: number,
    consumption?: QueueTerminalConsumptionWitness,
  ): Promise<QueueTargetOutcome> {
    let disposition: QueueTargetOutcome['disposition'] = 'completed_with_turn';
    try {
      const getByThreadAfter = this.deps.messageStore.getByThreadAfter?.bind(this.deps.messageStore);
      if (getByThreadAfter) {
        const messages = await getByThreadAfter(threadId, undefined, undefined, handled.userId);
        const handledMessageIds = new Set(handled.messageIds);
        const hasExplicitReply = messages.some((message) => {
          const stream = message.extra?.stream;
          const sameInvocation = stream?.invocationId === invocationId || stream?.turnInvocationId === invocationId;
          return (
            message.catId === catId && sameInvocation && !!message.replyTo && handledMessageIds.has(message.replyTo)
          );
        });
        if (hasExplicitReply) disposition = 'responded';
      }
    } catch (err) {
      this.deps.log.warn(
        { err, threadId, catId, invocationId, queueEntryId: handled.entryId },
        '[F264] explicit response evidence scan failed; using completed-with-turn',
      );
    }
    return {
      invocationId,
      disposition,
      evidenceRef: { kind: 'invocation_lineage', invocationId },
      handledAt,
      ...(consumption ? { consumption } : {}),
    };
  }

  private async closeReminderAttemptsOnInvocationTerminal(
    threadId: string,
    catId: string,
    invocationId: string,
  ): Promise<void> {
    const coordinator = this.deps.queueCustodyCoordinator;
    if (!coordinator) return;
    for (const userId of this.deps.queue.listUsersForThread(threadId)) {
      let changed = false;
      for (const entry of this.deps.queue.list(threadId, userId)) {
        if (!entry.targetCats.includes(catId)) continue;
        try {
          changed = (await coordinator.markReminderMissed(entry, invocationId)) || changed;
        } catch (err) {
          this.deps.log.warn(
            { err, threadId, catId, invocationId, queueEntryId: entry.id },
            '[F264] failed to terminalize reminder attempt',
          );
        }
      }
      if (changed) {
        await emitQueueUpdated(
          this.deps.socketManager,
          userId,
          threadId,
          this.deps.queue.list(threadId, userId),
          this.deps.messageStore,
          'reminder_missed',
        );
      }
    }
  }

  private collectBoundQueueExecutions(threadId: string, catId: string): BoundQueueExecution[] {
    const userIdsByInvocationId = new Map<string, Set<string>>();
    for (const userId of this.deps.queue.listUsersForThread(threadId)) {
      for (const entry of this.deps.queue.list(threadId, userId)) {
        if (entry.status !== 'queued' && entry.status !== 'processing') continue;
        if (!entry.targetCats.includes(catId)) continue;
        const invocationId = entry.queuedSeenInvocationIdByCatId?.[catId];
        if (!invocationId) continue;
        const userIds = userIdsByInvocationId.get(invocationId) ?? new Set<string>();
        userIds.add(userId);
        userIdsByInvocationId.set(invocationId, userIds);
      }
    }
    return [...userIdsByInvocationId].map(([invocationId, userIds]) => ({ invocationId, userIds }));
  }

  private collectBoundQueueCatIds(threadId: string): string[] {
    const catIds = new Set<string>();
    for (const userId of this.deps.queue.listUsersForThread(threadId)) {
      for (const entry of this.deps.queue.list(threadId, userId)) {
        if (entry.status !== 'queued' && entry.status !== 'processing') continue;
        for (const catId of Object.keys(entry.queuedSeenInvocationIdByCatId ?? {})) {
          if (entry.targetCats.includes(catId)) catIds.add(catId);
        }
      }
    }
    return [...catIds];
  }

  private async resolveBoundQueueExecutionsForParent(input: {
    threadId: string;
    catId: string;
    parentInvocationId?: string;
    preferredInvocationId?: string;
  }): Promise<ResolvedBoundQueueExecutions> {
    const bound = this.collectBoundQueueExecutions(input.threadId, input.catId);
    if (bound.length === 0) return { records: [], unresolvedInvocationIds: [] };

    if (!this.deps.turnExecutionStore) {
      const exactInvocationId = input.preferredInvocationId ?? input.parentInvocationId;
      return {
        records: exactInvocationId
          ? bound
              .filter((candidate) => candidate.invocationId === exactInvocationId)
              .map((candidate) => ({ invocationId: candidate.invocationId, status: 'succeeded' as const }))
          : [],
        unresolvedInvocationIds: [],
      };
    }

    if (!input.parentInvocationId) {
      return { records: [], unresolvedInvocationIds: bound.map((candidate) => candidate.invocationId) };
    }

    const records: ResolvedBoundQueueExecutions['records'] = [];
    const unresolvedInvocationIds: string[] = [];
    for (const candidate of bound) {
      try {
        const record = await this.deps.turnExecutionStore.get(candidate.invocationId);
        if (!record) {
          unresolvedInvocationIds.push(candidate.invocationId);
          continue;
        }
        if (record.parentInvocationId !== input.parentInvocationId) continue;
        if (
          record.threadId !== input.threadId ||
          record.catId !== input.catId ||
          candidate.userIds.size !== 1 ||
          !candidate.userIds.has(record.userId)
        ) {
          unresolvedInvocationIds.push(candidate.invocationId);
          continue;
        }
        records.push({ invocationId: record.invocationId, status: record.status });
      } catch (err) {
        this.deps.log.error(
          {
            err,
            threadId: input.threadId,
            catId: input.catId,
            parentInvocationId: input.parentInvocationId,
            childInvocationId: candidate.invocationId,
          },
          '[QueueProcessor] exact Queue receipt ledger resolution failed',
        );
        unresolvedInvocationIds.push(candidate.invocationId);
      }
    }
    return { records, unresolvedInvocationIds };
  }

  private async settleQueuedTargetsAfterAggregateSuccess(input: {
    threadId: string;
    catId: string;
    parentInvocationId?: string;
    preferredInvocationId?: string;
    terminalConsumptionByInvocationId?: Readonly<Record<string, QueueTerminalConsumptionWitness>>;
  }): Promise<boolean> {
    const resolved = await this.resolveBoundQueueExecutionsForParent(input);
    let blocked = resolved.unresolvedInvocationIds.length > 0;

    for (const record of resolved.records) {
      if (record.status === 'succeeded') {
        await this.markQueuedHandledOnSuccess(
          input.threadId,
          input.catId,
          record.invocationId,
          input.terminalConsumptionByInvocationId?.[record.invocationId],
        );
        continue;
      }
      blocked = true;
      if (record.status !== 'running') {
        await this.markQueuedFailedOnFailure(input.threadId, input.catId, record.invocationId);
      }
    }

    const resolvedIds = new Set(resolved.records.map((record) => record.invocationId));
    if (
      this.collectBoundQueueExecutions(input.threadId, input.catId).some((candidate) =>
        resolvedIds.has(candidate.invocationId),
      )
    ) {
      blocked = true;
    }
    return blocked;
  }

  private async returnBoundQueueTargetsAfterAggregateNonSuccess(input: {
    threadId: string;
    catId: string;
    parentInvocationId?: string;
    preferredInvocationId?: string;
  }): Promise<boolean> {
    const resolved = await this.resolveBoundQueueExecutionsForParent(input);
    for (const record of resolved.records) {
      await this.markQueuedFailedOnFailure(input.threadId, input.catId, record.invocationId);
    }
    return resolved.records.length > 0 || resolved.unresolvedInvocationIds.length > 0;
  }

  private queueMessageOwnsPendingTarget(message: StoredMessage, entryId: string): boolean {
    const custody = message.queueCustody;
    if (!custody || custody.status !== 'queued' || custody.pendingTargetCats.length === 0) return false;
    if (!custody.carrierByTargetCatId) return custody.entryId === entryId;
    return custody.pendingTargetCats.some((catId) => custody.carrierByTargetCatId?.[catId]?.entryId === entryId);
  }

  private rebuildQueueEntryAfterSourceSettlement(current: QueueEntry, activeMessages: StoredMessage[]): QueueEntry {
    const ordered = [...activeMessages].sort(
      (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
    );
    if (ordered.some((message) => message.queueCustody?.carrierByTargetCatId)) {
      return createCrossThreadQueueEntryFromCustody(ordered, current.id);
    }
    const primary = ordered[0];
    if (!primary) throw new Error(`active Queue carrier ${current.id} has no source message`);
    const pendingTargets = [...new Set(ordered.flatMap((message) => message.queueCustody?.pendingTargetCats ?? []))];
    if (pendingTargets.length === 0) throw new Error(`active Queue carrier ${current.id} has no pending target`);
    const targetSet: ReadonlySet<string> = new Set<string>(pendingTargets);
    const filterTargets = (values: readonly string[] | undefined): string[] => [
      ...new Set((values ?? []).filter((catId) => targetSet.has(catId))),
    ];
    const filterMap = <T>(values: Readonly<Record<string, T>> | undefined): Record<string, T> =>
      Object.fromEntries(Object.entries(values ?? {}).filter(([catId]) => targetSet.has(catId)));
    return {
      ...current,
      content: ordered.map((message) => message.content).join('\n'),
      messageId: primary.id,
      mergedMessageIds: ordered.slice(1).map((message) => message.id),
      targetCats: pendingTargets,
      allTargetCats: [...new Set(ordered.flatMap((message) => message.queueCustody?.allTargetCats ?? []))],
      status: 'queued',
      processingStartedAt: undefined,
      queuedNotifiedByCatIds: filterTargets(current.queuedNotifiedByCatIds),
      queuedAwakenedInvocationIdByCatId: filterMap(current.queuedAwakenedInvocationIdByCatId),
      queuedAwakenedAtByCatId: filterMap(current.queuedAwakenedAtByCatId),
      queuedSeenByCatIds: filterTargets(current.queuedSeenByCatIds),
      queuedSeenInvocationIdByCatId: filterMap(current.queuedSeenInvocationIdByCatId),
      queuedBodyExposures: current.queuedBodyExposures?.filter((exposure) => targetSet.has(exposure.targetCatId)),
      queuedFailedByCatIds: filterTargets(current.queuedFailedByCatIds),
      queuedHandledByCatIds: filterTargets(current.queuedHandledByCatIds),
      steerRequestedByCatIds: filterTargets(current.steerRequestedByCatIds),
      steeredInvocationIdByCatId: filterMap(current.steeredInvocationIdByCatId),
    };
  }

  private async reconcileQueueCarrierAfterSourceSettlement(entry: QueueEntry): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = this.deps.queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
      if (!current) return true;
      const messages = (
        await Promise.all(
          this.queueEntryMessageIds(current).map((messageId) => this.deps.messageStore.getById(messageId)),
        )
      ).filter((message): message is StoredMessage => !!message);
      const activeMessages = messages.filter((message) => this.queueMessageOwnsPendingTarget(message, current.id));
      const changed =
        activeMessages.length === 0
          ? this.deps.queue.removeEntrySnapshotIfUnchanged(current)
          : this.deps.queue.restoreEntrySnapshotIfUnchanged(
              current,
              this.rebuildQueueEntryAfterSourceSettlement(current, activeMessages),
            );
      if (changed) return true;
    }
    return false;
  }

  /**
   * A later failed/canceled child cannot resurrect Queue sources which that
   * exact child already answered durably. Only explicit per-source reply/causal
   * refs qualify; all ambiguous exposed sources remain Queue-owned.
   */
  private async settleExactSourceResponsesBeforeFailure(input: {
    threadId: string;
    catId: string;
    invocationId: string;
  }): Promise<void> {
    const coordinator = this.deps.queueCustodyCoordinator;
    if (!coordinator) return;
    for (const userId of this.deps.queue.listUsersForThread(input.threadId)) {
      let changed = false;
      for (const entry of this.deps.queue.list(input.threadId, userId)) {
        if (
          entry.status !== 'queued' ||
          !entry.targetCats.includes(input.catId) ||
          entry.queuedSeenInvocationIdByCatId?.[input.catId] !== input.invocationId
        ) {
          continue;
        }
        const sourceMessageIds = this.queueEntryMessageIds(entry);
        try {
          const evidence = await resolveQueueSourceResponseEvidence({
            messageStore: this.deps.messageStore,
            threadId: input.threadId,
            userId,
            catId: input.catId,
            invocationId: input.invocationId,
            sourceMessageIds,
          });
          if (evidence.length === 0) continue;
          const deliveredAt = Date.now();
          const outcomeByMessageId = Object.fromEntries(
            evidence.map(({ sourceMessageId, witness }) => [
              sourceMessageId,
              {
                [input.catId]: {
                  invocationId: input.invocationId,
                  disposition: 'responded' as const,
                  evidenceRef: { kind: 'invocation_lineage' as const, invocationId: input.invocationId },
                  handledAt: deliveredAt,
                  consumption: witness,
                },
              },
            ]),
          );
          const settlement = await coordinator.commitSuccessfulTargetsForMessages(
            entry,
            evidence.map((item) => item.sourceMessageId),
            [input.catId],
            input.invocationId,
            deliveredAt,
            outcomeByMessageId,
          );
          const unmatched = settlement.perMessage.filter((message) => !message.handledTargetCats.includes(input.catId));
          if (unmatched.length > 0) {
            throw new Error(`source response evidence did not match exact exposure for ${unmatched[0]?.messageId}`);
          }
          const fullyConsumedMessageIds = settlement.perMessage
            .filter((message) => message.fullyConsumed)
            .map((message) => message.messageId);
          if (fullyConsumedMessageIds.length > 0) {
            await this.markDeliveredAndEmit(
              userId,
              input.threadId,
              fullyConsumedMessageIds,
              deliveredAt,
              new Set(fullyConsumedMessageIds),
            );
          }
          if (!(await this.reconcileQueueCarrierAfterSourceSettlement(entry))) {
            throw new Error(`Queue carrier ${entry.id} changed during source response settlement`);
          }
          changed = true;
        } catch (err) {
          this.deps.log.error(
            {
              err,
              threadId: input.threadId,
              catId: input.catId,
              invocationId: input.invocationId,
              queueEntryId: entry.id,
            },
            '[F264] exact source response settlement failed closed',
          );
        }
      }
      if (changed) {
        await emitQueueUpdated(
          this.deps.socketManager,
          userId,
          input.threadId,
          this.deps.queue.list(input.threadId, userId),
          this.deps.messageStore,
          'source_response_settled',
        );
      }
    }
  }

  private async markQueuedHandledOnSuccess(
    threadId: string,
    catId: string,
    invocationId?: string,
    consumption?: QueueTerminalConsumptionWitness,
  ): Promise<void> {
    if (!invocationId) return;
    const handled = this.deps.queue.markQueuedHandledForCatAcrossUsers(threadId, catId, invocationId);
    if (handled.length === 0) return;

    const deliveredAt = Date.now();
    const touchedUsers = new Set<string>();
    const committedHandled: QueuedHandledResult[] = [];
    const outcomeByEntryId = new Map<string, QueueTargetOutcome>();

    for (const h of handled) {
      const outcome = await this.resolveQueueTargetOutcome(threadId, h, catId, invocationId, deliveredAt, consumption);
      let durablyCustodied = false;
      try {
        durablyCustodied = h.entrySnapshot ? await this.hasDurableMessageCustody(h.entrySnapshot) : false;
      } catch (err) {
        this.deps.queue.restoreQueuedHandledResult(h);
        this.deps.log.error(
          { err, threadId, catId, queueEntryId: h.entryId },
          '[QueueProcessor] queue custody binding invalid; restored queued entry',
        );
        continue;
      }

      if (durablyCustodied) {
        if (!h.entrySnapshot || !this.deps.queueCustodyCoordinator) {
          this.deps.queue.restoreQueuedHandledResult(h);
          this.deps.log.error(
            { threadId, catId, queueEntryId: h.entryId },
            '[QueueProcessor] durable Queue custody coordinator unavailable; restored queued entry',
          );
          continue;
        }
        try {
          const settlement = await this.deps.queueCustodyCoordinator.commitSuccessfulTargets(
            h.entrySnapshot,
            [catId],
            invocationId,
            deliveredAt,
            { [catId]: outcome },
          );
          const handledMessages = settlement.perMessage.filter((message) => message.handledTargetCats.includes(catId));
          if (handledMessages.length !== settlement.perMessage.length) {
            this.deps.queue.restoreQueuedHandledResult(h);
            this.deps.log.error(
              {
                threadId,
                catId,
                queueEntryId: h.entryId,
                invocationId,
                unmatchedMessageIds: settlement.perMessage
                  .filter((message) => !message.handledTargetCats.includes(catId))
                  .map((message) => message.messageId),
              },
              '[QueueProcessor] exact success evidence did not cover the complete Queue carrier; restored queued entry',
            );
            continue;
          }
          const fullyConsumedMessageIds = handledMessages
            .filter((message) => message.fullyConsumed)
            .map((message) => message.messageId);
          if (fullyConsumedMessageIds.length > 0) {
            const delivery = await this.markDeliveredAndEmit(
              h.userId,
              threadId,
              fullyConsumedMessageIds,
              deliveredAt,
              new Set(fullyConsumedMessageIds),
            );
            if (delivery.failedIds.length > 0) {
              this.deps.log.error(
                { threadId, catId, queueEntryId: h.entryId, failedIds: delivery.failedIds },
                '[QueueProcessor] terminal custody committed but delivery socket hydration failed',
              );
            }
          }
        } catch (err) {
          this.deps.queue.restoreQueuedHandledResult(h);
          this.deps.log.error(
            { err, threadId, catId, queueEntryId: h.entryId },
            '[QueueProcessor] Queue custody success commit failed; restored queued entry',
          );
          continue;
        }
      } else if (h.fullyConsumed && h.messageIds.length > 0) {
        const delivery = await this.markDeliveredAndEmit(h.userId, threadId, h.messageIds, deliveredAt);
        if (delivery.failedIds.length > 0) {
          this.deps.queue.restoreQueuedHandledResult(h);
          this.deps.log.warn(
            { threadId, catId, queueEntryId: h.entryId, failedIds: delivery.failedIds },
            '[QueueProcessor] F254 D1.2b delivery persistence failed; restored queued entry',
          );
          continue;
        }
      }

      committedHandled.push(h);
      outcomeByEntryId.set(h.entryId, outcome);
    }

    if (committedHandled.length === 0) return;

    for (const h of committedHandled) {
      recordQueuedHandledTelemetry({ fullyConsumed: h.fullyConsumed });
      touchedUsers.add(h.userId);

      if (this.deps.freshnessEventLog) {
        try {
          const outcome = outcomeByEntryId.get(h.entryId);
          await this.deps.freshnessEventLog.append({
            kind: 'queued_handled',
            threadId,
            catId: catId as CatId,
            invocationId,
            timestamp: Date.now(),
            queueEntryId: h.entryId,
            messageIds: h.messageIds,
            disposition: outcome?.disposition ?? 'completed_with_turn',
            evidenceRef: outcome?.evidenceRef ?? { kind: 'invocation_lineage', invocationId },
            remainingTargetCats: h.remainingTargetCats,
          });
          await this.deps.freshnessEventLog.markProviderNoticesHandled({
            invocationId,
            catId: catId as CatId,
            queueEntryId: h.entryId,
            messageIds: h.messageIds,
            evidenceRef: outcome?.evidenceRef ?? { kind: 'invocation_lineage', invocationId },
          });
        } catch (err) {
          this.deps.log.warn(
            { err, threadId, catId, queueEntryId: h.entryId },
            '[QueueProcessor] F254 D1.2b queued_handled event append failed',
          );
        }
      }
    }

    for (const userId of touchedUsers) {
      try {
        await emitQueueUpdated(
          this.deps.socketManager,
          userId,
          threadId,
          this.deps.queue.list(threadId, userId),
          this.deps.messageStore,
          'queued_handled',
        );
      } catch (err) {
        this.deps.log.warn({ err, threadId, userId, catId }, '[QueueProcessor] F254 D1.2b queue update failed');
      }
    }
  }

  private async markQueuedFailedOnFailure(
    threadId: string,
    catId: string,
    invocationId: string,
    attemptedEntryIds: readonly string[] = [],
  ): Promise<void> {
    const failed = this.deps.queue.markQueuedFailedForCatAcrossUsers(
      threadId,
      catId,
      invocationId,
      new Set(attemptedEntryIds),
    );
    if (failed.length === 0) return;
    for (const entry of failed) {
      try {
        await this.persistQueueEntry(this.deps.queue.getEntrySnapshot(threadId, entry.userId, entry.entryId));
      } catch (err) {
        this.deps.log.error(
          { err, threadId, catId, queueEntryId: entry.entryId },
          '[QueueProcessor] queued_failed custody persistence failed',
        );
      }
    }
    for (const userId of new Set(failed.map((entry) => entry.userId))) {
      try {
        await emitQueueUpdated(
          this.deps.socketManager,
          userId,
          threadId,
          this.deps.queue.list(threadId, userId),
          this.deps.messageStore,
          'queued_failed',
        );
      } catch (err) {
        this.deps.log.warn({ err, threadId, userId, catId }, '[QueueProcessor] queued_failed update failed');
      }
    }
  }

  private async markDeliveredAndEmit(
    userId: string,
    threadId: string,
    messageIds: string[],
    deliveredAt: number,
    alreadyDeliveredIds: ReadonlySet<string> = new Set(),
  ): Promise<MarkDeliveredAndEmitResult> {
    const deliveredIds: string[] = [];
    const failedIds: string[] = [];
    const deliveredMessages: Array<{
      id: string;
      content: string;
      catId: string | null;
      timestamp: number;
      timelineOrderAt?: number;
      mentions: readonly string[];
      userId: string;
      contentBlocks?: readonly unknown[];
      extra?: Record<string, unknown>;
      origin?: string;
      replyTo?: string;
      replyPreview?: { senderCatId: string | null; content: string; deleted?: boolean; kind?: string };
      mentionsUser?: boolean;
    }> = [];

    for (const messageId of messageIds) {
      try {
        const alreadyDelivered = alreadyDeliveredIds.has(messageId);
        const result = alreadyDelivered
          ? await this.deps.messageStore.getById(messageId)
          : await this.deps.messageStore.markDelivered(messageId, deliveredAt);
        if (!result) {
          failedIds.push(messageId);
          continue;
        }
        const deliveryTransitioned = alreadyDelivered
          ? result.deliveryStatus === 'delivered'
          : 'deliveryTransitioned' in result && result.deliveryTransitioned === true;
        if (!deliveryTransitioned) continue;
        deliveredIds.push(messageId);
        let preview: Awaited<ReturnType<typeof hydrateReplyPreview>> | null = null;
        if (result.replyTo) {
          try {
            preview = await hydrateReplyPreview(this.deps.messageStore, result.replyTo);
          } catch {
            /* best-effort: preview failure must not drop the delivered message */
          }
        }
        const projectedExtra = {
          ...(result.extra ?? {}),
          ...(result.queueCustody ? { queueReceipt: projectQueueReceipt(result.queueCustody) } : {}),
        };
        deliveredMessages.push({
          id: result.id,
          content: result.content,
          catId: result.catId,
          timestamp: result.timestamp,
          ...(result.timelineOrderAt !== undefined ? { timelineOrderAt: result.timelineOrderAt } : {}),
          mentions: result.mentions,
          userId: result.userId,
          contentBlocks: result.contentBlocks,
          ...(Object.keys(projectedExtra).length > 0 ? { extra: projectedExtra as Record<string, unknown> } : {}),
          ...(result.origin ? { origin: result.origin } : {}),
          ...(result.replyTo ? { replyTo: result.replyTo } : {}),
          ...(preview ? { replyPreview: preview } : {}),
          ...(result.mentionsUser ? { mentionsUser: true } : {}),
        });
      } catch {
        failedIds.push(messageId);
      }
    }

    if (deliveredIds.length > 0) {
      this.deps.socketManager.emitToUser(userId, 'messages_delivered', {
        threadId,
        messageIds: deliveredIds,
        deliveredAt,
        messages: deliveredMessages,
      });
    }
    return { transitionedIds: deliveredIds, failedIds };
  }

  private async cancelMessageIds(messageIds: readonly string[], log: LoggerLike, reason: string): Promise<void> {
    for (const messageId of new Set(messageIds.filter(Boolean))) {
      try {
        const result = await this.deps.messageStore.markCanceled(messageId);
        if (result?.deliveryTransitioned !== true) continue;
        this.deps.socketManager.emitToUser(result.userId, 'message_deleted', {
          messageId,
          threadId: result.threadId,
          deletedBy: result.userId,
        });
      } catch (err) {
        log.error({ err, messageId, reason }, '[F167-S] failed to cancel stale action successor message');
      }
    }
  }

  /** F151: Check if thread has any queued or processing entries (used by delivery-batch-done signal). */
  isThreadBusy(threadId: string): boolean {
    if (this.hasDispatchableQueuedForThread(threadId)) return true;
    this.sweepZombieSlots(threadId);
    for (const key of this.processingSlots.keys()) {
      if (QueueProcessor.slotMatchesThread(key, threadId)) return true;
    }
    return false;
  }

  /** Active execution only; queued leftovers are not enough to keep new broadcasts in queue mode. */
  hasActiveExecution(threadId: string): boolean {
    if (this.deps.invocationTracker.has(threadId)) return true;
    this.sweepZombieSlots(threadId);
    const now = Date.now();
    for (const [key, reservation] of this.processingSlots) {
      if (!QueueProcessor.slotMatchesThread(key, threadId)) continue;
      if (now - reservation.startedAt < this.processingSlotTtlMs) return true;
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
      if (QueueProcessor.slotMatchesThread(key, threadId)) return reason;
    }
    return undefined;
  }

  /** #595: auto-recovery delay for failed/canceled slots (ms) */
  private static readonly PAUSE_RECOVERY_DELAY_MS = 10_000;

  private schedulePausedSlotRecovery(
    threadId: string,
    catId: string,
    status: 'canceled' | 'failed',
    epoch: number,
    invocationId: string | undefined,
    delayMs = QueueProcessor.PAUSE_RECOVERY_DELAY_MS,
  ): void {
    const sk = QueueProcessor.slotKey(threadId, catId);
    setTimeout(() => {
      if (this.pauseEpoch.get(sk) !== epoch || this.pausedSlots.get(sk) !== status) return;
      if (invocationId !== undefined && this.hasReplacementExecutionOwner(threadId, catId, invocationId)) return;

      const suppressionRemainingMs = this.autoResumeSuppressionRemainingMs(sk);
      if (suppressionRemainingMs > 0) {
        this.schedulePausedSlotRecovery(threadId, catId, status, epoch, invocationId, suppressionRemainingMs);
        return;
      }

      this.pausedSlots.delete(sk);
      this.deps.log.info(
        { threadId, catId, status },
        '[QueueProcessor] Auto-recovering paused slot after timeout (#595)',
      );
      if (this.hasDispatchableQueuedForThread(threadId)) {
        void this.tryExecuteNextAcrossUsers(threadId, catId).catch((err) => {
          this.deps.log.error({ err, threadId, catId }, '[QueueProcessor] Auto-recovery dequeue failed');
        });
      }
    }, delayMs);
  }

  /**
   * F194: Recover a parent-scoped reconciled zombie through per-cat failed-terminal
   * paths. The durable record target set defines cleanup scope; every tracker and
   * reservation projection is classified independently before any async side effect.
   * A replacement on one cat is a local fence, not a reason to leak exact-old sibling
   * owners or to apply the old terminal's pause/epoch effects to the replacement.
   */
  async onReconciledZombieComplete(
    threadId: string,
    targetCats: readonly string[],
    invocationId: string,
  ): Promise<{
    recoveredCatIds: string[];
    replacementCatIds: string[];
    ownerStates: Record<string, ExactExecutionOwnerState>;
  }> {
    const ownerProjections = [...new Set(targetCats)].map((catId) => {
      const trackerOwnerState = this.deps.invocationTracker.completeByExecutionId(threadId, catId, invocationId);
      const processingOwnerState = this.completeProcessingSlotByExecutionId(threadId, catId, invocationId);
      const ownerState: ExactExecutionOwnerState =
        trackerOwnerState === 'replacement' || processingOwnerState === 'replacement'
          ? 'replacement'
          : trackerOwnerState === 'released' || processingOwnerState === 'released'
            ? 'released'
            : 'absent';
      return { catId, trackerOwnerState, processingOwnerState, ownerState };
    });

    const recoveredCatIds = ownerProjections
      .filter(({ ownerState }) => ownerState !== 'replacement')
      .map(({ catId }) => catId);
    const replacementCatIds = ownerProjections
      .filter(({ ownerState }) => ownerState === 'replacement')
      .map(({ catId }) => catId);
    const ownerStates = Object.fromEntries(
      ownerProjections.map(({ catId, ownerState }) => [catId, ownerState]),
    ) as Record<string, ExactExecutionOwnerState>;

    this.deps.log.info(
      { threadId, invocationId, recoveredCatIds, replacementCatIds, ownerProjections },
      '[F194] classified every parent target for owner-fenced zombie recovery',
    );
    for (const catId of recoveredCatIds) {
      await this.onInvocationComplete(threadId, catId, 'failed', invocationId, [catId]);
    }
    return { recoveredCatIds, replacementCatIds, ownerStates };
  }

  /**
   * System-level entry: called when an invocation completes.
   * F108: Now slot-aware — catId identifies which slot completed.
   * - succeeded → auto-dequeue oldest across users
   * - canceled/failed → pause slot, notify users, auto-recover after delay
   */
  async onInvocationComplete(
    threadId: string,
    catId: string,
    status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
    invocationId: string | undefined,
    completedCatIds: readonly string[],
    primaryEntryRequeued = false,
    terminalInvocationIdByCatId: Readonly<Record<string, string>> = {},
    attemptedQueueEntryIds: readonly string[] = [],
    terminalConsumptionByInvocationId: Readonly<Record<string, QueueTerminalConsumptionWitness>> = {},
  ): Promise<void> {
    const sk = QueueProcessor.slotKey(threadId, catId);
    const isSuperseded = (candidateCatId: string): boolean =>
      invocationId !== undefined && this.hasReplacementExecutionOwner(threadId, candidateCatId, invocationId);
    if (invocationId) {
      for (const completedCatId of new Set(completedCatIds.length > 0 ? completedCatIds : [catId])) {
        await this.closeReminderAttemptsOnInvocationTerminal(
          threadId,
          completedCatId,
          terminalInvocationIdByCatId[completedCatId] ?? invocationId,
        );
      }
    }
    if (status !== 'succeeded' && invocationId) {
      const failedCatIds = new Set([catId, ...completedCatIds, ...this.collectBoundQueueCatIds(threadId)]);
      for (const failedCatId of failedCatIds) {
        if (isSuperseded(failedCatId)) continue;
        const preferredInvocationId = terminalInvocationIdByCatId[failedCatId] ?? invocationId;
        await this.settleExactSourceResponsesBeforeFailure({
          threadId,
          catId: failedCatId,
          invocationId: preferredInvocationId,
        });
        await this.returnBoundQueueTargetsAfterAggregateNonSuccess({
          threadId,
          catId: failedCatId,
          parentInvocationId: invocationId,
          preferredInvocationId,
        });
        await this.markQueuedFailedOnFailure(threadId, failedCatId, preferredInvocationId, attemptedQueueEntryIds);
      }
    }
    if (
      (status === 'canceled_by_user' || status === 'canceled') &&
      this.consumeAutoResumeSuppression(sk, invocationId)
    ) {
      this.supersedePausedTerminalEffects(threadId, catId);
      this.deps.log.info(
        { threadId, catId, status, invocationId },
        'Auto-resume suppressed (cancelAll) — queued entries preserved but not started',
      );
      return;
    }
    if (status === 'succeeded' || status === 'canceled_by_user') {
      this.pausedSlots.delete(sk);
      if (status === 'succeeded') {
        const successfulCatIds = new Set(completedCatIds);
        let exactReceiptSettlementBlocked = false;
        for (const handledCatId of successfulCatIds) {
          exactReceiptSettlementBlocked =
            (await this.settleQueuedTargetsAfterAggregateSuccess({
              threadId,
              catId: handledCatId,
              parentInvocationId: invocationId,
              preferredInvocationId: terminalInvocationIdByCatId[handledCatId] ?? invocationId,
              terminalConsumptionByInvocationId,
            })) || exactReceiptSettlementBlocked;
        }
        for (const failedCatId of this.collectBoundQueueCatIds(threadId)) {
          if (successfulCatIds.has(failedCatId)) continue;
          exactReceiptSettlementBlocked =
            (await this.returnBoundQueueTargetsAfterAggregateNonSuccess({
              threadId,
              catId: failedCatId,
              parentInvocationId: invocationId,
              preferredInvocationId: terminalInvocationIdByCatId[failedCatId] ?? invocationId,
            })) || exactReceiptSettlementBlocked;
        }
        if (exactReceiptSettlementBlocked) {
          this.deps.log.error(
            { threadId, invocationId, completedCatIds },
            '[QueueProcessor] aggregate success could not prove every exact Queue body exposure succeeded; immediate retry suppressed',
          );
          return;
        }
        const attemptedEntryIds = new Set(attemptedQueueEntryIds);
        const missingExposureCatIds = [...new Set(completedCatIds)].filter((completedCatId) =>
          this.deps.queue.hasAttemptedQueuedTargetAcrossUsers(threadId, completedCatId, attemptedEntryIds),
        );
        if (missingExposureCatIds.length > 0) {
          // A real route binds prompt exposure after durable child creation and
          // before provider start. Reaching success without that tuple is an
          // anomalous transport gap: retain Queue ownership, but never hot-loop
          // the same body through another provider invocation.
          this.deps.log.error(
            { threadId, invocationId, attemptedQueueEntryIds, missingExposureCatIds },
            '[QueueProcessor] succeeded execution lacked exact Queue body exposure; immediate retry suppressed',
          );
          return;
        }
      }
      if (status === 'canceled_by_user' && primaryEntryRequeued) {
        this.deps.log.info(
          { threadId, catId },
          'Canceled primary queue entry was restored; skipping blind cleanup-time restart',
        );
        return;
      }
      if (this.hasDispatchableQueuedForThread(threadId)) {
        await this.tryExecuteNextAcrossUsers(threadId, catId);
        await this.tryAutoExecute(threadId);
        if (status === 'canceled_by_user') {
          this.deps.log.info({ threadId, catId }, 'Auto-resumed queued entry after user cancel');
        }
      }
    } else {
      if (isSuperseded(catId)) return;
      if (this.hasQueuedAutoContinuationForThreadCat(threadId, catId)) {
        this.pausedSlots.delete(sk);
        await this.tryAutoExecute(threadId, { onlyContinuation: true, bypassNonAgentGate: true, onlyTargetCat: catId });
        return;
      }
      // canceled or failed → pause ONLY if there are queued entries to manage.
      if (!this.hasDispatchableQueuedForThread(threadId)) {
        this.pausedSlots.delete(sk);
        return;
      }
      const notifications = await this.preparePausedQueueNotifications(threadId);
      if (isSuperseded(catId)) return;
      if (!this.hasDispatchableQueuedForThread(threadId)) {
        this.pausedSlots.delete(sk);
        return;
      }
      const epoch = (this.pauseEpoch.get(sk) ?? 0) + 1;
      this.pauseEpoch.set(sk, epoch);
      this.pausedSlots.set(sk, status);
      this.emitPreparedPausedNotifications(threadId, status, notifications);

      // The failed primary entry has already been put back in Queue. Keep it
      // visible/retryable, but do not spin a blind 10-second retry loop against
      // the same provider failure. Manual continue or a later successful turn
      // can naturally dispatch it.
      if (primaryEntryRequeued) return;

      // #595: auto-recover paused slot after delay. A live force-reset fence
      // defers this same epoch until its current TTL expires; it never creates a
      // second recovery owner.
      this.schedulePausedSlotRecovery(threadId, catId, status, epoch, invocationId);
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
      this.supersedePausedSlot(QueueProcessor.slotKey(threadId, catId));
    } else {
      for (const key of [...this.pausedSlots.keys()]) {
        if (QueueProcessor.slotMatchesThread(key, threadId)) {
          this.supersedePausedSlot(key);
        }
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
   * Suppress automatic recovery while cancelAll/force-reset owns this slot.
   * Delayed recovery and connector admission observe the slot fence. A canceled
   * terminal may consume it only when its execution identity belongs to the
   * cancel action that armed the fence. The TTL bounds missing-terminal cases.
   */
  suppressAutoResume(threadId: string, catId: string, executionIds: readonly string[] = []): void {
    const sk = QueueProcessor.slotKey(threadId, catId);
    const now = Date.now();
    const existing = this.suppressedAutoResume.get(sk);
    const existingIsLive = existing && now - existing.setAt < QueueProcessor.SUPPRESS_TTL_MS;
    const mergedExecutionIds = existingIsLive ? new Set(existing.executionIds) : new Set<string>();
    for (const executionId of executionIds) mergedExecutionIds.add(executionId);
    this.suppressedAutoResume.set(sk, {
      setAt: now,
      executionIds: mergedExecutionIds,
      hasAnonymousFence: (existingIsLive && existing.hasAnonymousFence) || executionIds.length === 0,
    });
  }

  /**
   * Replace the slot's one pre-admission anonymous owner with its durable ID.
   * Binding preserves the reset timestamp: it identifies an existing fence,
   * rather than arming or renewing one.
   */
  bindAutoResumeSuppressionExecution(threadId: string, catId: string, executionId: string): void {
    const sk = QueueProcessor.slotKey(threadId, catId);
    if (this.autoResumeSuppressionRemainingMs(sk) === 0) return;
    const suppression = this.suppressedAutoResume.get(sk);
    if (!suppression?.hasAnonymousFence) return;
    suppression.hasAnonymousFence = false;
    suppression.executionIds.add(executionId);
  }

  private autoResumeSuppressionRemainingMs(slotKey: string): number {
    const suppression = this.suppressedAutoResume.get(slotKey);
    if (!suppression) return 0;
    const remainingMs = suppression.setAt + QueueProcessor.SUPPRESS_TTL_MS - Date.now();
    if (remainingMs > 0) return remainingMs;
    this.suppressedAutoResume.delete(slotKey);
    return 0;
  }

  /** True while cancelAll/force-reset still owns the next automatic transition. */
  isAutoResumeSuppressed(threadId: string, catId: string): boolean {
    return this.autoResumeSuppressionRemainingMs(QueueProcessor.slotKey(threadId, catId)) > 0;
  }

  private consumeAutoResumeSuppression(slotKey: string, invocationId: string | undefined): boolean {
    if (this.autoResumeSuppressionRemainingMs(slotKey) === 0) return false;
    const suppression = this.suppressedAutoResume.get(slotKey);
    if (!suppression) return false;
    if (!invocationId || !suppression.executionIds.has(invocationId)) return false;
    suppression.executionIds.delete(invocationId);
    if (suppression.executionIds.size === 0 && !suppression.hasAnonymousFence) {
      this.suppressedAutoResume.delete(slotKey);
    }
    return true;
  }

  /**
   * @deprecated Use releaseSlot(threadId, catId) instead. Kept for backward compat during migration.
   */
  releaseThread(threadId: string): void {
    for (const key of [...this.processingSlots.keys()]) {
      if (QueueProcessor.slotMatchesThread(key, threadId)) this.processingSlots.delete(key);
    }
  }

  /**
   * User-level entry: co-creator manually triggers processing their next entry.
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
  async tryAutoExecute(
    threadId: string,
    opts: { onlyContinuation?: boolean; bypassNonAgentGate?: boolean; onlyTargetCat?: string } = {},
  ): Promise<void> {
    this.sweepZombieSlots(threadId);
    if (!opts.bypassNonAgentGate && this.hasDispatchableNonAgentQueued(threadId)) return;
    const entries = (this.deps.queue.listAutoExecute?.(threadId) ?? [])
      .filter((entry) => !opts.onlyContinuation || entry.sourceCategory === 'continuation')
      .filter((entry) => !opts.onlyTargetCat || entry.targetCats[0] === opts.onlyTargetCat)
      .sort((a, b) => a.createdAt - b.createdAt);
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
      const processingEntry = this.deps.queue.getEntrySnapshot(threadId, entry.userId, entry.id);
      if (!(await this.startReservedEntry(processingEntry ?? entry, sk, entryCat))) continue;
      // Continue scanning — start all entries with free cat slots (parallel dispatch)
    }
  }

  // ── Internal ──

  private hasDispatchableQueuedForThread(threadId: string): boolean {
    return this.deps.queue.hasDispatchableQueuedForThread(threadId);
  }

  private hasDispatchableNonAgentQueued(threadId: string): boolean {
    if (!this.deps.queue.hasQueuedNonAgentForThread?.(threadId)) return false;
    for (const userId of this.deps.queue.listUsersForThread(threadId)) {
      for (const entry of this.deps.queue.list(threadId, userId)) {
        if (entry.source === 'agent' || entry.status !== 'queued') continue;
        const cat = entry.targetCats[0];
        if (!cat || !this.pausedSlots.has(QueueProcessor.slotKey(threadId, cat))) return true;
      }
    }
    return false;
  }

  private hasQueuedAutoContinuationForThreadCat(threadId: string, catId: string): boolean {
    return (this.deps.queue.listAutoExecute?.(threadId) ?? []).some(
      (entry) => entry.source === 'agent' && entry.sourceCategory === 'continuation' && entry.targetCats[0] === catId,
    );
  }

  private async startReservedEntry(entry: QueueEntry, slotKey: string, catId: string): Promise<boolean> {
    const reservation = this.reserveProcessingSlot(slotKey, entry.id, entry.userId);
    try {
      await this.persistQueueEntry(entry);
    } catch (err) {
      this.releaseProcessingSlot(slotKey, reservation);
      this.deps.queue.rollbackProcessing(entry.threadId, entry.id);
      this.deps.log.error(
        { err, threadId: entry.threadId, queueEntryId: entry.id },
        '[QueueProcessor] processing custody persistence failed; entry restored',
      );
      return false;
    }

    void this.executeEntry(entry, reservation).then(
      (result) => {
        if (!this.releaseProcessingSlot(slotKey, reservation)) {
          this.deps.log.info(
            { threadId: entry.threadId, catId, entryId: entry.id, invocationId: result.invocationId },
            '[QueueProcessor] skipped stale completion side effects after processing reservation changed',
          );
          this.signalDeliveryBatchDone(entry.threadId, result.status);
          return;
        }
        this.onInvocationComplete(
          entry.threadId,
          catId,
          result.status,
          result.invocationId,
          result.status === 'succeeded' ? result.successfulCatIds : entry.targetCats,
          result.primaryEntryRequeued,
          result.terminalInvocationIdByCatId,
          result.attemptedQueueEntryIds,
          result.terminalConsumptionByInvocationId,
        ).catch(() => {});
        this.signalDeliveryBatchDone(entry.threadId, result.status);
      },
      () => {
        if (!this.releaseProcessingSlot(slotKey, reservation)) {
          this.deps.log.info(
            { threadId: entry.threadId, catId, entryId: entry.id },
            '[QueueProcessor] skipped stale rejection side effects after processing reservation changed',
          );
          this.signalDeliveryBatchDone(entry.threadId, 'failed');
          return;
        }
        const requeued = this.deps.queue
          .list(entry.threadId, entry.userId)
          .some((candidate) => candidate.id === entry.id && candidate.status === 'queued');
        this.onInvocationComplete(entry.threadId, catId, 'failed', undefined, [], requeued).catch(() => {});
        this.signalDeliveryBatchDone(entry.threadId, 'failed');
      },
    );
    return true;
  }

  private async tryExecuteNextAcrossUsers(
    threadId: string,
    catId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry }> {
    this.sweepZombieSlots(threadId);

    // F175: scan by comparator order, skip entries whose target slot is busy
    const busyCats = new Set<string>();
    for (;;) {
      const entry = this.deps.queue.markProcessingAcrossUsers(threadId, busyCats);
      if (!entry) return { started: false };

      const entryCat = entry.targetCats[0] ?? catId;
      const entrySk = QueueProcessor.slotKey(threadId, entryCat);

      if (this.processingSlots.has(entrySk) || this.deps.invocationTracker.has(threadId, entryCat)) {
        this.deps.queue.rollbackProcessing(threadId, entry.id);
        busyCats.add(entryCat);
        continue;
      }

      if (!(await this.startReservedEntry(entry, entrySk, entryCat))) return { started: false };

      return { started: true, entry };
    }
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
      // 2026-06-02: observability — this silent !started is the source of a QUEUE_BUSY that gives
      // no clue why. Log the busy source so future "can't steer/dequeue" is diagnosable from logs.
      this.deps.log.info(
        { event: 'queue_not_started', threadId, entryCat, reason: 'processing_slot_busy' },
        '[QueueProcessor] processNext skipped: processingSlot busy',
      );
      return { started: false };
    }
    // Fix: skip if cat already has an active invocation via CLI/messages.ts (same guard as above)
    if (this.deps.invocationTracker.has(threadId, entryCat)) {
      this.deps.log.info(
        { event: 'queue_not_started', threadId, entryCat, reason: 'tracker_active' },
        '[QueueProcessor] processNext skipped: invocationTracker active',
      );
      return { started: false };
    }

    // Now safe to mark processing — slot is available
    const entry = this.deps.queue.markProcessing(threadId, userId);
    if (!entry) return { started: false };

    // Fire-and-forget execution — exact reservation cleanup owns completion side effects.
    if (!(await this.startReservedEntry(entry, sk, entryCat))) return { started: false };

    return { started: true, entry };
  }

  /**
   * Execute a queue entry — mirrors messages.ts background invocation pipeline.
   * Creates InvocationRecord → tracker.start → route execution → complete → cleanup.
   * Returns final status for chain auto-dequeue (called by tryExecuteNext*).
   */
  private async executeEntry(
    entry: QueueEntry,
    processingReservation?: ProcessingSlotReservation,
  ): Promise<QueueExecutionResult> {
    const { queue, invocationTracker, invocationRecordStore, router, socketManager, messageStore, log } = this.deps;
    const { threadId, userId, targetCats, intent, messageId } = entry;
    const primaryCat = targetCats[0] ?? 'unknown';

    const batchedEntryIds: string[] = [];
    const batchedMessageIds: string[] = [];
    const custodyEntryIds = new Set<string>();
    let content = entry.content;

    let controller: AbortController | undefined;
    let invocationId: string | undefined;
    let expectedInvocationStatus: InvocationStatus = 'queued';
    let finalStatus: InvocationFinalStatus = 'failed';
    let replayClaimLost = false;
    const terminalDispositions = new PerCatTerminalDispositionCollector({
      targetCatIds: targetCats,
      isCanceled: (catId) => invocationTracker.getSlotState?.(threadId, catId) === 'canceled',
    });
    const observedChildInvocationIdByCatId = new Map<string, string>();
    const terminalConsumptionByInvocationId = new Map<string, QueueTerminalConsumptionWitness>();
    let responseText = '';
    const cursorBoundaries = new Map<string, string>();
    const continuationCapsules = new Map<string, CollaborationContinuityCapsuleV1>();
    // Cloud Codex P2: track consumed continuation so we can re-store on failure/cancel.
    let consumedContinuation: ConsumedContinuationToken | undefined;
    // Cloud Codex P2: defer A2A consumption to success path — entries stay in queue
    // until the batch actually succeeds. The invocationTracker prevents double-pickup.
    let deferredA2AConsume = new Set<string>();
    // R4 fix: hoist streamStartPromise above try so the catch block can await it
    // before calling onStreamEnd → cleanupPlaceholders (the correct failure cleanup
    // sequence per messages.ts cleanupStreamingOnFailure).
    let streamStartPromise: Promise<void> | undefined;
    let executionError: unknown;
    let freshnessSupplementOriginalMessageId: string | undefined;
    let freshnessSupplementRequiredMessageIds: string[] = [];
    let supplementToolExecutionPolicy = entry.readOnlyToolPolicy;
    const bufferedSupplementMessages: unknown[] = [];
    let actionFencePreflightRejected = false;
    let actionFenceAggregateSucceeded = false;
    const actionFenceCommittedHolderCatIds = new Set<string>();
    const actionFenceOutputValidatedHolderCatIds = new Set<string>();
    let returnedExecutionResult: QueueExecutionResult | undefined;
    const executionResult = (status: InvocationFinalStatus): QueueExecutionResult => {
      // Keep finally cleanup and the caller-visible completion status on one
      // source of truth. Several preflight exits return directly through this
      // helper; leaving finalStatus at its default would requeue a successful
      // entry and immediately auto-dispatch it forever.
      finalStatus = status;
      // markProcessing() intentionally returns a shallow execution snapshot,
      // while exact prompt exposure is recorded later on the canonical Queue
      // entry. A bodyless routing guard can own the terminal stream event, but
      // it must never replace the ordinary child that actually read the Queue
      // body as the receipt witness.
      const currentEntry = queue.getEntrySnapshot(threadId, userId, entry.id);
      const result: QueueExecutionResult = {
        status,
        ...(invocationId ? { invocationId } : {}),
        successfulCatIds: status === 'succeeded' ? terminalDispositions.getSuccessfulCatIds() : [],
        attemptedQueueEntryIds: [entry.id, ...batchedEntryIds],
        terminalInvocationIdByCatId: Object.fromEntries(
          targetCats.flatMap((catId) => {
            const exactInvocationId =
              currentEntry?.queuedSeenInvocationIdByCatId?.[catId] ?? observedChildInvocationIdByCatId.get(catId);
            return exactInvocationId ? [[catId, exactInvocationId]] : [];
          }),
        ),
        terminalConsumptionByInvocationId: Object.fromEntries(terminalConsumptionByInvocationId),
      };
      returnedExecutionResult = result;
      return result;
    };
    const finalizeActionFenceOutcome = async (
      outcome: 'failed' | 'canceled',
      hasResponse: boolean,
      catIds: readonly string[] = [primaryCat],
    ): Promise<boolean> => {
      const fence = entry.actionSuccessorFence;
      if (!fence) return true;
      const leaseStore = this.deps.actionSuccessorLeaseStore;
      try {
        if (!leaseStore) throw new Error('action successor lease store unavailable');
        const holders = [...new Set(catIds)].filter((catId) => !actionFenceCommittedHolderCatIds.has(catId));
        if (holders.length === 0) return true;
        for (const catId of holders) {
          const committed = await leaseStore.commitOutcome(fence.leaseId, {
            generation: fence.generation,
            catId,
            outcome,
            evidenceRef: `queue:${fence.dispatchId}:${catId}:${outcome}`,
            now: Date.now(),
          });
          if (committed.outcome !== 'recorded') {
            if (committed.outcome === 'subject_terminal' && hasResponse) {
              successorResponsesAfterTerminalState.add(1);
            }
            actionFencePreflightRejected = true;
            log.info(
              {
                threadId,
                entryId: entry.id,
                leaseId: fence.leaseId,
                generation: fence.generation,
                catId,
                reason: committed.outcome,
              },
              '[F167-S] action successor outcome commit rejected',
            );
            return false;
          }
          if (committed.lease?.status === 'replaceable') {
            unresolvedSubjectWithoutActiveCustodyTotal.add(1);
          }
          actionFenceCommittedHolderCatIds.add(catId);
        }
        return true;
      } catch (err) {
        actionFencePreflightRejected = true;
        log.error(
          { err, threadId, entryId: entry.id, leaseId: fence.leaseId },
          '[F167-S] action successor output commit failed; suppressing carrier response',
        );
        return false;
      }
    };
    const revalidateActionFenceForOutput = async (catId: string): Promise<boolean> => {
      const fence = entry.actionSuccessorFence;
      if (!fence) return true;
      if (actionFenceOutputValidatedHolderCatIds.has(catId)) return true;
      const leaseStore = this.deps.actionSuccessorLeaseStore;
      try {
        if (!leaseStore) throw new Error('action successor lease store unavailable');
        // Rolling-deploy compatibility: pre-S.1 leases have no terminal predicate.
        // Their original carrier-success CAS remains the only completion path;
        // predicate-backed generations must instead wait for verified evidence.
        if (!fence.terminalPredicateDigest) {
          const committed = await leaseStore.commitOutcome(fence.leaseId, {
            generation: fence.generation,
            catId,
            outcome: 'succeeded',
            evidenceRef: `queue:${fence.dispatchId}:${catId}:succeeded`,
            now: Date.now(),
          });
          if (committed.outcome === 'recorded') {
            leaseSucceededSubjectNonterminalTotal.add(1);
            actionFenceCommittedHolderCatIds.add(catId);
            actionFenceOutputValidatedHolderCatIds.add(catId);
            return true;
          }
          if (committed.outcome === 'subject_terminal') successorResponsesAfterTerminalState.add(1);
          actionFencePreflightRejected = true;
          log.info(
            {
              threadId,
              entryId: entry.id,
              leaseId: fence.leaseId,
              generation: fence.generation,
              catId,
              reason: committed.outcome,
            },
            '[F167-S.1] legacy action successor success commit rejected',
          );
          return false;
        }
        const preflight = await leaseStore.preflightOutput(
          fence.leaseId,
          fence.generation,
          catId,
          fence.terminalPredicateDigest,
        );
        if (preflight.ok) {
          actionFenceOutputValidatedHolderCatIds.add(catId);
          return true;
        }
        if (preflight.reason === 'subject_terminal') successorResponsesAfterTerminalState.add(1);
        actionFencePreflightRejected = true;
        log.info(
          {
            threadId,
            entryId: entry.id,
            leaseId: fence.leaseId,
            generation: fence.generation,
            reason: preflight.reason,
          },
          '[F167-S.1] action successor output preflight rejected',
        );
        return false;
      } catch (err) {
        actionFencePreflightRejected = true;
        log.error(
          { err, threadId, entryId: entry.id, leaseId: fence.leaseId },
          '[F167-S.1] action successor output preflight failed; suppressing carrier response',
        );
        return false;
      }
    };

    try {
      // F167 Phase S: a queue row is only a carrier. The durable action lease owns
      // successor cardinality; fail closed before creating an invocation when its
      // generation was replaced or the external subject reached terminal truth.
      if (entry.actionSuccessorFence) {
        const leaseStore = this.deps.actionSuccessorLeaseStore;
        if (!leaseStore) {
          log.error(
            { threadId, entryId: entry.id, leaseId: entry.actionSuccessorFence.leaseId },
            '[F167-S] action successor lease store unavailable; canceling fenced queue entry',
          );
          actionFencePreflightRejected = true;
          finalStatus = 'canceled';
          await this.cancelMessageIds(
            [entry.messageId ?? '', ...(entry.mergedMessageIds ?? [])],
            log,
            'start_preflight_store_unavailable',
          );
          return executionResult('canceled');
        }
        try {
          const preflight = await leaseStore.preflight(
            entry.actionSuccessorFence.leaseId,
            entry.actionSuccessorFence.generation,
            entry.actionSuccessorFence.terminalPredicateDigest,
          );
          if (!preflight.ok) {
            log.info(
              {
                threadId,
                entryId: entry.id,
                leaseId: entry.actionSuccessorFence.leaseId,
                generation: entry.actionSuccessorFence.generation,
                reason: preflight.reason,
              },
              '[F167-S] action successor canceled at queue preflight',
            );
            actionFencePreflightRejected = true;
            finalStatus = 'canceled';
            await this.cancelMessageIds(
              [entry.messageId ?? '', ...(entry.mergedMessageIds ?? [])],
              log,
              'start_preflight_rejected',
            );
            return executionResult('canceled');
          }
        } catch (err) {
          log.error(
            { err, threadId, entryId: entry.id, leaseId: entry.actionSuccessorFence.leaseId },
            '[F167-S] action successor preflight failed; canceling fenced queue entry',
          );
          actionFencePreflightRejected = true;
          finalStatus = 'canceled';
          await this.cancelMessageIds(
            [entry.messageId ?? '', ...(entry.mergedMessageIds ?? [])],
            log,
            'start_preflight_error',
          );
          return executionResult('canceled');
        }
      }

      // 1. Create InvocationRecord (before batching — avoid claiming entries on duplicate)
      // Connector-sourced entries use connector-${messageId} to match the direct-execution
      // idempotency path, so retries after queue processing are also caught persistently.
      const idempotencyKey =
        entry.source === 'connector' && messageId
          ? `connector-${messageId}`
          : entry.actionSuccessorFence && entry.idempotencyKey
            ? actionSuccessorInvocationIdempotencyKey(entry.idempotencyKey)
            : `queue-${entry.id}-${entry.processingStartedAt ?? entry.createdAt}`;
      const actionLeaseCarrier: InvocationActionLeaseCarrier = entry.actionSuccessorFence
        ? {
            kind: 'action_successor',
            leaseId: entry.actionSuccessorFence.leaseId,
            generation: entry.actionSuccessorFence.generation,
          }
        : { kind: 'none' };
      const createResult = await invocationRecordStore.create({
        threadId,
        userId,
        targetCats,
        intent,
        idempotencyKey,
        actionLeaseCarrier,
      });

      invocationId = createResult.invocationId;
      if (createResult.outcome === 'duplicate') {
        const replayEligible =
          (entry.source === 'connector' && Boolean(messageId)) || Boolean(entry.actionSuccessorFence);
        const existing =
          replayEligible && invocationRecordStore.get ? await invocationRecordStore.get(invocationId) : null;
        if (
          !isExactReplayableQueueRecord(existing, {
            threadId,
            userId,
            targetCats,
            intent,
            idempotencyKey,
            actionLeaseCarrier,
          })
        ) {
          log.warn({ threadId, entryId: entry.id }, '[QueueProcessor] Duplicate invocation, skipping');
          if (entry.freshnessSupplementId && this.deps.freshnessClosureStore) {
            const supplement = await this.deps.freshnessClosureStore.getSupplement(entry.freshnessSupplementId);
            if (supplement?.status === 'pending') {
              const failed = await this.deps.freshnessClosureStore.failSupplement(supplement.id, {
                reason: 'infrastructure',
                now: Date.now(),
              });
              this.broadcastFreshnessSupplement(failed);
            }
          }
          finalStatus = 'succeeded';
          return executionResult('succeeded');
        }
        expectedInvocationStatus = existing.status;
        log.info(
          { threadId, entryId: entry.id, invocationId, status: existing.status },
          '[QueueProcessor] Replaying recoverable invocation',
        );
      }

      if (
        processingReservation &&
        !this.bindProcessingSlotInvocation(
          QueueProcessor.slotKey(threadId, primaryCat),
          processingReservation,
          invocationId,
        )
      ) {
        log.info(
          { threadId, entryId: entry.id, invocationId },
          '[QueueProcessor] canceled pre-start execution after processing reservation was replaced',
        );
        await invocationRecordStore.update(invocationId, {
          status: 'canceled',
          error: 'queue_processing_reservation_replaced',
        });
        finalStatus = 'canceled';
        return executionResult('canceled');
      }

      // ADR-042: a supplement queue row is only a carrier projection. Resolve and
      // claim the exact durable sequence before launching any model.
      if (entry.freshnessSupplementId) {
        const supplementStore = this.deps.freshnessClosureStore;
        if (!supplementStore) {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: 'freshness supplement store unavailable',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }
        if (entry.freshnessClosureId) {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: 'queue entry cannot carry both freshness closure and supplement identities',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }
        const supplement = await supplementStore.getSupplement(entry.freshnessSupplementId);
        // External replacement retires the exact Queue reservation synchronously, but
        // `getSupplement()` can still be awaiting durable state when that happens. Fence
        // immediately after the await, before interpreting or mutating supplement truth;
        // otherwise this stale coroutine can report a generic carrier cancellation (or
        // race a claim) instead of closing its own InvocationRecord as superseded.
        if (
          processingReservation &&
          !this.canStartReservedTargetSet(threadId, targetCats, primaryCat, processingReservation, invocationId)
        ) {
          log.info(
            { threadId, entryId: entry.id, invocationId },
            '[QueueProcessor] canceled supplement preflight after processing reservation was replaced',
          );
          await invocationRecordStore.update(invocationId, {
            status: 'canceled',
            error: 'queue_processing_reservation_replaced',
          });
          finalStatus = 'canceled';
          return executionResult('canceled');
        }
        if (!supplement || supplement.status !== 'pending') {
          log.info(
            {
              threadId,
              entryId: entry.id,
              supplementId: entry.freshnessSupplementId,
              status: supplement?.status ?? 'missing',
            },
            '[F254] supplement carrier canceled at preflight',
          );
          await invocationRecordStore.update(invocationId, { status: 'canceled' });
          finalStatus = 'succeeded';
          return executionResult('succeeded');
        }
        const carrierMismatch =
          supplement.userId !== userId ||
          supplement.threadId !== threadId ||
          supplement.catId !== primaryCat ||
          targetCats.length !== 1 ||
          entry.freshnessSupplementLineageId !== supplement.lineageId ||
          entry.freshnessSupplementSeq !== supplement.seq;
        if (carrierMismatch) {
          const failed = await supplementStore.failSupplement(supplement.id, {
            reason: 'infrastructure',
            now: Date.now(),
          });
          this.broadcastFreshnessSupplement(failed);
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: 'freshness supplement carrier scope mismatch',
            freshnessSupplementId: supplement.id,
            freshnessSupplementStatus: 'failed',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }
        if (entry.readOnlyToolPolicy?.mode !== 'read_only') {
          const failed = await supplementStore.failSupplement(supplement.id, {
            reason: 'read_only_policy_unavailable',
            now: Date.now(),
          });
          this.broadcastFreshnessSupplement(failed);
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: 'freshness supplement read-only policy unavailable',
            freshnessSupplementId: supplement.id,
            freshnessSupplementStatus: 'failed',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }

        const preflight = await scanFreshnessSupplementPreflight({ supplement, messageStore });
        if (preflight.kind === 'blocked') {
          const failed = await supplementStore.failSupplement(supplement.id, {
            reason: 'infrastructure',
            now: Date.now(),
          });
          this.broadcastFreshnessSupplement(failed);
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: `freshness supplement preflight incomplete: ${preflight.evidenceRefs.join(',')}`,
            freshnessSupplementId: supplement.id,
            freshnessSupplementStatus: 'failed',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }

        let refreshed = supplement;
        if (
          preflight.requiredFrontierMessageId !== supplement.requiredFrontierMessageId ||
          preflight.requiredMessageIds.length !== supplement.requiredMessageIds.length
        ) {
          const refreshResult = await supplementStore.offerSupplement({
            lineageId: supplement.lineageId,
            originalMessageId: supplement.originalMessageId,
            userId: supplement.userId,
            threadId: supplement.threadId,
            catId: supplement.catId,
            requiredMessageIds: preflight.requiredMessageIds,
            requiredFrontierMessageId: preflight.requiredFrontierMessageId,
            replayUnsafeToolNames: supplement.replayUnsafeToolNames,
            now: Date.now(),
          });
          refreshed = refreshResult.supplement;
          this.broadcastFreshnessSupplement(refreshed);
        }
        if (refreshed.id !== supplement.id || refreshed.status !== 'pending') {
          await invocationRecordStore.update(invocationId, {
            status: 'canceled',
            freshnessSupplementId: supplement.id,
            freshnessSupplementStatus: refreshed.status,
          });
          finalStatus = 'succeeded';
          return executionResult('succeeded');
        }

        const claimed = await supplementStore.claimSupplement(refreshed.id, {
          invocationId,
          now: Date.now(),
        });
        this.broadcastFreshnessSupplement(claimed);
        supplementToolExecutionPolicy = {
          mode: 'read_only',
          replayDeniedToolNames: claimed.replayUnsafeToolNames,
        };
        freshnessSupplementOriginalMessageId = claimed.originalMessageId;
        freshnessSupplementRequiredMessageIds = [...claimed.requiredMessageIds];
        const original = await messageStore.getById(claimed.originalMessageId);
        const requiredMessages = await Promise.all(
          claimed.requiredMessageIds.map((requiredId) => messageStore.getById(requiredId)),
        );
        const missingIds = [
          ...(!original ? [claimed.originalMessageId] : []),
          ...claimed.requiredMessageIds.filter((_id, index) => !requiredMessages[index]),
        ];
        if (missingIds.length > 0) {
          const failed = await supplementStore.failSupplement(claimed.id, {
            invocationId,
            reason: 'infrastructure',
            now: Date.now(),
          });
          this.broadcastFreshnessSupplement(failed);
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: `freshness supplement message bodies missing: ${missingIds.join(',')}`,
            freshnessSupplementId: claimed.id,
            freshnessSupplementStatus: 'failed',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }
        content = [
          `[Freshness Supplement Check ${claimed.id}]`,
          '你已经发表了下面这条回复。它不会被替换或删除：',
          `[Published original ${original!.id}]`,
          original!.content,
          '[Relevant updates that arrived before publication]',
          ...requiredMessages.map((message) => {
            const sender = message!.catId ?? message!.source?.label ?? 'user';
            return `- [${message!.id}] ${sender}: ${JSON.stringify(message!.content)}`;
          }),
          '只判断这些更新是否需要给读者追加一条简短补充。',
          `若无需补充，只输出这一行且不要添加其他文字：${SUPPLEMENT_DECLINE_MARKER}`,
          '若需要补充，只输出将作为新回复发表的补充正文；不要重写原回复，不要路由、传球、发卡片或执行任何副作用。',
        ].join('\n');
        await invocationRecordStore.update(invocationId, {
          freshnessSupplementId: claimed.id,
          freshnessSupplementLineageId: claimed.lineageId,
          freshnessSupplementSeq: claimed.seq,
          freshnessSupplementStatus: claimed.status,
        });
        if (this.deps.deliveryCursorStore) {
          try {
            await this.deps.deliveryCursorStore.ackSeenCursor(
              userId,
              primaryCat as CatId,
              threadId,
              claimed.requiredFrontierMessageId,
            );
          } catch (err) {
            log.warn(
              { threadId, supplementId: claimed.id, invocationId, err },
              '[F254] supplement seenCursor seed failed; exact output scan will degrade visibly',
            );
          }
        }
      }

      // F254 Phase E: a queue row is only scheduling coverage. Before model execution,
      // atomically adopt the persistent closure and rebuild the prompt from current truth.
      if (entry.freshnessClosureId) {
        const closureStore = this.deps.freshnessClosureStore;
        if (!closureStore) {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: 'freshness closure store unavailable',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }
        const closure = await closureStore.get(entry.freshnessClosureId);
        if (!closure || closure.status !== 'pending') {
          recordFreshnessSuccessorPreflightCanceled(closure?.status ?? 'missing');
          log.info(
            { threadId, entryId: entry.id, closureId: entry.freshnessClosureId, status: closure?.status ?? 'missing' },
            '[F254-E] closure successor canceled at preflight',
          );
          await invocationRecordStore.update(invocationId, { status: 'canceled' });
          finalStatus = 'succeeded';
          return executionResult('succeeded');
        }
        const committedMessage = await messageStore.getByIdempotencyKey(
          userId,
          threadId,
          freshnessClosureFinalIdempotencyKey(closure.id),
        );
        if (committedMessage) {
          const claimed = await closureStore.claimAttempt(closure.id, {
            invocationId,
            inputFrontierMessageId: closure.observedRawFrontierMessageId ?? closure.requiredFrontierMessageId,
            observedRawFrontierMessageId: closure.observedRawFrontierMessageId,
            now: Date.now(),
          });
          if (claimed.status === 'blocked') {
            await this.deps.streamingHook?.onClosureBlocked?.(
              threadId,
              primaryCat as CatId,
              claimed.blockedReason ?? 'attempt_budget_exhausted',
              invocationId,
            );
            await invocationRecordStore.update(invocationId, {
              status: 'canceled',
              freshnessClosureId: claimed.id,
              freshnessClosureStatus: claimed.status,
            });
            finalStatus = 'succeeded';
            return executionResult('succeeded');
          }
          const committed = await closureStore.commit(claimed.id, {
            invocationId,
            messageId: committedMessage.id,
            observedRawFrontierMessageId: claimed.observedRawFrontierMessageId,
            draftContent: committedMessage.content,
            evidenceRefs: [`message:${committedMessage.id}`, 'recovery:idempotency-hit'],
            now: Date.now(),
          });
          this.broadcastFreshnessClosure(committed);
          recordFreshnessClosureTransition('committed');
          await requireInvocationRecordUpdate({
            store: invocationRecordStore,
            invocationId,
            update: {
              status: 'succeeded',
              successfulCatIds: [primaryCat as CatId],
              freshnessClosureId: committed.id,
              freshnessClosureStatus: committed.status,
            },
            writer: 'queue recovery idempotency path',
          });
          finalStatus = 'succeeded';
          return executionResult('succeeded');
        }

        const preflight = await scanFreshnessClosurePreflight({
          closure,
          messageStore,
          ...(this.deps.turnExecutionStore ? { turnExecutionStore: this.deps.turnExecutionStore } : {}),
        });
        if (preflight.kind === 'blocked') {
          recordFreshnessClosureStage('preflight_blocked');
          const blocked = await closureStore.blockPreflight(closure.id, {
            evidenceRefs: preflight.evidenceRefs,
            now: Date.now(),
          });
          this.broadcastFreshnessClosure(blocked);
          recordFreshnessClosureTransition('blocked');
          await this.deps.streamingHook?.onClosureBlocked?.(
            threadId,
            primaryCat as CatId,
            blocked.blockedReason ?? 'freshness_preflight_incomplete',
            invocationId,
          );
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: `freshness closure preflight incomplete: ${preflight.evidenceRefs.join(',')}`,
            freshnessClosureId: blocked.id,
            freshnessClosureStatus: blocked.status,
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }

        const refreshed = await closureStore.refreshFrontier(closure.id, {
          requiredMessageIds: preflight.requiredMessageIds,
          requiredFrontierMessageId: preflight.requiredFrontierMessageId,
          observedRawFrontierMessageId: preflight.observedRawFrontierMessageId,
          now: Date.now(),
        });
        const claimed = await closureStore.claimAttempt(refreshed.id, {
          invocationId,
          inputFrontierMessageId: refreshed.observedRawFrontierMessageId ?? refreshed.requiredFrontierMessageId,
          observedRawFrontierMessageId: refreshed.observedRawFrontierMessageId,
          now: Date.now(),
        });
        if (claimed.status === 'blocked') {
          await this.deps.streamingHook?.onClosureBlocked?.(
            threadId,
            primaryCat as CatId,
            claimed.blockedReason ?? 'attempt_budget_exhausted',
            invocationId,
          );
          await invocationRecordStore.update(invocationId, {
            status: 'canceled',
            freshnessClosureId: claimed.id,
            freshnessClosureStatus: claimed.status,
          });
          finalStatus = 'succeeded';
          return executionResult('succeeded');
        }
        const originMessage = claimed.originTriggerMessageId
          ? await messageStore.getById(claimed.originTriggerMessageId)
          : null;
        const requiredMessages = await Promise.all(
          claimed.requiredMessageIds.map((requiredId) => messageStore.getById(requiredId)),
        );
        const missingIds = [
          ...(!originMessage && claimed.originTriggerMessageId ? [claimed.originTriggerMessageId] : []),
          ...claimed.requiredMessageIds.filter((_id, index) => !requiredMessages[index]),
        ];
        if (missingIds.length > 0) {
          const blocked = await closureStore.blockAttempt(claimed.id, {
            invocationId,
            reason: 'infrastructure',
            evidenceRefs: missingIds.map((id) => `missing-message:${id}`),
            now: Date.now(),
          });
          this.broadcastFreshnessClosure(blocked);
          recordFreshnessClosureTransition('blocked');
          await this.deps.streamingHook?.onClosureBlocked?.(
            threadId,
            primaryCat as CatId,
            blocked.blockedReason ?? 'infrastructure',
            invocationId,
          );
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: `freshness closure message bodies missing: ${missingIds.join(',')}`,
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }
        content = [
          `[Freshness Catch Closure ${claimed.id}]`,
          `Current raw frontier: ${claimed.observedRawFrontierMessageId ?? claimed.requiredFrontierMessageId}`,
          '[Original intent]',
          `- [${originMessage!.id}] ${originMessage!.catId ?? originMessage!.source?.label ?? 'user'}: ${JSON.stringify(originMessage!.content)}`,
          '[Latest retained draft]',
          JSON.stringify(claimed.latestDraft.content),
          '[Current relevant updates]',
          ...requiredMessages
            .filter((message) => message!.id !== claimed.originTriggerMessageId)
            .map((message) => {
              const sender = message!.catId ?? message!.source?.label ?? 'user';
              return `- [${message!.id}] ${sender}: ${JSON.stringify(message!.content)}`;
            }),
          ...(claimed.replayUnsafeToolNames?.length
            ? [
                `安全边界：上一轮已经尝试过这些不可盲目重放的工具：${claimed.replayUnsafeToolNames.join(', ')}。`,
                '先核对当前外部状态；不要重复已完成的副作用。只有确认动作尚未发生时才能再次调用。',
              ]
            : []),
          '请以当前 frontier 为准给出一条完整回复；旧草稿只用于保留未提交工作，不是要求照抄或重答过时问题。',
        ].join('\n');
        await invocationRecordStore.update(invocationId, {
          freshnessClosureId: claimed.id,
          freshnessInputFrontierMessageId: claimed.requiredFrontierMessageId,
          freshnessClosureStatus: claimed.status,
        });
        // F254 Phase E (ADR-041 §5): the injected bodies above count as seen.
        // The successor entry carries no messageId, so route-serial's incrementalMode
        // AC-A3 cursor seed never runs for it — without this ack the output freshness
        // gate re-reads the frozen pre-supersede cursor, judges the exact messages we
        // just injected as unseen, and supersedes every replacement in a loop
        // (2026-07-11 thread_mrf4rg9atprwlyzq silent message loss).
        // Fail-open: ack is a gate seed, not commit truth — on failure the gate simply
        // re-checks at commit (bounded by closure budgets), never blocks the attempt.
        if (this.deps.deliveryCursorStore) {
          try {
            await this.deps.deliveryCursorStore.ackSeenCursor(
              userId,
              primaryCat as CatId,
              threadId,
              claimed.observedRawFrontierMessageId ?? claimed.requiredFrontierMessageId,
            );
          } catch (err) {
            log.warn(
              { threadId, closureId: claimed.id, invocationId, err },
              '[F254-E] closure successor seenCursor seed failed — freshness gate will re-check at commit (fail-open)',
            );
          }
        }
      }

      // F175: user-message batching — collect adjacent matching entries
      // Placed after idempotency check so batched entries aren't dropped on duplicate
      if (entry.source === 'user') {
        const batch = queue.collectUserBatch(threadId, userId);
        const sortedTargets = [...entry.targetCats].sort();
        const matching = batch.filter(
          (e) =>
            e.source === 'user' &&
            e.intent === entry.intent &&
            e.ownerAuthProvenance === entry.ownerAuthProvenance &&
            e.targetCats.length === sortedTargets.length &&
            [...e.targetCats].sort().every((t, i) => t === sortedTargets[i]),
        );
        for (const be of matching) {
          if (!queue.markProcessingById(threadId, be.id)) continue;
          batchedEntryIds.push(be.id);
          if (be.messageId) batchedMessageIds.push(be.messageId);
          content = content + '\n' + be.content;
        }
      }

      // F194 R7: freshness/action carrier preflight can await after the reservation
      // binds. Re-fence the complete target set immediately before tracker
      // registration: the primary must still own its exact reservation, and every
      // secondary target must still be free. There is intentionally no await between
      // this check and startAll.
      if (
        processingReservation &&
        !this.canStartReservedTargetSet(threadId, targetCats, primaryCat, processingReservation, invocationId)
      ) {
        log.info(
          { threadId, entryId: entry.id, invocationId },
          '[QueueProcessor] canceled pre-start execution after async preflight replaced its reservation',
        );
        await invocationRecordStore.update(invocationId, {
          status: 'canceled',
          error: 'queue_processing_reservation_replaced',
        });
        finalStatus = 'canceled';
        return executionResult('canceled');
      }

      // 2. Start tracking ALL target cats (shared controller for F5/reconnect recovery)
      controller = invocationTracker.startAll(threadId, targetCats, userId, invocationId);

      // F216 c3: supersede tombstone guard. If a same-turn follow-up arrived during the
      // pre-start window (between markProcessingById and startAll), callback-a2a-trigger
      // removed this entry as a tombstone signal. Detect it here and self-abort before
      // routeExecution — the follow-up is already queued and will run after this returns.
      //
      // Status: 'canceled_by_user' (not plain 'canceled') so onInvocationComplete normally
      // takes the immediate-restart branch (tryAutoExecute) rather than the 10s pause
      // branch. If cancelAll/force-reset currently owns the slot, its suppression wins
      // and the follow-up remains queued; otherwise it restarts after slot release.
      if (!queue.list(threadId, userId).some((e) => e.id === entry.id)) {
        log.info(
          { threadId, entryId: entry.id },
          '[F216-c3] entry superseded during pre-start window — self-abort before routeExecution',
        );
        // Close the invocation record (created but never executed).
        if (invocationId) {
          await invocationRecordStore.update(invocationId, { status: 'canceled' });
        }
        finalStatus = 'canceled_by_user';
        return executionResult('canceled_by_user');
      }

      // 3. Backfill message ID
      if (messageId) {
        await invocationRecordStore.update(invocationId, {
          userMessageId: messageId,
        });
      }

      // 4. Mark running
      const claimedInvocation = await invocationRecordStore.update(invocationId, {
        status: 'running',
        expectedStatus: expectedInvocationStatus,
        ...(expectedInvocationStatus === 'failed' ? { error: '' } : {}),
      });
      if (claimedInvocation === null) {
        replayClaimLost = true;
        log.info(
          { threadId, entryId: entry.id, invocationId, expectedInvocationStatus },
          '[QueueProcessor] Replay claim lost; another executor owns the invocation',
        );
        finalStatus = 'succeeded';
        return executionResult('succeeded');
      }
      this.routeChainTracker.start(invocationId);

      // F220 Phase 1: queued execution needs the same earliest liveness signal
      // as direct /api/messages execution. intent_mode stays deferred until the
      // first CLI event (#768); spawn_started is only "process is being spawned".
      if (!controller.signal.aborted) {
        socketManager.broadcastToRoom(`thread:${threadId}`, 'spawn_started', {
          threadId,
          targetCats,
          invocationId,
        });
      }

      // 5. intent_mode deferred to first CLI event (#768: avoid "replying" when CLI never starts)
      let intentModeBroadcast = false;

      // 6. Emit queue_updated (processing)
      await emitQueueUpdated(socketManager, userId, threadId, queue.list(threadId, userId), messageStore, 'processing');

      // F098-D: Mark queued messages as delivered (set deliveredAt = now)
      // F117: Collect full message objects for frontend bubble rendering
      const allMessageIds: string[] = [messageId ?? '', ...(entry.mergedMessageIds ?? []), ...batchedMessageIds].filter(
        Boolean,
      );
      const currentContextMessageIds = new Set(allMessageIds);
      const deliveredNow = Date.now();
      for (const queueEntryId of [entry.id, ...batchedEntryIds]) {
        const queueEntry =
          queue.getEntrySnapshot(threadId, userId, queueEntryId) ?? (queueEntryId === entry.id ? entry : null);
        if (queueEntry && (await this.hasDurableMessageCustody(queueEntry))) {
          custodyEntryIds.add(queueEntryId);
        }
      }
      await this.markDeliveredAndEmit(userId, threadId, allMessageIds, deliveredNow);

      // 6b. #815: Consume redundant A2A trigger entries — if target cats are
      // already being processed in this batch, queued A2A entries for those cats
      // are pure triggers whose source messages are already visible in context.
      // Two-step: find candidates, then async-filter by message delivery status.
      // Text-scan A2A entries reference persisted agent messages (deliveryStatus
      // undefined/delivered → safe to consume). Callback A2A entries reference
      // messages with deliveryStatus:'queued' → NOT safe (message not yet delivered).
      const activeCatSet = new Set(targetCats);
      const a2aCandidates = queue.findSubsumedA2ACandidates(threadId, userId, activeCatSet);
      if (a2aCandidates.length > 0) {
        const safeToConsume = new Set<string>();
        for (const candidate of a2aCandidates) {
          if (!candidate.messageId) continue; // no message ref → conservative, skip
          const candidateMessageIds = [candidate.messageId, ...(candidate.mergedMessageIds ?? [])];
          if (!candidateMessageIds.every((mid) => currentContextMessageIds.has(mid))) {
            continue; // delivered historical trigger, but not part of this invocation context
          }
          const msg = await messageStore.getById(candidate.messageId);
          if (!msg) continue; // message not found → skip
          if (msg.deliveryStatus === 'queued') continue; // not yet delivered → don't consume
          // Cloud Codex P2: also check mergedMessageIds — coalesced entries can
          // have additional trigger messages that are still queued (e.g. a callback
          // post_message coalesced into a text-scan A2A entry). If ANY merged
          // trigger is still queued, don't consume the entry.
          let mergedSafe = true;
          if (candidate.mergedMessageIds?.length) {
            for (const mid of candidate.mergedMessageIds) {
              const mergedMsg = await messageStore.getById(mid);
              if (mergedMsg?.deliveryStatus === 'queued') {
                mergedSafe = false;
                break;
              }
            }
          }
          if (!mergedSafe) continue;
          safeToConsume.add(candidate.id);
        }
        if (safeToConsume.size > 0) {
          // Cloud Codex P2: defer actual removal to the success path in `finally`.
          // If the batch fails/cancels, entries stay in queue for retry.
          // invocationTracker prevents double-pickup during execution.
          deferredA2AConsume = safeToConsume;
          log.info(
            {
              threadId,
              deferredCount: safeToConsume.size,
              deferredIds: [...safeToConsume],
            },
            '[QueueProcessor] #815: identified subsumed A2A entries (deferred to success)',
          );
        }
      }

      // 6c. F224: single-cat continuation lifecycle is owned by
      // SessionContinuationCoordinator. Multi-target still skips prepare because
      // content is shared across cats; a cat-specific continuation prompt would leak.
      if (this.sessionContinuationCoordinator && targetCats.length === 1) {
        const singleCatId = targetCats[0]!;
        try {
          const originalContent = content;
          const prepared = await this.sessionContinuationCoordinator.prepareInvocationContext({
            threadId,
            catId: singleCatId,
            userId,
            content,
          });
          content = prepared.content;
          consumedContinuation = prepared.consumedContinuation;

          if (prepared.sessionPolicy === 'reborn') {
            log.info(
              { threadId, catId: singleCatId },
              '[QueueProcessor] #836: reborn session — coordinator skipped continuation consume',
            );
            // A legacy/fallback continuation entry already contains stale pre-reborn
            // context. Drop it so reborn starts fresh.
            if (entry.sourceCategory === 'continuation') {
              log.info(
                { threadId, catId: singleCatId, entryId: entry.id },
                '[QueueProcessor] #836: reborn session — dropping stale continuation queue entry',
              );
              if (invocationId) {
                await requireInvocationRecordUpdate({
                  store: invocationRecordStore,
                  invocationId,
                  update: {
                    status: 'succeeded',
                    successfulCatIds: [singleCatId as CatId],
                  },
                  writer: 'queue reborn continuation discard',
                });
              }
              finalStatus = 'succeeded';
              return executionResult('succeeded');
            }
          }

          if (prepared.consumedContinuation) {
            const capsule = prepared.consumedContinuation.capsule;
            const sameQueuedContinuation =
              entry.sourceCategory === 'continuation' &&
              entry.continuationKey === QueueProcessor.continuationKey(capsule);
            if (sameQueuedContinuation) {
              content = originalContent;
            }
            log.info(
              {
                threadId,
                catId: singleCatId,
                capsuleCreatedAt: capsule.createdAt,
                promptAlreadyQueued: sameQueuedContinuation,
              },
              '[QueueProcessor] #813: coordinator prepared pending continuation context for execution',
            );
          }
        } catch (err) {
          log.warn(
            { threadId, catId: singleCatId, err },
            '[QueueProcessor] F224: prepareInvocationContext failed, proceeding without continuation context',
          );
        }
      }

      // 7. Route execution
      const persistenceContext: PersistenceContext = { failed: false, errors: [] };
      const collectedTextParts: string[] = [];
      const bufferedActionMessages: unknown[] = [];
      // #845 fix: per-cat token usage from done events (same pattern as messages.ts / ConnectorInvokeTrigger).
      // Without this, queued/connector invocations succeed without writing usageByCat, leaving 159+ orphans
      // in the daily usage report.
      const collectedUsage = new Map<string, TokenUsage>();
      // F070 parity with messages.ts: governance gate reports terminal retryability via done.errorCode.
      // QueueProcessor must honor that terminal signal instead of falling through to succeeded.
      let governanceErrorCode: string | undefined;

      // F088 fix: Track per-turn content for outbound delivery (same pattern as ConnectorInvokeTrigger)
      const outboundTurns: Array<{
        catId: string;
        textParts: string[];
        richBlocks?: RichBlock[];
      }> = [];
      let currentTurnCatId: string | undefined;

      // F039 remaining: queued image messages must be visible to cats.
      // Aggregate contentBlocks from the stored user messages (messageId + merged).
      const messageIds: string[] = [messageId ?? '', ...(entry.mergedMessageIds ?? []), ...batchedMessageIds].filter(
        Boolean,
      );
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
      if (this.deps.streamingHook && !entry.actionSuccessorFence && !entry.freshnessSupplementId) {
        streamStartPromise = this.deps.streamingHook
          .onStreamStart(threadId, primaryCat, invocationId, entry.senderMeta)
          .catch((err) => {
            log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamStart failed');
          });
      }

      // F151: Mid-loop delivery to preserve ordering (same fix as ConnectorInvokeTrigger)
      const deliveredTurnIndices = new Set<number>();
      const DELIVER_TIMEOUT_MS = this.deps.deliverTimeoutMs ?? 10_000;
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

      const turnCustodyWake = await resolveQueueTurnCustodyWake(entry, messageStore);
      let memoryCueOpportunitySeeds: MemoryCueOpportunitySeed[] = [];
      try {
        memoryCueOpportunitySeeds = await readTrustedConnectorMemoryCueSeeds({
          entrySource: entry.source,
          messageId,
          expectedThreadId: threadId,
          expectedUserId: userId,
          messageStore,
        });
      } catch (err) {
        log.warn({ err, threadId, entryId: entry.id }, '[F287] connector Cue carrier read failed closed');
      }

      // Keep primary-trigger receipt presentation hidden. Exact body exposure
      // is bound later by invokeSingleCat, after its durable child exists and
      // immediately before provider startup.
      if (entry.source !== 'agent') {
        await this.deps.queueCustodyCoordinator?.markPrimaryTrigger(entry);
      }

      for await (const msg of router.routeExecution(
        userId,
        content,
        threadId,
        messageId,
        targetCats,
        { intent, ...(entry.suggestedSkill ? { promptTags: [`skill:${entry.suggestedSkill}`] } : {}) },
        {
          ownerAuthProvenance: entry.ownerAuthProvenance,
          humanDispositionInvocationOrigin: 'queue_replay',
          ...(memoryCueOpportunitySeeds.length > 0 ? { memoryCueOpportunitySeeds } : {}),
          turnCustodyWakeForCat: (catId: string) => retargetTurnCustodyWake(turnCustodyWake, catId),
          ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
          ...(controller.signal ? { signal: controller.signal } : {}),
          // F-parallel-cancel: per-cat signal so canceling one concurrent cat (e.g. @codex)
          // does not abort its siblings (e.g. @gpt52). startAll gives each cat its own per-cat
          // controller; route-parallel resolves them through this getter.
          // NOTE (cloud review clarification): `controller` (line 808) is the INDEPENDENT batch
          // gate returned by startAll — NOT a primary cat controller. A single-cat cancel aborts
          // only that cat's per-cat controller, NOT the batch gate, so the consume-loop
          // `if (controller.signal.aborted) break` (993 / 1090) fires ONLY on whole-invocation
          // abort (cancelAll / force / thread-delete), never on single-cat cancel — the sibling
          // keeps streaming. (See InvocationTracker.startAll returning a fresh batchController.)
          signalForCat: (catId: string) => invocationTracker.getController?.(threadId, catId)?.signal,
          queueHasQueuedMessages: (tid: string) => queue.hasQueuedNonAgentForThread(tid),
          getQueuedFreshnessMessagesForCat: (tid: string, uid: string, catId: string) =>
            queue.getQueuedFreshnessMessagesForCat(tid, uid, catId, { excludeEntryId: entry.id }),
          deferA2AEnqueue: (e: Parameters<NonNullable<RouteOptions['deferA2AEnqueue']>>[0]) =>
            queue.enqueue({ ...e, ownerAuthProvenance: entry.ownerAuthProvenance }),
          // F254 B3: freshness re-invoke enqueue — strips freshnessContext before queueing
          // (queue only stores standard QueueEntry fields; context is for event-log correlation).
          freshnessReinvokeEnqueue: (e: any) => {
            const { freshnessContext: _ctx, ...queueFields } = e;
            return queue.enqueue({ ...queueFields, ownerAuthProvenance: entry.ownerAuthProvenance });
          },
          hasQueuedOrActiveAgentForCat: (tid: string, catId: string) =>
            queue.hasActiveOrQueuedAgentForCat(tid, catId, { excludeEntryId: entry.id }),
          hasPendingForCat: (tid: string, uid: string, catId: string) =>
            queue.hasPendingForCat(tid, catId, { excludeEntryId: entry.id, userId: uid }),
          ...createA2ASlotTrackingBridge(invocationTracker, controller, invocationId),
          cursorBoundaries,
          persistenceContext,
          ...(invocationId ? { parentInvocationId: invocationId } : {}),
          persistedPromptMessageIds: messageIds,
          onPromptMessagesExposed: (input: PromptMessagesExposedInput) => this.markPromptMessagesSeen(input),
          ...(freshnessSupplementOriginalMessageId
            ? { a2aTriggerMessageId: freshnessSupplementOriginalMessageId }
            : entry.a2aTriggerMessageId
              ? { a2aTriggerMessageId: entry.a2aTriggerMessageId }
              : {}),
          ...(entry.callerTraceContext ? { callerTraceContext: entry.callerTraceContext } : {}),
          ...(entry.freshnessClosureId
            ? {
                freshnessClosureId: entry.freshnessClosureId,
                freshnessClosureRequiredMessageIds:
                  (await this.deps.freshnessClosureStore?.get(entry.freshnessClosureId))?.requiredMessageIds ?? [],
              }
            : {}),
          ...(entry.freshnessSupplementId
            ? {
                freshnessSupplementId: entry.freshnessSupplementId,
                freshnessSupplementRequiredMessageIds,
                toolExecutionPolicy: supplementToolExecutionPolicy,
              }
            : {}),
          // F222 P1: Only user-originated queue entries trigger frustration detection.
          // Whitelist (not blacklist) — agent + connector sources both suppressed.
          frustrationAutoIssueEligible: entry.source === 'user',
          // #949 P1-1: Connector-sourced queue entries have no ball-pass expectation.
          // A2A/agent entries still get the verdict-pass handoff guard.
          verdictPassWarningEnabled: entry.source !== 'connector',
          ...(entry.actionSuccessorFence
            ? {
                beforeOutputCommit: async (catId: CatId) => revalidateActionFenceForOutput(catId),
              }
            : {}),
        },
      )) {
        if (controller.signal.aborted) {
          break;
        }
        const awakened = readOrdinaryInvocationCreated(msg);
        if (awakened && messageIds.length > 0) {
          await this.markPromptMessagesAwakened({
            threadId,
            userId,
            catId: awakened.catId,
            invocationId: awakened.invocationId,
            messageIds,
            awakenedAt: awakened.startedAt,
          });
        }
        // #768: Broadcast intent_mode on first CLI event — proves CLI is alive.
        if (!intentModeBroadcast && !entry.actionSuccessorFence) {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', {
            threadId,
            mode: intent,
            targetCats,
            invocationId,
          });
          intentModeBroadcast = true;
        }
        if (hook && msg.catId === primaryCat && msg.type === 'text' && (msg as { content?: string }).content) {
          responseText = accumulateTextAggregate(
            responseText,
            (msg as { content?: string }).content!,
            (msg as { textMode?: 'append' | 'replace' }).textMode,
          );
        }
        const continuationCapsule = extractContinuityCapsuleFromAgentMessage(msg);
        if (continuationCapsule) {
          continuationCapsules.set(continuationCapsule.catId, continuationCapsule);
        }
        terminalDispositions.observe(msg);
        const childInvocationId = (msg as { invocationId?: unknown }).invocationId;
        if (
          (msg.type === 'done' || msg.type === 'error') &&
          msg.catId &&
          typeof childInvocationId === 'string' &&
          childInvocationId.length > 0
        ) {
          observedChildInvocationIdByCatId.set(msg.catId, childInvocationId);
        }
        const terminalConsumption = (msg as { turnCustodyTerminalWitness?: unknown }).turnCustodyTerminalWitness;
        if (
          msg.type === 'done' &&
          typeof childInvocationId === 'string' &&
          childInvocationId.length > 0 &&
          isQueueTerminalConsumptionWitness(terminalConsumption)
        ) {
          terminalConsumptionByInvocationId.set(childInvocationId, terminalConsumption);
        }
        if ((msg.type === 'done' || msg.type === 'error') && msg.catId) {
          invocationTracker.completeSlot?.(threadId, msg.catId, controller);
        }
        const errorCode = (msg as { errorCode?: unknown }).errorCode;

        // #845 fix: accumulate per-cat token usage on done events. Mirrors messages.ts:992-994
        // and ConnectorInvokeTrigger.ts:386-387. Without this, queue-* and connector-* invocations
        // succeed but never write usageByCat, dropping ~159/164 records from the daily report.
        // RouterLike.routeExecution yields an opaque record type, so narrow metadata via local cast.
        if (msg.type === 'done' && msg.catId) {
          const metadata = (msg as { metadata?: { usage?: TokenUsage } }).metadata;
          if (metadata?.usage) {
            collectedUsage.set(msg.catId, mergeTokenUsage(collectedUsage.get(msg.catId), metadata.usage));
          }
        }
        if (msg.type === 'done' && typeof errorCode === 'string') {
          governanceErrorCode = errorCode;
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
          if (this.deps.outboundHook && !entry.actionSuccessorFence) {
            if (threadMetaPromise) {
              threadMeta = await threadMetaPromise;
              threadMetaPromise = undefined;
            }
            for (let i = 0; i < outboundTurns.length; i++) {
              if (deliveredTurnIndices.has(i)) continue;
              const turn = outboundTurns[i];
              if (turn.catId !== msg.catId) continue;
              if (!isConnectorDeliverable(persistenceContext.outputCommitDecisions?.[turn.catId])) continue;
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
          const textMode = (msg as { textMode?: 'append' | 'replace' }).textMode;
          accumulateTextParts(collectedTextParts, textContent, textMode);
          if (msg.catId) {
            if (msg.catId !== currentTurnCatId) {
              outboundTurns.push({ catId: msg.catId, textParts: [] });
              currentTurnCatId = msg.catId;
            }
            const turn = outboundTurns[outboundTurns.length - 1];
            accumulateTextParts(turn.textParts, textContent, textMode);
          }
          if (this.deps.streamingHook && !entry.actionSuccessorFence && !entry.freshnessSupplementId) {
            const accumulated =
              outboundTurns.length > 0 ? flattenTurnTextParts(outboundTurns) : flattenTextParts(collectedTextParts);
            this.deps.streamingHook.onStreamChunk(threadId, accumulated, invocationId).catch((err) => {
              log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamChunk failed');
            });
          }
        }
        if (controller.signal.aborted) {
          break;
        }

        // F194 Phase Z9 (砚砚 R1 P1-2): unified visible turn stamp via helper.
        const msgInvocationId = (msg as { invocationId?: string }).invocationId;
        const visibleMessage = {
          ...msg,
          ...(invocationId ? stampVisibleTurn(invocationId, msgInvocationId) : {}),
        };
        if (entry.actionSuccessorFence) {
          bufferedActionMessages.push(visibleMessage);
        } else if (entry.freshnessSupplementId) {
          bufferedSupplementMessages.push(visibleMessage);
        } else {
          socketManager.broadcastAgentMessage(visibleMessage, threadId);
        }
      }

      // 8. Check abort before marking succeeded (F122B B6 P1: abort→succeeded bug fix)
      // F-parallel-cancel: AGGREGATE finalStatus — batch gate abort (whole invocation) OR every
      // target cat singly cancelled → canceled. A single-cat cancel no longer aborts the batch
      // gate, so raw controller.signal.aborted only covers the whole-invocation case. (completeAll
      // runs later, so cancel tombstones are still visible to resolveFinalStatus here.)
      const batchReason = controller.signal.reason;
      const aggFinalStatus = invocationTracker.resolveFinalStatus
        ? invocationTracker.resolveFinalStatus(threadId, targetCats, {
            aborted: controller.signal.aborted,
            reason: batchReason as string | undefined,
          })
        : controller.signal.aborted
          ? // Fallback (tracker without resolveFinalStatus) must stay equivalent to the old logic:
            // whole-invocation abort → reason decides canceled_by_user vs canceled.
            batchReason === 'user_cancel' || batchReason === 'cancel_all'
            ? 'canceled_by_user'
            : 'canceled'
          : 'succeeded';
      if (aggFinalStatus !== 'succeeded') {
        log.info({ threadId, entryId: entry.id }, '[QueueProcessor] Entry aborted/cancelled during execution');
        // F148 fix: ack cursors for cats that completed before abort (monotonic CAS, safe to call)
        if (cursorBoundaries.size > 0) {
          await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
        }
        await invocationRecordStore.update(invocationId, { status: 'canceled' });
        finalStatus = aggFinalStatus;
        // Suppress auto-resume ONLY for cancelAll (stop everything), NOT single-cat cancel.
        // Single-cat cancel should still auto-resume the next queued entry (backward compat).
        // 'cancel_all' = cancelAll button; 'user_cancel' = single-cat — only cancel_all suppresses.
        if (batchReason === 'cancel_all') {
          const entryCat = entry.targetCats[0] ?? 'unknown';
          this.suppressAutoResume(threadId, entryCat, [invocationId]);
        }
        await this.cleanupStreamingOnFailure(threadId, invocationId, streamStartPromise, log);
        return executionResult(finalStatus);
      }

      if (governanceErrorCode) {
        await invocationRecordStore.update(invocationId, {
          status: 'failed',
          error: governanceErrorCode,
        });
        finalStatus = 'failed';
        await this.cleanupStreamingOnFailure(threadId, invocationId, streamStartPromise, log);
        return executionResult('failed');
      }

      if (entry.actionSuccessorFence) {
        actionFenceAggregateSucceeded = true;
        const successfulCatIds = terminalDispositions.getSuccessfulCatIds();
        const unvalidatedSuccessfulCats = successfulCatIds.filter(
          (catId) => !actionFenceOutputValidatedHolderCatIds.has(catId),
        );
        const outputCommitAllowed =
          !persistenceContext.actionOutputCommitRejected &&
          successfulCatIds.length > 0 &&
          unvalidatedSuccessfulCats.length === 0;
        const carrierFenceRejected =
          persistenceContext.actionOutputCommitRejected || unvalidatedSuccessfulCats.length > 0;
        if (carrierFenceRejected && !actionFencePreflightRejected) {
          actionFencePreflightRejected = true;
          log.error(
            {
              threadId,
              entryId: entry.id,
              leaseId: entry.actionSuccessorFence.leaseId,
              unvalidatedSuccessfulCats,
            },
            '[F167-S.1] route completed without revalidating every action successor holder; suppressing output',
          );
        }
        if (!outputCommitAllowed && !carrierFenceRejected) {
          log.info(
            {
              threadId,
              entryId: entry.id,
              leaseId: entry.actionSuccessorFence.leaseId,
            },
            '[F167-S.1] route completed without a successful action successor holder; suppressing output',
          );
        }
        if (!outputCommitAllowed) {
          await this.cancelMessageIds(
            persistenceContext.persistedOutputMessageIds ?? [],
            log,
            'completion_preflight_rejected',
          );
          await invocationRecordStore.update(invocationId, { status: 'canceled' });
          responseText = '';
          finalStatus = 'canceled';
          return executionResult('canceled');
        }

        if (this.deps.streamingHook) {
          streamStartPromise = this.deps.streamingHook
            .onStreamStart(threadId, primaryCat, invocationId, entry.senderMeta)
            .catch((err) => log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamStart failed'));
          await streamStartPromise;
          const accumulated =
            outboundTurns.length > 0 ? flattenTurnTextParts(outboundTurns) : flattenTextParts(collectedTextParts);
          if (accumulated) {
            await this.deps.streamingHook
              .onStreamChunk(threadId, accumulated, invocationId)
              .catch((err) => log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamChunk failed'));
          }
        }
        if (!intentModeBroadcast) {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', {
            threadId,
            mode: intent,
            targetCats,
            invocationId,
          });
          intentModeBroadcast = true;
        }
        for (const bufferedMessage of bufferedActionMessages) {
          socketManager.broadcastAgentMessage(bufferedMessage, threadId);
        }
      }

      // 9. Ack cursors + mark succeeded
      await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
      const adoptedClosureDecision = entry.freshnessClosureId
        ? persistenceContext.outputCommitDecisions?.[primaryCat]
        : undefined;
      const adoptedClosureStatus =
        adoptedClosureDecision?.kind === 'committed_fresh' &&
        adoptedClosureDecision.closureId === entry.freshnessClosureId
          ? 'committed'
          : adoptedClosureDecision?.kind === 'superseded_positive_stale' &&
              adoptedClosureDecision.closureId === entry.freshnessClosureId
            ? 'pending'
            : adoptedClosureDecision?.kind === 'blocked_known_closure' &&
                adoptedClosureDecision.closureId === entry.freshnessClosureId
              ? 'blocked'
              : undefined;
      let freshnessSupplementStatus: 'committed' | 'declined' | undefined;
      if (entry.freshnessSupplementId && this.deps.freshnessClosureStore) {
        let supplement = await this.deps.freshnessClosureStore.getSupplement(entry.freshnessSupplementId);
        let durableBodyFound = false;
        if (supplement?.status === 'running') {
          const recovered = await this.recoverDurableSupplementCommit(supplement, invocationId);
          supplement = recovered.supplement;
          durableBodyFound = recovered.durableBodyFound;
        }
        if (supplement?.status === 'committed' || supplement?.status === 'declined') {
          freshnessSupplementStatus = supplement.status;
          this.broadcastFreshnessSupplement(supplement);
        } else {
          if (durableBodyFound) {
            for (const bufferedMessage of bufferedSupplementMessages) {
              this.deps.socketManager.broadcastAgentMessage(bufferedMessage, threadId);
            }
          }
          throw new Error(
            `freshness supplement route completed without a terminal decision: ${supplement?.status ?? 'missing'}`,
          );
        }
        for (const bufferedMessage of bufferedSupplementMessages) {
          if (freshnessSupplementStatus === 'committed' || (bufferedMessage as { type?: string }).type !== 'text') {
            socketManager.broadcastAgentMessage(bufferedMessage, threadId);
          }
        }
      }
      await requireInvocationRecordUpdate({
        store: invocationRecordStore,
        invocationId,
        update: {
          status: 'succeeded',
          successfulCatIds: terminalDispositions.getSuccessfulCatIds() as CatId[],
          ...(adoptedClosureStatus ? { freshnessClosureStatus: adoptedClosureStatus } : {}),
          ...(freshnessSupplementStatus
            ? {
                freshnessSupplementId: entry.freshnessSupplementId,
                freshnessSupplementStatus,
              }
            : {}),
          // #845 fix: carry token usage same as messages.ts:1152-1158. Without this, queued/connector
          // succeeded invocations never recorded usageByCat → daily stats undercount.
          ...(collectedUsage.size > 0
            ? {
                usageByCat: Object.fromEntries(collectedUsage),
              }
            : {}),
        },
        writer: 'queue processor',
      });
      this.routeChainTracker.succeed(invocationId);

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

      return executionResult('succeeded');
    } catch (err) {
      executionError = err;
      finalStatus = 'failed';
      if (invocationId) this.routeChainTracker.fail(invocationId);
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
      const exposeFailure = entry.actionSuccessorFence
        ? await finalizeActionFenceOutcome('failed', false, targetCats)
        : true;
      // Best-effort: mark record failed + broadcast error
      try {
        if (invocationId) {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: errMsg,
          });
        }
        if (exposeFailure && !entry.freshnessSupplementId) {
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
        }
      } catch (updateErr) {
        log.warn(
          { threadId, entryId: entry.id, invocationId, err: updateErr },
          '[QueueProcessor] Failed to update invocation record to failed; terminal backstop will retry',
        );
      }

      // R4 fix (#873): correct failure cleanup sequence per messages.ts
      // cleanupStreamingOnFailure — onStreamEnd moves sessions from active →
      // pendingCleanup; cleanupPlaceholders only acts on pendingCleanup, so
      // calling it alone is a no-op when sessions are still active.
      if (!entry.freshnessClosureId && !entry.freshnessSupplementId) {
        await this.cleanupStreamingOnFailure(threadId, invocationId, streamStartPromise, log);
      }

      // R3 P2 fix (#873): Deliver error message to external IM so user sees
      // a reply instead of silence (mirrors ConnectorInvokeTrigger error path).
      // R6 fix: timeout prevents adapter hang from pinning queue slot (Cloud P1).
      if (this.deps.outboundHook && !entry.freshnessClosureId && !entry.freshnessSupplementId && exposeFailure) {
        const ERROR_DELIVER_TIMEOUT_MS = this.deps.deliverTimeoutMs ?? 10_000;
        try {
          await Promise.race([
            this.deps.outboundHook.deliver(
              threadId,
              '抱歉，处理消息时遇到问题，请稍后重试。',
              primaryCat,
              undefined,
              undefined,
              undefined,
              messageId ?? undefined,
            ),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('deliver timeout')), ERROR_DELIVER_TIMEOUT_MS),
            ),
          ]);
        } catch (deliverErr) {
          log.error({ err: deliverErr, threadId }, '[QueueProcessor] Error-path outbound delivery failed');
        }
      }

      return executionResult('failed');
    } finally {
      if (!replayClaimLost && invocationId && typeof invocationRecordStore.get === 'function') {
        try {
          await ensureTerminalStatus(invocationId, {
            invocationRecordStore: invocationRecordStore as unknown as EnsureTerminalDeps['invocationRecordStore'],
            chainCompletion: this.routeChainTracker,
            log,
          });
        } catch (terminalErr) {
          log.warn({ invocationId, err: terminalErr, feature: 'F194' }, '[QueueProcessor] terminal backstop failed');
        }
      }
      if (invocationId) this.routeChainTracker.release(invocationId);

      // Retire only the tracker projection owned by this queue execution. A pre-start
      // reservation can be superseded before this path gets a controller; blind
      // completeAll(..., undefined) would then delete the external replacement.
      if (controller) {
        invocationTracker.completeAll(threadId, targetCats, controller);
      } else if (invocationId) {
        for (const catId of targetCats) {
          invocationTracker.completeByExecutionId?.(threadId, catId, invocationId);
        }
      }
      const retryOrdinaryQueuedWork =
        finalStatus !== 'succeeded' &&
        entry.source !== 'agent' &&
        !entry.actionSuccessorFence &&
        !entry.freshnessClosureId &&
        !entry.freshnessSupplementId;
      if (retryOrdinaryQueuedWork || custodyEntryIds.has(entry.id)) {
        queue.rollbackProcessing(threadId, entry.id);
        if (returnedExecutionResult) returnedExecutionResult.primaryEntryRequeued = true;
        if (custodyEntryIds.has(entry.id)) {
          try {
            await this.persistQueueEntry(queue.getEntrySnapshot(threadId, userId, entry.id));
          } catch (err) {
            log.error(
              { err, threadId, queueEntryId: entry.id },
              '[QueueProcessor] failed to persist Queue custody rollback; startup reconciliation will recover it',
            );
          }
        }
      } else {
        queue.removeProcessedAcrossUsers(threadId, entry.id);
      }
      if (entry.freshnessClosureId && invocationId && this.deps.freshnessClosureStore) {
        try {
          const closure = await this.deps.freshnessClosureStore.get(entry.freshnessClosureId);
          if (closure?.status === 'running' && closure.activeAttempt?.invocationId === invocationId) {
            const reason =
              finalStatus === 'canceled_by_user' || finalStatus === 'canceled'
                ? 'user_cancel'
                : finalStatus === 'failed'
                  ? 'provider_failure'
                  : 'infrastructure';
            const blocked = await this.deps.freshnessClosureStore.blockAttempt(closure.id, {
              invocationId,
              reason,
              evidenceRefs: [`queue-final:${finalStatus}`],
              now: Date.now(),
            });
            this.broadcastFreshnessClosure(blocked);
            recordFreshnessClosureTransition('blocked');
            await invocationRecordStore.update(invocationId, {
              freshnessClosureId: blocked.id,
              freshnessClosureStatus: blocked.status,
            });
            await this.deps.streamingHook?.onClosureBlocked?.(
              threadId,
              primaryCat as CatId,
              blocked.blockedReason ?? reason,
              invocationId,
            );
          }
        } catch (err) {
          log.error(
            { err, threadId, entryId: entry.id, closureId: entry.freshnessClosureId },
            '[F254-E] failed to close unfinished queue attempt',
          );
        }
      }
      if (entry.freshnessSupplementId && this.deps.freshnessClosureStore) {
        try {
          let supplement = await this.deps.freshnessClosureStore.getSupplement(entry.freshnessSupplementId);
          let durableBodyFound = false;
          if (supplement?.status === 'running') {
            const recovered = await this.recoverDurableSupplementCommit(supplement, invocationId);
            supplement = recovered.supplement;
            durableBodyFound = recovered.durableBodyFound;
            if (supplement?.status === 'committed') this.broadcastFreshnessSupplement(supplement);
          }
          if (supplement?.status === 'running' || (supplement?.status === 'pending' && finalStatus !== 'succeeded')) {
            if (!durableBodyFound) {
              const failed = await this.deps.freshnessClosureStore.failSupplement(supplement.id, {
                ...(supplement.status === 'running' && invocationId ? { invocationId } : {}),
                reason: supplementFailureReason(executionError, finalStatus),
                now: Date.now(),
              });
              this.broadcastFreshnessSupplement(failed);
              if (invocationId) {
                await invocationRecordStore.update(invocationId, {
                  freshnessSupplementId: failed.id,
                  freshnessSupplementStatus: failed.status,
                  freshnessSupplementFailureReason: failed.failureReason,
                });
              }
            }
          }
        } catch (err) {
          log.error(
            { err, threadId, entryId: entry.id, supplementId: entry.freshnessSupplementId },
            '[F254] failed to close unfinished supplement attempt',
          );
        }
      }
      // F175: on success remove batched entries; on failure/cancel rollback so they can retry
      if (finalStatus === 'succeeded') {
        for (const bid of batchedEntryIds) {
          if (custodyEntryIds.has(bid)) {
            queue.rollbackProcessing(threadId, bid);
            try {
              await this.persistQueueEntry(queue.getEntrySnapshot(threadId, userId, bid));
            } catch (err) {
              log.error(
                { err, threadId, queueEntryId: bid },
                '[QueueProcessor] failed to persist batched Queue custody rollback; startup reconciliation will recover it',
              );
            }
          } else {
            queue.removeProcessedAcrossUsers(threadId, bid);
          }
        }
        // #815 + Cloud Codex P2: now that the batch succeeded, actually consume
        // the subsumed A2A entries that were deferred earlier.
        if (deferredA2AConsume.size > 0) {
          const consumedA2A = queue.consumeEntriesById(deferredA2AConsume);
          for (const c of consumedA2A) {
            this.entryCompleteHooks.delete(c.id);
          }
          log.info(
            { threadId, consumedCount: consumedA2A.length },
            '[QueueProcessor] #815: consumed deferred A2A entries after successful batch',
          );
          await emitQueueUpdated(
            socketManager,
            userId,
            threadId,
            queue.list(threadId, userId),
            messageStore,
            'a2a_subsumed',
          );
        }
      } else {
        for (const bid of batchedEntryIds) {
          queue.rollbackProcessing(threadId, bid);
          if (custodyEntryIds.has(bid)) {
            try {
              await this.persistQueueEntry(queue.getEntrySnapshot(threadId, userId, bid));
            } catch (err) {
              log.error(
                { err, threadId, queueEntryId: bid },
                '[QueueProcessor] failed to persist failed batched Queue custody rollback',
              );
            }
          }
        }
        // Cloud Codex P2: deferred A2A entries stay in queue on failure — no rollback needed.
      }
      const producedCapsules = [...continuationCapsules.values()];
      for (const continuationCapsule of producedCapsules) {
        if (finalStatus === 'canceled_by_user') {
          log.info(
            { threadId, catId: continuationCapsule.catId },
            '[QueueProcessor] F224: user-canceled invocation — storing continuation without auto-enqueue',
          );
          continue;
        }
        if (!(await this.shouldEnqueueContinuation(continuationCapsule, userId))) {
          log.info(
            { threadId, catId: continuationCapsule.catId },
            '[QueueProcessor] #836: reborn session — skipping continuation enqueue',
          );
          continue;
        }
        const result = await this.enqueueContinuation({
          threadId,
          userId,
          ownerAuthProvenance: entry.ownerAuthProvenance,
          catId: continuationCapsule.catId,
          capsule: continuationCapsule,
        });
      }
      if (this.sessionContinuationCoordinator) {
        try {
          await this.sessionContinuationCoordinator.commitInvocationOutcome({
            finalStatus,
            threadId,
            catId: primaryCat,
            userId,
            consumedContinuation,
            producedCapsules,
          });
        } catch (err) {
          log.warn({ threadId, targetCats, err }, '[QueueProcessor] F224: commitInvocationOutcome failed');
        }
      }
      await emitQueueUpdated(socketManager, userId, threadId, queue.list(threadId, userId), messageStore, 'completed');
      let completionHookStatus = finalStatus;
      let completionHookResponse = responseText;
      if (entry.actionSuccessorFence && !actionFencePreflightRejected && !replayClaimLost) {
        if (actionFenceAggregateSucceeded) {
          const successfulHolderCatIds = new Set(terminalDispositions.getSuccessfulCatIds());
          const nonSuccessfulHolderCatIds = targetCats.filter((catId) => !successfulHolderCatIds.has(catId));
          const canceledHolderCatIds = nonSuccessfulHolderCatIds.filter(
            (catId) => invocationTracker.getSlotState?.(threadId, catId) === 'canceled',
          );
          const canceledHolderCatIdSet = new Set(canceledHolderCatIds);
          const failedHolderCatIds = nonSuccessfulHolderCatIds.filter((catId) => !canceledHolderCatIdSet.has(catId));
          if (canceledHolderCatIds.length > 0) {
            await finalizeActionFenceOutcome('canceled', false, canceledHolderCatIds);
          }
          if (failedHolderCatIds.length > 0) {
            await finalizeActionFenceOutcome('failed', false, failedHolderCatIds);
          }
        } else {
          const uncommittedTargetCats = targetCats.filter((catId) => !actionFenceCommittedHolderCatIds.has(catId));
          const holderOutcome = finalStatus === 'failed' ? 'failed' : 'canceled';
          if (uncommittedTargetCats.length > 0) {
            await finalizeActionFenceOutcome(holderOutcome, Boolean(responseText), uncommittedTargetCats);
          }
        }
      }
      if (entry.actionSuccessorFence && actionFencePreflightRejected) {
        completionHookStatus = 'canceled';
        completionHookResponse = '';
      }
      // F122B B6: Fire completion hook (one-shot) and clean up
      const completeHook = this.entryCompleteHooks.get(entry.id);
      if (completeHook) {
        this.entryCompleteHooks.delete(entry.id);
        if (!replayClaimLost) {
          try {
            completeHook(entry.id, completionHookStatus, completionHookResponse);
          } catch {
            /* best-effort: hook errors must not break queue chain */
          }
        }
      }
      // Chain auto-dequeue is handled by tryExecuteNext* (calls onInvocationComplete
      // AFTER releasing processingThreads mutex to avoid self-blocking).
    }
  }

  private async cleanupStreamingOnFailure(
    threadId: string,
    invocationId: string | undefined,
    streamStartPromise: Promise<void> | undefined,
    log: LoggerLike,
  ): Promise<void> {
    if (!this.deps.streamingHook || !invocationId) return;
    try {
      const STREAM_START_TIMEOUT_MS = 5000;
      if (streamStartPromise) {
        await Promise.race([streamStartPromise, new Promise<void>((r) => setTimeout(r, STREAM_START_TIMEOUT_MS))]);
      }
      await this.deps.streamingHook.onStreamEnd(threadId, '', invocationId);
      await this.deps.streamingHook.cleanupPlaceholders?.(threadId, invocationId);
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr, threadId }, '[QueueProcessor] Error-path streaming cleanup failed');
    }
  }

  private async shouldEnqueueContinuation(capsule: CollaborationContinuityCapsuleV1, userId: string): Promise<boolean> {
    if (!this.sessionContinuationCoordinator?.resolveSessionStrategy) return true;
    try {
      return (
        (await this.sessionContinuationCoordinator.resolveSessionStrategy(capsule.threadId, capsule.catId, userId)) !==
        'reborn'
      );
    } catch (err) {
      this.deps.log.warn(
        { threadId: capsule.threadId, catId: capsule.catId, err },
        '[QueueProcessor] F224: resolveSessionStrategy failed for continuation enqueue, defaulting to enqueue',
      );
      return true;
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
      richBlocks?: RichBlock[];
    }>,
    persistenceContext: PersistenceContext,
    streamStartPromise: Promise<void> | undefined,
    log: LoggerLike,
    triggerMessageId?: string,
    deliveredTurnIndices?: Set<number>,
    preResolvedMeta?: ThreadMetaLike | undefined,
  ): Promise<void> {
    const deliverableTurnEntries = outboundTurns.flatMap((turn, originalIndex) =>
      isConnectorDeliverable(persistenceContext.outputCommitDecisions?.[turn.catId]) ? [{ turn, originalIndex }] : [],
    );
    const finalContent =
      outboundTurns.length > 0
        ? flattenTurnTextParts(deliverableTurnEntries.map(({ turn }) => turn))
        : isConnectorDeliverable(persistenceContext.outputCommitDecisions?.[primaryCat])
          ? flattenTextParts(collectedTextParts)
          : '';
    const outputDecisionEntries = Object.entries(persistenceContext.outputCommitDecisions ?? {});
    const supersededOutput = outputDecisionEntries.find(
      (entry): entry is [string, Extract<OutputCommitDecision, { kind: 'superseded_positive_stale' }>] =>
        entry[1].kind === 'superseded_positive_stale',
    );
    const blockedOutput = outputDecisionEntries.find(
      (entry): entry is [string, Extract<OutputCommitDecision, { kind: 'blocked_known_closure' }>] =>
        entry[1].kind === 'blocked_known_closure',
    );
    const hasKnownUndeliverableOutput = outputDecisionEntries.some(([, decision]) => !isConnectorDeliverable(decision));

    // Finalize streaming — ensure start completed before ending
    if (this.deps.streamingHook) {
      if (streamStartPromise) {
        const STREAM_START_TIMEOUT_MS = 5000;
        await Promise.race([
          streamStartPromise,
          new Promise<void>((resolve) => setTimeout(resolve, STREAM_START_TIMEOUT_MS)),
        ]);
      }
      if (blockedOutput && this.deps.streamingHook.onClosureBlocked) {
        await this.deps.streamingHook
          .onClosureBlocked(threadId, blockedOutput[0] as CatId, blockedOutput[1].reason, invocationId)
          .catch((err) => log.warn({ err, threadId }, '[QueueProcessor] blocked connector projection failed'));
      } else if (supersededOutput && this.deps.streamingHook.onClosureCatchingUp) {
        await this.deps.streamingHook
          .onClosureCatchingUp(threadId, supersededOutput[0] as CatId, invocationId)
          .catch((err) => log.warn({ err, threadId }, '[QueueProcessor] catch connector projection failed'));
      } else {
        await this.deps.streamingHook.onStreamEnd(threadId, finalContent, invocationId).catch((err) => {
          log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamEnd failed');
        });
      }
    }

    const hasContent =
      finalContent.length > 0 || deliverableTurnEntries.some(({ turn }) => (turn.richBlocks?.length ?? 0) > 0);
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

      const DELIVER_TIMEOUT_MS = this.deps.deliverTimeoutMs ?? 10_000;
      // F151: skip turns already delivered mid-loop
      const nonEmptyTurns = deliverableTurnEntries
        .filter(
          ({ turn, originalIndex }) =>
            !(deliveredTurnIndices && deliveredTurnIndices.has(originalIndex)) &&
            (turn.textParts.length > 0 || (turn.richBlocks && turn.richBlocks.length > 0)),
        )
        .map(({ turn }) => turn);

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
              log.warn({ err, threadId }, '[QueueProcessor] Placeholder cleanup failed after late-success delivery');
            });
          }
        });
      }
    } else if (!hasKnownUndeliverableOutput) {
      // R6+R7 fix: deliver fallback FIRST (with timeout), then cleanup placeholder
      // only on success — preserves "thinking" card if delivery fails (Cloud P2).
      // Timeout prevents adapter hang from pinning queue slot (Cloud P1).
      // R7: late-success cleanup mirrors normal content-delivery pattern (lines 1783-1798).
      const SILENT_DELIVER_TIMEOUT_MS = this.deps.deliverTimeoutMs ?? 10_000;
      let silentDeliveryOk = !this.deps.outboundHook;
      let silentDeliverPromise: Promise<void> | undefined;
      if (this.deps.outboundHook) {
        silentDeliverPromise = this.deps.outboundHook.deliver(
          threadId,
          '处理完成，但未产生回复内容。',
          primaryCat,
          undefined,
          preResolvedMeta,
          undefined,
          triggerMessageId,
        );
        try {
          await Promise.race([
            silentDeliverPromise,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('deliver timeout')), SILENT_DELIVER_TIMEOUT_MS),
            ),
          ]);
          silentDeliveryOk = true;
        } catch (deliverErr) {
          log.error({ err: deliverErr, threadId }, '[QueueProcessor] Silent-path outbound delivery failed');
        }
      }
      if (silentDeliveryOk && this.deps.streamingHook?.cleanupPlaceholders) {
        await this.deps.streamingHook.cleanupPlaceholders(threadId, invocationId).catch((err) => {
          log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.cleanupPlaceholders failed (silent)');
        });
      } else if (silentDeliverPromise && this.deps.streamingHook?.cleanupPlaceholders) {
        // R7: timeout fired but delivery may still succeed — defer cleanup to late-success
        const cleanupFn = this.deps.streamingHook.cleanupPlaceholders.bind(this.deps.streamingHook);
        silentDeliverPromise
          .then(() => {
            cleanupFn(threadId, invocationId).catch((err: unknown) => {
              log.warn({ err, threadId }, '[QueueProcessor] Silent late-success placeholder cleanup failed');
            });
          })
          .catch(() => {
            /* delivery truly failed — thinking card stays as fallback UX */
          });
      }
    }
  }

  /** Prepare presentation data before the final exact-owner commit fence. */
  private async preparePausedQueueNotifications(threadId: string): Promise<PausedQueueNotification[]> {
    const notifications: PausedQueueNotification[] = [];
    const users = this.deps.queue.listUsersForThread(threadId);
    for (const userId of users) {
      const userQueue = this.deps.queue.list(threadId, userId);
      if (!userQueue.some((e) => e.status === 'queued')) continue;
      const enriched = await enrichQueueEntries(userQueue, this.deps.messageStore);
      notifications.push({ userId, queue: enriched });
    }
    return notifications;
  }

  /** Commit queue_paused synchronously after the exact-owner fence. */
  private emitPreparedPausedNotifications(
    threadId: string,
    reason: 'canceled' | 'failed',
    notifications: readonly PausedQueueNotification[],
  ): void {
    for (const { userId, queue } of notifications) {
      this.deps.socketManager.emitToUser(userId, 'queue_paused', {
        threadId,
        reason,
        queue,
      });
    }
  }
}
