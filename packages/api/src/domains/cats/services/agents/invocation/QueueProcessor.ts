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
  LifecycleActiveRun,
  MessageContent,
  MessageFrom,
  OutputCommitDecision,
  QueueTargetOutcome,
  RichBlock,
  WaitContinuationCarrierV1,
} from '@cat-cafe/shared';
import {
  leaseSucceededSubjectNonterminalTotal,
  successorResponsesAfterTerminalState,
  unresolvedSubjectWithoutActiveCustodyTotal,
} from '../../../../../infrastructure/telemetry/instruments.js';
import {
  commitCompletedResponseAndEnqueueA2ATargets,
  commitFailedResponseAndEnqueueA2ACaller,
} from '../../../../../routes/callback-a2a-trigger.js';
import { emitQueueUpdated, isPublicQueueEntry } from '../../../../../utils/queue-enrichment.js';
import type { ActionSuccessorLeaseStore } from '../../../../ball-custody/ActionSuccessorLeaseStore.js';
import {
  resolveQueueTurnCustodyWake,
  retargetTurnCustodyWake,
} from '../../../../ball-custody/turn-custody-wake-provenance.js';
import { waitContinuationCarriersMatch } from '../../../../ball-custody/wait-continuation-carrier.js';
import type { MemoryCueOpportunitySeed } from '../../../../memory/cue/MemoryCueInvocationPromptService.js';
import { readTrustedConnectorMemoryCueSeeds } from '../../../../memory/cue/MemoryCueTrustedConnector.js';
import {
  bindAsrPersonMemoryPresentationRetryFromSchedulerMessage,
  bindAsrPersonMemoryReentryFromSchedulerMessage,
} from '../../../../memory/people/AsrPersonMemoryReentryCarrier.js';
import { bindAsrPersonMemoryScenesFromQueueMessage } from '../../../../signal-intake/AsrPersonMemoryQueueCarrier.js';
import {
  MessageBundlePromptUnavailableError,
  resolveMessageBundlePrompt,
} from '../../context/MessageBundlePromptResolver.js';
import { scanFreshnessClosurePreflight } from '../../freshness/closure/FreshnessClosurePreflight.js';
import type { FreshnessClosureStore } from '../../freshness/closure/FreshnessClosureStore.js';
import {
  recordFreshnessClosureStage,
  recordFreshnessClosureTransition,
  recordFreshnessSuccessorPreflightCanceled,
} from '../../freshness/closure/freshness-closure-telemetry.js';
import type { FreshnessAttentionEventLog } from '../../freshness/FreshnessAttentionEventLog.js';
import { scanFreshnessSupplementPreflight } from '../../freshness/FreshnessSupplementPreflight.js';
import { recordQueuedHandledTelemetry, recordQueuedSeenTelemetry } from '../../freshness/freshness-queue-telemetry.js';
import {
  freshnessClosureFinalIdempotencyKey,
  projectFreshnessClosure,
  projectFreshnessSupplement,
  SUPPLEMENT_DECLINE_MARKER,
} from '../../freshness/glass-box/FreshnessOutputCommitCoordinator.js';
import { shouldMarkDecisionNotification } from '../../push/decision-notification-policy.js';
import type { PushPayload } from '../../push/PushNotificationService.js';
import { messageFrom } from '../../stores/message-from.js';
import type { DeliveryCursorStore } from '../../stores/ports/DeliveryCursorStore.js';
import type {
  InvocationActionLeaseCarrier,
  InvocationRecord,
  InvocationStatus,
} from '../../stores/ports/InvocationRecordStore.js';
import { classifyInvocationRecoveryStatus } from '../../stores/ports/invocation-state-machine.js';
import {
  hydrateReplyPreview,
  type IMessageStore,
  isTimelinePublished,
  lifecycleInputIdentityForStoredMessage,
  type StoredMessage,
} from '../../stores/ports/MessageStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import {
  type AgentClientActiveRunDispatcher,
  type AgentMessage,
  mergeTokenUsage,
  type TokenUsage,
} from '../../types.js';
import { extractImagePaths } from '../providers/image-paths.js';
import { userFacingSystemInfoNoticeContent } from '../routing/persist-system-info-warnings.js';
import {
  type PersistedPromptMessage,
  type PersistenceContext,
  type RouteExecutionOptions,
  type RouteOptions,
} from '../routing/route-helpers.js';
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
import type { StaleProcessingOwnerLease } from './InvocationOwnerLeaseCandidates.js';
import {
  actionSuccessorInvocationIdempotencyKey,
  type InvocationQueue,
  isOrdinaryQueueTargetEligible,
  type QueueEntry,
  queueEntryCallerCatId,
  queueEntryMessageIds,
  queueEntryOwnerId,
  queueEntrySenderMeta,
  queueEntrySource,
  queueEntryTargetCats,
} from './InvocationQueue.js';
import {
  DEFAULT_PRESTART_RESERVATION_TTL_MS,
  type ExactExecutionOwnerState,
  type ExecutionAdmissionGuard,
  type ExecutionOwnerMatch,
} from './InvocationTracker.js';
import { projectLifecycleAppendAction } from './lifecycle-append-projection.js';
import { requireOwnerAuthProvenance } from './owner-auth-provenance.js';
import {
  isTerminalDispositionEvent,
  PerCatTerminalDispositionCollector,
} from './PerCatTerminalDispositionCollector.js';
import {
  type ContinuationOutcome,
  classifyContinuationOutcome,
  describeContinuationOutcome,
} from './queue-liveness-diagnostics.js';
import {
  commitPreparedPrestartRetirements,
  type PreparedPrestartRetirement,
  type PrestartRetirementReservation,
  preparePrestartRetirements,
  terminalizePreparedPrestartRetirements,
} from './queue-prestart-group-retirement.js';
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
  startAll(threadId: string, catIds: string[], userId?: string, executionId?: string): AbortController | null;
  acquireExecutionAdmission(threadId: string, catIds: readonly string[]): Promise<ExecutionAdmissionGuard | null>;
  waitForSessionSealRelease(threadId: string, catIds: readonly string[]): Promise<void>;
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
  cancelInvocation(threadId: string, catIds: string[], userId?: string, reason?: string): unknown;
  getUserId?(threadId: string, catId: string): string | null;
  getExecutionId?(threadId: string, catId: string): string | undefined;
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
  releaseTerminalByExecutionId(threadId: string, catId: string, executionId: string): ExactExecutionOwnerState;
  bindLifecycleActiveRun?(run: LifecycleActiveRun, expectedExecutionId?: string): boolean;
  bindAgentClientActiveRunDispatcher?(
    threadId: string,
    catId: string,
    dispatcher: AgentClientActiveRunDispatcher,
    expectedExecutionId?: string,
  ): (() => void) | null;
  getAgentClientActiveRunDispatcher?(threadId: string, catId: string): AgentClientActiveRunDispatcher | undefined;
  getActiveSlots?(threadId: string): Array<{ catId: string; startedAt: number; activeRun?: LifecycleActiveRun }>;
  appendLifecycleActiveRunInputs?(
    threadId: string,
    catId: string,
    expected: { invocationId: string; responseMessageId: string },
    entryId: string,
    messageIds: readonly string[],
  ): boolean;
  adoptLifecycleActiveRunInputs?(
    threadId: string,
    catId: string,
    expected: { invocationId: string; responseMessageId: string },
    entryId: string,
    messageIds: readonly string[],
  ): boolean;
  detachLifecycleActiveRunInputs?(
    threadId: string,
    catId: string,
    expected: { invocationId: string; responseMessageId: string },
    entryId: string,
    messageIds: readonly string[],
  ): boolean;
}

interface QueueExecutionResult {
  status: InvocationFinalStatus;
  invocationId?: string;
  /** Queue rows actually reserved into this attempt, including F175 batch siblings. */
  attemptedQueueEntryIds: string[];
  /** Exact primary settlement failed, so automatic draining must stop for recovery. */
  primarySettlementIncomplete?: boolean;
}

type ProcessingSlotReservation = PrestartRetirementReservation;

export type PrestartRetirementOutcome = 'retired' | 'state_changed' | 'terminalization_failed';

export interface ThreadPrestartRetirementResult {
  outcome: 'none' | PrestartRetirementOutcome;
  retiredCatIds: string[];
}

interface MarkDeliveredAndEmitResult {
  transitionedIds: string[];
  failedIds: string[];
}

export type AdoptExposedQueuedEntriesResult =
  | { outcome: 'adopted'; adoptedEntryIds: string[] }
  | {
      outcome: 'rejected';
      reason: 'active_run_missing' | 'state_changed' | 'lifecycle_conflict' | 'persistence_unavailable';
      entryId?: string;
    };

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

function readOrdinaryInvocationCreated(
  message: unknown,
): { catId: string; invocationId: string; startedAt: number; activeRun?: LifecycleActiveRun } | null {
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
    ...(candidate.activeRun &&
    candidate.activeRun.threadId &&
    candidate.activeRun.targetId === candidate.catId &&
    candidate.activeRun.invocationId === candidate.turnInvocationId
      ? { activeRun: candidate.activeRun }
      : {}),
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
    waitContinuationCarrier?: WaitContinuationCarrierV1;
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
    sameActionLeaseCarrier(record.actionLeaseCarrier, expected.actionLeaseCarrier) &&
    waitContinuationCarriersMatch(record.waitContinuationCarrier, expected.waitContinuationCarrier)
  );
}

export interface RouterLike {
  resolveExplicitTargets(requestedCatIds: readonly string[], threadId: string): Promise<string[]>;
  resolveConversationTargetsAtAdmission(requestedCatIds: readonly string[], threadId: string): Promise<string[]>;
  routeExecution(
    userId: string,
    content: string,
    threadId: string,
    messageId: string | null,
    targetCats: string[],
    intent: { intent: string },
    opts: RouteExecutionOptions,
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

interface PushNotificationServiceLike {
  notifyUser(userId: string, payload: PushPayload): Promise<unknown>;
}

/** #813: Minimal thread store interface for passive continuation. */
export interface ThreadStoreLike {
  get?(threadId: string): ReturnType<IThreadStore['get']>;
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
  log: LoggerLike;
  /** User-facing completion/error notifications for canonical queued web ingress. */
  getPushService?: () => PushNotificationServiceLike | null;
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
  /** F254: audit stream for exact queued-body adoption and other freshness lifecycle events. */
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
  deliveryCursorStore?: Pick<DeliveryCursorStore, 'ackSeenCursor' | 'ackMentionCursor'>;
}

/** F122B B6: Completion hook — called when a queue entry finishes execution. */
export type EntryCompleteHook = (
  entryId: string,
  status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
  responseText: string,
) => void;

interface RegisteredEntryCompleteHook {
  readonly hook: EntryCompleteHook;
  readonly targetCatId?: string;
}

export type ContinuationEnqueueOutcome =
  | 'enqueued'
  | 'skipped_missing_capsule'
  | 'skipped_invalid_capsule'
  | 'skipped_existing_entry'
  | 'skipped_rate_limited'
  | 'queue_full';

export type AppendExactEntryResult =
  | { outcome: 'appended'; entry: QueueEntry; acceptedTargetIds: string[] }
  | {
      outcome: 'rejected';
      reason:
        | 'append_unavailable'
        | 'state_changed'
        | 'custody_unavailable'
        | 'lifecycle_conflict'
        | 'provider_rejected';
      rejectedTargetIds?: string[];
    };

interface AutoResumeSuppression {
  setAt: number;
  executionIds: Set<string>;
  hasAnonymousFence: boolean;
}

interface ThreadDrainState {
  dirty: boolean;
  owner?: Promise<void>;
  /**
   * A newer, unrelated cancellation may finish while an older cancel-all
   * identity is still waiting for its exact terminal. That old fence must stay
   * consumable, but it must not strand work released by the newer invocation.
   */
  bypassSuppressionForCatIds?: Set<string>;
}

interface ConversationBatchResolution {
  readonly routingClass: 'explicit' | 'targetless';
  readonly requestedTargets: readonly string[];
  readonly resolvedTargets: readonly string[];
}

interface QueueAdmissionAttempt {
  readonly started: boolean;
  readonly progressed?: boolean;
  readonly entry?: QueueEntry;
}

export class QueueProcessor {
  private deps: QueueProcessorDeps;
  /** F108: Per-slot mutex — prevents concurrent double-start per (thread, cat) pair.
   *  F118 D4: startedAt supports bounded zombie detection.
   *  F194: the reservation object is the exact pre-start owner; invocationId is
   *  bound immediately after durable record creation. */
  private processingSlots = new Map<string, ProcessingSlotReservation>();
  /** Suppress automatic admission per slot while cancelAll/force-reset settles.
   *  Observers use the slot fence; only a canceled execution named by the owning
   *  cancel action may consume it. TTL bounds lock-only/missing-terminal cases. */
  private suppressedAutoResume = new Map<string, AutoResumeSuppression>();
  /** RFC #1356: one event-driven drain owner plus a no-lost-wakeup dirty bit per thread. */
  private readonly threadDrains = new Map<string, ThreadDrainState>();
  /**
   * RFC #1356 admission handoff. Queue owns only pre-admission work; once the
   * provider is admitted, this process-local registry keeps the immutable
   * execution snapshot needed to persist exact child/body witnesses. The
   * durable Queue ledger remains the crash-recovery truth.
   */
  private static readonly SUPPRESS_TTL_MS = 60_000;
  /** F122B B6: Per-entry completion hooks (for multi-mention response aggregation). */
  private entryCompleteHooks = new Map<string, RegisteredEntryCompleteHook[]>();
  /** F118: age threshold for explicit owner-reaper candidacy (default 75min). */
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

  /**
   * Establish the existing supplement lifecycle as the exact terminal owner
   * before Queue Gate 2 settles its transient carrier row.
   */
  private async terminalizeFreshnessSupplementCarrier(
    entry: QueueEntry,
    invocationId: string | undefined,
    finalStatus: InvocationFinalStatus,
    executionError: unknown,
  ): Promise<void> {
    const supplementId = entry.execution.freshnessSupplementId;
    const store = this.deps.freshnessClosureStore;
    if (!supplementId || !store) return;

    try {
      let supplement = await store.getSupplement(supplementId);
      let durableBodyFound = false;
      if (supplement?.status === 'running') {
        const recovered = await this.recoverDurableSupplementCommit(supplement, invocationId);
        supplement = recovered.supplement;
        durableBodyFound = recovered.durableBodyFound;
        if (supplement?.status === 'committed') {
          this.broadcastFreshnessSupplement(supplement);
        }
      }
      if (supplement?.status === 'running' || (supplement?.status === 'pending' && finalStatus !== 'succeeded')) {
        if (!durableBodyFound) {
          const failed = await store.failSupplement(supplement.id, {
            ...(supplement.status === 'running' && invocationId ? { invocationId } : {}),
            reason: supplementFailureReason(executionError, finalStatus),
            now: Date.now(),
          });
          supplement = failed;
          this.broadcastFreshnessSupplement(failed);
          if (invocationId) {
            await this.deps.invocationRecordStore.update(invocationId, {
              freshnessSupplementId: failed.id,
              freshnessSupplementStatus: failed.status,
              freshnessSupplementFailureReason: failed.failureReason,
            });
          }
        }
      }
    } catch (err) {
      this.deps.log.error(
        { err, threadId: entry.threadId, entryId: entry.id, supplementId },
        '[F254] failed to close unfinished supplement attempt',
      );
    }
  }

  constructor(deps: QueueProcessorDeps, opts?: { processingSlotTtlMs?: number }) {
    this.deps = deps;
    this.processingSlotTtlMs = opts?.processingSlotTtlMs ?? DEFAULT_PRESTART_RESERVATION_TTL_MS;
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
  registerEntryCompleteHook(entryId: string, hook: EntryCompleteHook, targetCatId?: string): void {
    const hooks = this.entryCompleteHooks.get(entryId) ?? [];
    hooks.push({ hook, ...(targetCatId ? { targetCatId } : {}) });
    this.entryCompleteHooks.set(entryId, hooks);
  }

  /** F122B B6: Remove a completion hook (e.g. on abort before execution). */
  unregisterEntryCompleteHook(entryId: string): void {
    this.entryCompleteHooks.delete(entryId);
  }

  private async compensateLifecycleAppendTargets(input: {
    entry: QueueEntry;
    inputMessageIds: readonly string[];
    sourceMessages: readonly StoredMessage[];
    runs: readonly { targetId: string; invocationId: string; responseMessageId: string }[];
    failedTargetIds: readonly string[];
    failedAtLowerBound: number;
  }): Promise<void> {
    const { invocationTracker, messageStore } = this.deps;
    for (const targetId of input.failedTargetIds) {
      const run = input.runs.find((candidate) => candidate.targetId === targetId);
      if (!run) throw new Error(`lifecycle Append compensation target is not fenced: ${targetId}`);
      const failedAt = Math.max(Date.now(), input.failedAtLowerBound);
      const failureMessages: StoredMessage[] = [];
      for (const sourceMessage of input.sourceMessages) {
        failureMessages.push(
          await messageStore.append({
            from: { kind: 'system', service: 'message-delivery' },
            userId: sourceMessage.userId,
            threadId: input.entry.threadId,
            content: `${targetId} 的当前 Agent Client 已关闭，消息未追加到该回合。`,
            mentions: [],
            timestamp: failedAt,
            idempotencyKey: `lifecycle-append-rejection:${input.entry.id}:${targetId}:${sourceMessage.id}`,
            lifecycle: {
              kind: 'delivery_failure',
              orderKey: `${failedAt}:append-rejection:${input.entry.id}:${targetId}:${sourceMessage.id}`,
              status: 'failed',
              sourceEntryId: input.entry.id,
              inputMessageId: sourceMessage.id,
              requestedTargets: [targetId],
              reason: 'control_carrier_replaced',
              createdAt: failedAt,
            },
          }),
        );
      }
      const compensation = await messageStore.commitLifecycleAppendRejection({
        threadId: input.entry.threadId,
        entryId: input.entry.id,
        inputMessageIds: input.inputMessageIds,
        failureMessageIds: failureMessages.map((message) => message.id),
        run,
      });
      if (compensation.kind !== 'applied' && compensation.kind !== 'replayed') {
        throw new Error(
          `lifecycle Append rejection compensation ${compensation.kind}:${'reason' in compensation ? compensation.reason : ''}`,
        );
      }
      if (
        !invocationTracker.detachLifecycleActiveRunInputs?.(
          input.entry.threadId,
          targetId,
          run,
          input.entry.id,
          input.inputMessageIds,
        )
      ) {
        this.deps.log.warn(
          { threadId: input.entry.threadId, targetId, invocationId: run.invocationId },
          '[QueueProcessor] compensated rejected Append after its live Active Run had already closed',
        );
      }
      for (const message of [...compensation.messages, ...failureMessages]) {
        this.emitLifecycleMessageUpdated(queueEntryOwnerId(input.entry), message);
      }
    }
  }

  /**
   * Admission-owned automatic Queue -> Active Run transfer. Human work must
   * still be bound to the same parent selected by its continue-current intent;
   * agent A2A carriers have no human disposition and are eligible by default.
   * The exact run/capability/revision fences remain owned by the shared
   * lifecycle projection and append transaction below.
   */
  async tryAutoAppendExactEntry(input: {
    threadId: string;
    userId: string;
    entryId: string;
  }): Promise<AppendExactEntryResult> {
    const { queue, invocationTracker } = this.deps;
    const entry = queue.getEntrySnapshot(input.threadId, input.userId, input.entryId);
    if (!entry || (entry.from.kind !== 'user' && entry.from.kind !== 'agent')) {
      return { outcome: 'rejected', reason: 'append_unavailable' };
    }
    if (entry.from.kind === 'user') {
      if (!invocationTracker.getExecutionId) {
        return { outcome: 'rejected', reason: 'append_unavailable' };
      }
      const remainsBoundToRequestedParent = queueEntryTargetCats(entry).every((targetId) => {
        const intent = entry.delivery.authorIntentByTarget?.[targetId];
        return (
          intent?.requested === 'continue_current' &&
          intent.fallbackAt === undefined &&
          typeof intent.boundParentInvocationId === 'string' &&
          invocationTracker.getExecutionId?.(input.threadId, targetId) === intent.boundParentInvocationId
        );
      });
      if (!remainsBoundToRequestedParent) {
        return { outcome: 'rejected', reason: 'append_unavailable' };
      }
    }
    if (!invocationTracker.getActiveSlots || !invocationTracker.getUserId) {
      return { outcome: 'rejected', reason: 'append_unavailable' };
    }
    const projection = projectLifecycleAppendAction({
      threadId: input.threadId,
      userId: input.userId,
      queueRevision: queue.snapshotRevision(input.threadId, input.userId),
      entry,
      invocationTracker: {
        getActiveSlots: (threadId) => invocationTracker.getActiveSlots?.(threadId) ?? [],
        getUserId: (threadId, catId) => invocationTracker.getUserId?.(threadId, catId) ?? null,
        getAgentClientActiveRunDispatcher: (threadId, catId) =>
          invocationTracker.getAgentClientActiveRunDispatcher?.(threadId, catId),
      },
    });
    if (!projection.available) return { outcome: 'rejected', reason: 'append_unavailable' };
    return this.appendExactEntry({
      threadId: input.threadId,
      userId: input.userId,
      entryId: input.entryId,
      expectedQueueRevision: projection.action.expectedQueueRevision,
      expectedRuns: projection.action.expectedRuns,
    });
  }

  /**
   * Explicit Queue -> existing Active Run transfer. Every capability/run fence
   * is revalidated before the synchronous Queue claim; provider side effects
   * occur only after exposure, lifecycle refs, and History admission are durable.
   */
  async appendExactEntry(input: {
    threadId: string;
    userId: string;
    entryId: string;
    expectedQueueRevision: string;
    expectedRuns: readonly { targetId: string; invocationId: string; responseMessageId: string }[];
  }): Promise<AppendExactEntryResult> {
    const { queue, invocationTracker, messageStore, socketManager } = this.deps;
    if (input.expectedRuns.length === 0) {
      return { outcome: 'rejected', reason: 'custody_unavailable' };
    }
    const entry = queue.getEntrySnapshot(input.threadId, input.userId, input.entryId);
    if (!entry || input.expectedRuns.some((run, index) => run.targetId !== queueEntryTargetCats(entry)[index])) {
      return { outcome: 'rejected', reason: 'state_changed' };
    }
    const activeRunByTarget = new Map(
      (invocationTracker.getActiveSlots?.(input.threadId) ?? []).flatMap((slot) =>
        slot.activeRun ? [[slot.catId, slot.activeRun] as const] : [],
      ),
    );
    if (
      input.expectedRuns.some((run) => {
        const current = activeRunByTarget.get(run.targetId);
        return (
          !current ||
          current.invocationId !== run.invocationId ||
          current.responseMessageId !== run.responseMessageId ||
          invocationTracker.getUserId?.(input.threadId, run.targetId) !== input.userId
        );
      })
    ) {
      return { outcome: 'rejected', reason: 'append_unavailable' };
    }
    const dispatchers = input.expectedRuns.map((run) => {
      const dispatcher = invocationTracker.getAgentClientActiveRunDispatcher?.(input.threadId, run.targetId);
      return dispatcher?.capabilities.append === true && dispatcher.invocationId === run.invocationId
        ? dispatcher
        : undefined;
    });
    if (dispatchers.some((dispatcher) => !dispatcher)) {
      return { outcome: 'rejected', reason: 'append_unavailable' };
    }

    const claimed = await queue.claimExactAppend(
      input.threadId,
      input.userId,
      input.entryId,
      input.expectedQueueRevision,
      input.expectedRuns.map((run) => run.targetId),
    );
    if (!claimed) return { outcome: 'rejected', reason: 'state_changed' };
    const seenAt = Math.max(Date.now(), claimed.enqueuedAt);
    const inputMessageIds = queueEntryMessageIds(claimed);
    if (inputMessageIds.length === 0) {
      await queue.restoreClaimedEntries(input.threadId, [input.entryId]);
      return { outcome: 'rejected', reason: 'lifecycle_conflict' };
    }
    let removed: QueueEntry | null = null;
    let lifecycleAdmissionCommitted = false;
    let providerDispatchStarted = false;
    const mirroredRuns: (typeof input.expectedRuns)[number][] = [];
    let sourceMessages: StoredMessage[] = [];
    try {
      const sourceMessagesBeforeAdmission = (
        await Promise.all(inputMessageIds.map((messageId) => messageStore.getById(messageId)))
      ).filter((message): message is StoredMessage => !!message);
      if (sourceMessagesBeforeAdmission.length !== inputMessageIds.length) {
        throw new Error(`lifecycle Append source vanished before admission: ${input.entryId}`);
      }
      sourceMessages = sourceMessagesBeforeAdmission;
      const imagePaths = sourceMessagesBeforeAdmission.flatMap((message) => extractImagePaths(message.contentBlocks));
      for (const run of input.expectedRuns) {
        if (
          !invocationTracker.appendLifecycleActiveRunInputs?.(
            input.threadId,
            run.targetId,
            run,
            input.entryId,
            inputMessageIds,
          )
        ) {
          throw new Error(`Active Run changed during Append admission: ${run.targetId}/${run.invocationId}`);
        }
        mirroredRuns.push(run);
      }

      const admission = await messageStore.commitLifecycleAppendAdmission({
        threadId: input.threadId,
        entryId: input.entryId,
        inputMessageIds,
        runs: input.expectedRuns.map((run) => ({ ...run, dispatchedAt: seenAt })),
      });
      if (admission.kind !== 'applied' && admission.kind !== 'replayed') {
        throw new Error(
          `lifecycle Append admission ${admission.kind}:${'reason' in admission ? admission.reason : ''}`,
        );
      }
      lifecycleAdmissionCommitted = true;
      sourceMessages = admission.messages.slice(0, inputMessageIds.length);
      const delivery = await this.markDeliveredAndEmit(
        input.userId,
        input.threadId,
        inputMessageIds,
        seenAt,
        new Set(),
      );
      if (delivery.failedIds.length > 0) {
        throw new Error(`lifecycle Append delivery transition failed: ${delivery.failedIds.join(',')}`);
      }
      removed = await queue.removeProcessedDurable(input.threadId, input.userId, input.entryId);
      if (!removed) throw new Error(`claimed Append Queue entry vanished: ${input.entryId}`);

      try {
        for (const message of admission.messages) this.emitLifecycleMessageUpdated(input.userId, message);
        await emitQueueUpdated(
          socketManager,
          input.userId,
          input.threadId,
          queue.list(input.threadId, input.userId),
          messageStore,
          'appended',
        );
      } catch (projectionErr) {
        this.deps.log.warn(
          { projectionErr, threadId: input.threadId, entryId: input.entryId },
          '[QueueProcessor] lifecycle Append committed but live projection emit failed',
        );
      }
      providerDispatchStarted = true;
      const results = await Promise.all(
        input.expectedRuns.map(async (run, index) => {
          try {
            return await dispatchers[index]!.dispatch(
              {
                text: claimed.payload.content,
                ...(imagePaths.length > 0 ? { imagePaths } : {}),
                messageIds: inputMessageIds,
              },
              { force: false, expectedInvocationId: run.invocationId },
            );
          } catch {
            return { accepted: false as const, reason: 'provider_rejected' as const };
          }
        }),
      );
      const rejectedTargetIds = results.flatMap((result, index) =>
        result.accepted ? [] : [input.expectedRuns[index]!.targetId],
      );
      if (rejectedTargetIds.length > 0) {
        await this.compensateLifecycleAppendTargets({
          entry: claimed,
          inputMessageIds,
          sourceMessages,
          runs: input.expectedRuns,
          failedTargetIds: rejectedTargetIds,
          failedAtLowerBound: seenAt + 1,
        });
        return { outcome: 'rejected', reason: 'provider_rejected', rejectedTargetIds };
      }
      return { outcome: 'appended', entry: removed, acceptedTargetIds: input.expectedRuns.map((run) => run.targetId) };
    } catch (err) {
      if (!providerDispatchStarted && lifecycleAdmissionCommitted) {
        try {
          if (!removed) removed = await queue.removeProcessedDurable(input.threadId, input.userId, input.entryId);
          await this.compensateLifecycleAppendTargets({
            entry: claimed,
            inputMessageIds,
            sourceMessages,
            runs: input.expectedRuns,
            failedTargetIds: input.expectedRuns.map((run) => run.targetId),
            failedAtLowerBound: seenAt + 1,
          });
          await emitQueueUpdated(
            socketManager,
            input.userId,
            input.threadId,
            queue.list(input.threadId, input.userId),
            messageStore,
            'append_failed',
          );
        } catch (compensationErr) {
          this.deps.log.error(
            { compensationErr, threadId: input.threadId, entryId: input.entryId },
            '[QueueProcessor] failed to compensate lifecycle Append after durable admission',
          );
        }
      } else if (!providerDispatchStarted) {
        for (const run of mirroredRuns) {
          invocationTracker.detachLifecycleActiveRunInputs?.(
            input.threadId,
            run.targetId,
            run,
            input.entryId,
            inputMessageIds,
          );
        }
        const restored = await queue.restoreClaimedEntries(input.threadId, [input.entryId]);
        if (restored) {
          try {
            await emitQueueUpdated(
              socketManager,
              input.userId,
              input.threadId,
              queue.list(input.threadId, input.userId),
              messageStore,
              'append_rollback',
            );
          } catch (restoreErr) {
            this.deps.log.error(
              { restoreErr, threadId: input.threadId, entryId: input.entryId },
              '[QueueProcessor] failed to project lifecycle Append rollback',
            );
          }
        }
      }
      this.deps.log.error(
        { err, threadId: input.threadId, entryId: input.entryId },
        '[QueueProcessor] explicit lifecycle Append failed closed',
      );
      return { outcome: 'rejected', reason: 'lifecycle_conflict' };
    }
  }

  /**
   * Adopt full queued bodies that one exact active child has already requested.
   * Each adopted target leaves its source entry immediately; sibling targets
   * remain pending there, while Message lifecycle points at the existing
   * processing response instead of creating a second invocation.
   */
  async adoptExposedQueuedEntries(input: {
    threadId: string;
    userId: string;
    catId: string;
    invocationId: string;
    entries: readonly { entryId: string; messageId: string }[];
    seenAt?: number;
  }): Promise<AdoptExposedQueuedEntriesResult> {
    const { queue, invocationTracker, messageStore, socketManager } = this.deps;
    const activeRun = invocationTracker
      .getActiveSlots?.(input.threadId)
      .find((slot) => slot.catId === input.catId)?.activeRun;
    if (
      !activeRun ||
      activeRun.invocationId !== input.invocationId ||
      activeRun.targetId !== input.catId ||
      invocationTracker.getUserId?.(input.threadId, input.catId) !== input.userId
    ) {
      return { outcome: 'rejected', reason: 'active_run_missing' };
    }
    if (
      input.entries.length === 0 ||
      new Set(input.entries.map((entry) => entry.entryId)).size !== input.entries.length ||
      new Set(input.entries.map((entry) => entry.messageId)).size !== input.entries.length
    ) {
      return { outcome: 'rejected', reason: 'state_changed' };
    }

    const adoptedEntryIds: string[] = [];
    for (const candidate of input.entries) {
      const result = await this.adoptExposedQueuedEntry({
        ...input,
        candidate,
        run: {
          targetId: input.catId,
          invocationId: activeRun.invocationId,
          responseMessageId: activeRun.responseMessageId,
        },
      });
      if (result.outcome === 'rejected') return result;
      adoptedEntryIds.push(candidate.entryId);
    }

    await emitQueueUpdated(
      socketManager,
      input.userId,
      input.threadId,
      queue.list(input.threadId, input.userId),
      messageStore,
      'queued_adopted',
    );
    return { outcome: 'adopted', adoptedEntryIds };
  }

  private async adoptExposedQueuedEntry(input: {
    threadId: string;
    userId: string;
    catId: string;
    invocationId: string;
    candidate: { entryId: string; messageId: string };
    run: { targetId: string; invocationId: string; responseMessageId: string };
    seenAt?: number;
  }): Promise<AdoptExposedQueuedEntriesResult> {
    const { queue, invocationTracker, messageStore } = this.deps;
    const claimed = await queue.claimExactExposureDurable(
      input.threadId,
      input.userId,
      input.candidate.entryId,
      input.catId,
      input.candidate.messageId,
    );
    if (!claimed) return { outcome: 'rejected', reason: 'state_changed', entryId: input.candidate.entryId };

    const messageIds = queueEntryMessageIds(claimed);
    const newlySeen = true;
    let lifecycleCommitted = false;
    let liveProjectionExtended = false;
    try {
      liveProjectionExtended =
        invocationTracker.adoptLifecycleActiveRunInputs?.(
          input.threadId,
          input.catId,
          input.run,
          claimed.id,
          messageIds,
        ) ?? false;
      if (!liveProjectionExtended) {
        await queue.restoreClaimedEntries(input.threadId, [claimed.id]);
        return { outcome: 'rejected', reason: 'active_run_missing', entryId: claimed.id };
      }

      const seenAt = Math.max(input.seenAt ?? Date.now(), claimed.enqueuedAt);
      const delivery = await this.markDeliveredAndEmit(input.userId, input.threadId, messageIds, seenAt, new Set());
      if (delivery.failedIds.length > 0) {
        invocationTracker.detachLifecycleActiveRunInputs?.(
          input.threadId,
          input.catId,
          input.run,
          claimed.id,
          messageIds,
        );
        await queue.restoreClaimedEntries(input.threadId, [claimed.id]);
        return { outcome: 'rejected', reason: 'persistence_unavailable', entryId: claimed.id };
      }

      const admission = await messageStore.commitLifecycleAppendAdmission({
        threadId: input.threadId,
        entryId: claimed.id,
        inputMessageIds: messageIds,
        runs: [{ ...input.run, dispatchedAt: seenAt }],
      });
      if (admission.kind !== 'applied' && admission.kind !== 'replayed') {
        invocationTracker.detachLifecycleActiveRunInputs?.(
          input.threadId,
          input.catId,
          input.run,
          claimed.id,
          messageIds,
        );
        await queue.restoreClaimedEntries(input.threadId, [claimed.id]);
        return { outcome: 'rejected', reason: 'lifecycle_conflict', entryId: claimed.id };
      }
      lifecycleCommitted = true;

      const committed = await queue.commitClaimedAdoptionDurable(
        input.threadId,
        input.userId,
        claimed.id,
        input.catId,
        input.invocationId,
        seenAt,
      );
      if (!committed) {
        const terminalized = await queue.removeProcessedDurable(input.threadId, input.userId, claimed.id);
        if (!terminalized) {
          // The response lifecycle already owns this input. Best-effort bind the
          // row to processing so startup terminalizes it as interrupted instead
          // of restoring a claimed row to executable Queue work.
          await queue.commitClaimedProcessing(input.threadId, [claimed.id], seenAt);
          return { outcome: 'rejected', reason: 'persistence_unavailable', entryId: claimed.id };
        }
      }
      if (newlySeen) recordQueuedSeenTelemetry();
      recordQueuedHandledTelemetry({ fullyConsumed: true });
      for (const message of admission.messages) this.emitLifecycleMessageUpdated(input.userId, message);
      return { outcome: 'adopted', adoptedEntryIds: [claimed.id] };
    } catch (err) {
      if (!lifecycleCommitted) {
        if (liveProjectionExtended) {
          invocationTracker.detachLifecycleActiveRunInputs?.(
            input.threadId,
            input.catId,
            input.run,
            claimed.id,
            messageIds,
          );
        }
        await queue.restoreClaimedEntries(input.threadId, [claimed.id]);
      } else {
        // Once the source is attached to the response, queued is no longer a
        // truthful recovery state. Preserve processing ownership if storage
        // recovers enough to accept this final defensive write.
        await queue
          .commitClaimedProcessing(input.threadId, [claimed.id], input.seenAt ?? Date.now())
          .catch(() => false);
      }
      this.deps.log.error(
        { err, threadId: input.threadId, entryId: claimed.id, invocationId: input.invocationId },
        '[QueueProcessor] exact queued-body adoption failed closed',
      );
      return {
        outcome: 'rejected',
        reason: lifecycleCommitted ? 'persistence_unavailable' : 'lifecycle_conflict',
        entryId: claimed.id,
      };
    }
  }

  /** ADR-042: removing a queued carrier must also close its durable responsibility. */
  async finalizeRemovedEntry(
    entry: Pick<QueueEntry, 'execution'> | null | undefined,
    reason: FreshnessSupplementFailureReason = 'user_cancel',
  ): Promise<boolean> {
    if (!entry?.execution.freshnessSupplementId || !this.deps.freshnessClosureStore) return true;
    try {
      const supplement = await this.deps.freshnessClosureStore.getSupplement(entry.execution.freshnessSupplementId);
      if (supplement?.status !== 'pending') return true;
      const failed = await this.deps.freshnessClosureStore.failSupplement(supplement.id, {
        reason,
        now: Date.now(),
      });
      this.broadcastFreshnessSupplement(failed);
      return true;
    } catch (err) {
      this.deps.log.error(
        { err, supplementId: entry.execution.freshnessSupplementId, reason },
        '[F254] failed to terminalize removed supplement carrier',
      );
      return false;
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

  private publishRequeuedPrestartEntry(entry: QueueEntry): void {
    void (async () => {
      try {
        await emitQueueUpdated(
          this.deps.socketManager,
          queueEntryOwnerId(entry),
          entry.threadId,
          this.deps.queue.list(entry.threadId, queueEntryOwnerId(entry)),
          this.deps.messageStore,
          'zombie_prestart_requeued',
        );
      } catch (err) {
        this.deps.log.warn(
          { err, threadId: entry.threadId, userId: queueEntryOwnerId(entry), entryId: entry.id },
          '[QueueProcessor] zombie pre-start queue update failed',
        );
      }
    })();
  }

  private async recoverExpiredPrestartReservation(
    threadId: string,
    catId: string,
    reservation: ProcessingSlotReservation,
  ): Promise<'requeued' | 'terminalized' | 'released' | 'blocked'> {
    if (reservation.trackerStarted) return 'blocked';
    // A successful Queue claim commit removes the durable pending row and
    // retains only the process-local admitted carrier until execution starts.
    // Recovery therefore has to inspect the same pending-or-admitted view as
    // pre-start retirement; a durable-only snapshot would silently release a
    // stale processing reservation without recording its History failure.
    const current = this.deps.queue
      .getProcessingGroupAcrossUsers(threadId, reservation.entryId)
      ?.find((entry) => queueEntryOwnerId(entry) === reservation.userId);
    if (!current) return 'released';
    if (current.status === 'claimed') {
      if (!(await this.deps.queue.rollbackProcessingDurable(threadId, reservation.entryId))) return 'blocked';
      const requeued = this.deps.queue.getEntrySnapshot(threadId, reservation.userId, reservation.entryId);
      if (requeued?.status !== 'queued') return 'blocked';
      this.publishRequeuedPrestartEntry(requeued);
      return 'requeued';
    }
    if (current.status !== 'processing') return 'released';
    const outcome = await this.failPrestartProcessingGroup(threadId, catId, reservation.userId, 'prestart_timeout');
    return outcome === 'retired' ? 'terminalized' : 'blocked';
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

  /**
   * Replace every observed pre-start execution reservation with a retirement
   * barrier in one synchronous turn. The processing rows stay visible until
   * their durable terminal transitions all succeed.
   */
  private preparePrestartRetirements(
    threadId: string,
    catIds: readonly string[],
    userId: string,
  ): PreparedPrestartRetirement[] | null {
    return preparePrestartRetirements({
      slots: this.processingSlots,
      queue: this.deps.queue,
      threadId,
      catIds,
      userId,
      slotKey: QueueProcessor.slotKey,
    });
  }

  private async terminalizePreparedPrestartRetirements(
    retirements: readonly PreparedPrestartRetirement[],
  ): Promise<boolean> {
    const retiringEntryIds = new Set(retirements.flatMap((retirement) => retirement.carriers.map((entry) => entry.id)));
    return terminalizePreparedPrestartRetirements(retirements, {
      finalizeSupplement: (entry) => this.finalizeRemovedEntry(entry, 'user_cancel'),
      messageStore: this.deps.messageStore,
      shouldCancelMessage: (entry, messageId) =>
        !this.deps.queue
          .listUsersForThread(entry.threadId)
          .some((userId) =>
            this.deps.queue
              .list(entry.threadId, userId)
              .some(
                (candidate) =>
                  !retiringEntryIds.has(candidate.id) && queueEntryMessageIds(candidate).includes(messageId),
              ),
          ),
      commitCarrier: async (entry) =>
        (await this.deps.queue.removeProcessedAcrossUsersDurable(
          entry.threadId,
          entry.id,
          'interrupted',
          'invocation_cancelled',
        )) !== null,
      emitMessageDeleted: (userId, threadId, messageId) =>
        this.deps.socketManager.emitToUser(userId, 'message_deleted', {
          messageId: messageId ?? null,
          threadId,
          deletedBy: userId,
        }),
      log: this.deps.log,
    });
  }

  /** Commit disappearance only after every carrier reached durable terminal truth. */
  private commitPreparedPrestartRetirements(retirements: readonly PreparedPrestartRetirement[]): boolean {
    return commitPreparedPrestartRetirements({
      retirements,
      slots: this.processingSlots,
      queue: this.deps.queue,
    });
  }

  async retirePrestartProcessingGroup(
    threadId: string,
    catId: string,
    userId: string,
  ): Promise<PrestartRetirementOutcome> {
    const retirements = this.preparePrestartRetirements(threadId, [catId], userId);
    if (!retirements || retirements.length !== 1) return 'state_changed';
    if (!(await this.terminalizePreparedPrestartRetirements(retirements))) return 'terminalization_failed';
    return this.commitPreparedPrestartRetirements(retirements) ? 'retired' : 'state_changed';
  }

  /**
   * Fail a tracker-less create→startAll group through the ordinary delivery
   * lifecycle. Public sources receive an adjacent delivery_failure and settle
   * their exact target ref; typed/private carriers keep their own producer
   * terminalization and never manufacture a History row.
   */
  async failPrestartProcessingGroup(
    threadId: string,
    catId: string,
    userId: string,
    reason: 'control_plane_unavailable' | 'execution_owner_lost' | 'prestart_timeout',
  ): Promise<PrestartRetirementOutcome> {
    const retirements = this.preparePrestartRetirements(threadId, [catId], userId);
    if (!retirements || retirements.length !== 1) return 'state_changed';

    for (const retirement of retirements) {
      for (const carrier of retirement.carriers) {
        if (!(await this.finalizeRemovedEntry(carrier, 'infrastructure'))) return 'terminalization_failed';
        if (isPublicQueueEntry(carrier)) {
          const sourceMessageId = carrier.payload.messageId;
          const source = sourceMessageId ? await this.deps.messageStore.getById(sourceMessageId) : null;
          if (!source) return 'terminalization_failed';
          const requestedTargets = [...queueEntryTargetCats(carrier)];
          const failedAt = Math.max(Date.now(), source.timestamp);
          const reasonText =
            reason === 'control_plane_unavailable'
              ? '执行控制面不可用'
              : reason === 'execution_owner_lost'
                ? '执行进程归属已丢失'
                : '启动阶段超时';
          const failure = await this.deps.messageStore.commitLifecyclePreAdmissionFailure({
            sourceMessageId: source.id,
            expectedEntryId: carrier.id,
            requestedTargets,
            reason,
            content: `唤起${requestedTargets.join('、') || catId}失败：${reasonText}（${reason}）。来源消息：${source.id}。`,
            failedAt,
          });
          if (failure.kind !== 'applied' && failure.kind !== 'replayed') return 'terminalization_failed';
          this.emitLifecycleMessageUpdated(queueEntryOwnerId(carrier), failure.inputMessage);
          this.emitLifecycleMessageUpdated(queueEntryOwnerId(carrier), failure.failureMessage);
        }
        const terminal = await this.deps.queue.removeProcessedAcrossUsersDurable(
          carrier.threadId,
          carrier.id,
          'failed',
          reason,
        );
        if (!terminal) return 'terminalization_failed';
      }
    }

    if (!this.commitPreparedPrestartRetirements(retirements)) return 'state_changed';
    await emitQueueUpdated(
      this.deps.socketManager,
      userId,
      threadId,
      this.deps.queue.list(threadId, userId),
      this.deps.messageStore,
      'pre_admission_failed',
    );
    return 'retired';
  }

  /**
   * Force-reset recovery for canonical pre-start owners that have no tracker,
   * invocation record, or session lock witness yet. Snapshot the user-owned
   * thread slots, install every barrier synchronously, then terminalize their
   * exact Queue groups before making the slots disappear.
   */
  async retireThreadPrestartProcessingGroups(
    threadId: string,
    userId: string,
  ): Promise<ThreadPrestartRetirementResult> {
    const catIds: string[] = [];
    for (const [key, reservation] of this.processingSlots) {
      const scope = QueueProcessor.parseSlotKey(key);
      if (scope?.threadId === threadId && reservation.userId === userId) catIds.push(scope.catId);
    }
    if (catIds.length === 0) return { outcome: 'none', retiredCatIds: [] };

    const retirements = this.preparePrestartRetirements(threadId, catIds, userId);
    if (!retirements || retirements.length === 0) return { outcome: 'state_changed', retiredCatIds: [] };
    if (!(await this.terminalizePreparedPrestartRetirements(retirements))) {
      return { outcome: 'terminalization_failed', retiredCatIds: [] };
    }
    if (!this.commitPreparedPrestartRetirements(retirements)) {
      return { outcome: 'state_changed', retiredCatIds: [] };
    }
    return {
      outcome: 'retired',
      retiredCatIds: [...new Set(retirements.map((retirement) => retirement.targetCatId))],
    };
  }

  /**
   * Reinstall the process-local slot barrier from one restart-stable retirement
   * intent before normal Queue resume can expose a surviving subset.
   */
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

  private runOwnershipValidatedHook(hook: (() => void) | undefined): void {
    hook?.();
  }

  /**
   * Acquire tracker ownership for execution paths that originate outside the queue.
   *
   * Non-preemptive callers fail if either projection is occupied. Replacement callers wait
   * for manual seal exclusion, then keep that admission lease while retiring the old durable
   * group and publishing the tracker owner. A failed terminal write keeps the old group
   * visible and prevents the replacement provider from starting.
   */
  async acquireExternalExecution(
    threadId: string,
    catIds: string[],
    userId: string,
    options: {
      mode: 'non_preemptive' | 'replacement';
      executionId?: string;
      /**
       * Route-layer cancellation that must run only after the whole target set passes
       * the user-scoped replacement fence. It executes synchronously before any
       * replacement tracker installation. Durable Queue retirement happens first.
       */
      onOwnershipValidated?: () => void;
    },
  ): Promise<AbortController | null> {
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
    const admission = await this.deps.invocationTracker.acquireExecutionAdmission(threadId, uniqueCatIds);
    if (!admission) return null;
    try {
      if (!this.canReplaceExternalTargetSet(threadId, uniqueCatIds, userId)) {
        this.deps.log.info(
          { threadId, targetCats: uniqueCatIds, replacementExecutionId: options.executionId },
          '[QueueProcessor] external replacement rejected after waiting for execution admission',
        );
        return null;
      }
      const retirements = this.preparePrestartRetirements(threadId, uniqueCatIds, userId);
      if (!retirements) {
        this.deps.log.error(
          { threadId, targetCats: uniqueCatIds, replacementExecutionId: options.executionId },
          '[QueueProcessor] external replacement rejected inconsistent processing group',
        );
        return null;
      }
      if (!(await this.terminalizePreparedPrestartRetirements(retirements))) return null;
      if (!this.commitPreparedPrestartRetirements(retirements)) {
        this.deps.log.error(
          { threadId, targetCats: uniqueCatIds, replacementExecutionId: options.executionId },
          '[QueueProcessor] external replacement lost retirement barrier before commit',
        );
        return null;
      }

      this.runOwnershipValidatedHook(options.onOwnershipValidated);

      const retiredReservations = retirements.map(({ barrier }) => ({
        entryId: barrier.entryId,
        ...(barrier.invocationId ? { invocationId: barrier.invocationId } : {}),
      }));
      if (retiredReservations.length > 0) {
        this.deps.log.info(
          { threadId, replacementExecutionId: options.executionId, retiredReservations },
          '[QueueProcessor] external replacement retired exact processing reservations',
        );
      }
      const controller = this.deps.invocationTracker.startAll(threadId, uniqueCatIds, userId, options.executionId);
      if (!controller) {
        this.deps.log.error(
          { threadId, targetCats: uniqueCatIds, replacementExecutionId: options.executionId },
          '[QueueProcessor] execution admission lost its manual-seal exclusion before tracker publication',
        );
        return null;
      }
      return controller;
    } finally {
      admission.release();
    }
  }

  /**
   * Explicitly recover stale reservations that provably never installed a provider
   * tracker. Unlike the former read-side sweep, this is called only by the serialized
   * owner reaper and never guesses about a started provider.
   */
  async reapStalePrestartReservations(now = Date.now()): Promise<number> {
    if (this.processingSlotTtlMs <= 0) return 0;
    let reaped = 0;
    for (const [key, reservation] of this.processingSlots) {
      if (
        now - reservation.startedAt <= this.processingSlotTtlMs ||
        reservation.trackerStarted ||
        reservation.retirementBarrier
      )
        continue;
      const scope = QueueProcessor.parseSlotKey(key);
      if (!scope || this.deps.invocationTracker.has(scope.threadId, scope.catId)) continue;
      const recovery = await this.recoverExpiredPrestartReservation(scope.threadId, scope.catId, reservation);
      if (recovery === 'blocked') continue;
      if (this.processingSlots.get(key) === reservation && !this.releaseProcessingSlot(key, reservation)) continue;
      reaped += 1;
      this.deps.log.warn(
        {
          event: 'invocation_prestart_reservation_reaped',
          threadId: scope.threadId,
          catId: scope.catId,
          entryId: reservation.entryId,
          ageMs: now - reservation.startedAt,
          recovery,
        },
        '[F118] stale pre-provider reservation released by explicit owner reaper',
      );
    }
    return reaped;
  }

  /** Non-mutating candidates whose provider tracker was installed. */
  listStaleProcessingLeases(now = Date.now()): StaleProcessingOwnerLease[] {
    if (this.processingSlotTtlMs <= 0) return [];
    const result: StaleProcessingOwnerLease[] = [];
    for (const [key, reservation] of this.processingSlots) {
      if (
        now - reservation.startedAt <= this.processingSlotTtlMs ||
        !reservation.trackerStarted ||
        !reservation.invocationId
      ) {
        continue;
      }
      const scope = QueueProcessor.parseSlotKey(key);
      if (!scope) continue;
      result.push({
        threadId: scope.threadId,
        catId: scope.catId,
        userId: reservation.userId,
        executionId: reservation.invocationId,
        startedAt: reservation.startedAt,
        ageMs: now - reservation.startedAt,
      });
    }
    return result;
  }

  /** Expose queued-state for route fairness decisions in non-queue entry paths (retry/connector). */
  hasQueuedForThread(threadId: string): boolean {
    return this.deps.queue.hasQueuedForThread(threadId);
  }

  /** Public-conversation fairness is entry-kind based; sender identity is not lifecycle state. */
  hasQueuedConversationInputsForThread(threadId: string): boolean {
    return this.deps.queue.hasQueuedConversationInputsForThread(threadId);
  }

  private async ackPromptMentionCursors(input: PromptMessagesExposedInput): Promise<void> {
    const cursorStore = this.deps.deliveryCursorStore;
    if (!cursorStore) return;
    for (const messageId of new Set(input.messageIds)) {
      try {
        const message = await this.deps.messageStore.getById(messageId);
        if (!message?.mentions.includes(input.catId as CatId)) continue;
        const cursor = this.deps.messageStore.canonicalizeCursor
          ? await this.deps.messageStore.canonicalizeCursor(messageId, input.threadId)
          : messageId;
        await cursorStore.ackMentionCursor(input.userId, input.catId as CatId, input.threadId, cursor);
      } catch (err) {
        this.deps.log.warn(
          { err, threadId: input.threadId, catId: input.catId, invocationId: input.invocationId, messageId },
          '[QueueProcessor] prompt mention cursor ack failed after durable body exposure',
        );
      }
    }
  }

  /** F254 D1.1: queued freshness input scoped to the cat that would process it. */
  getQueuedFreshnessMessagesForCat(
    threadId: string,
    userId: string,
    catId: string,
    parentInvocationId?: string,
  ): Array<{ entryId: string; from: MessageFrom; content: string; messageId?: string | null }> {
    return this.deps.queue.getQueuedFreshnessMessagesForCat(threadId, userId, catId, { parentInvocationId });
  }

  /**
   * Bind only Queue entries whose complete persisted bodies were placed in the
   * current invocation prompt. This is the prompt-transport analogue of an
   * explicit full-body get_thread_context read.
   */
  async markPromptMessagesSeen(input: PromptMessagesExposedInput): Promise<void> {
    await this.ackPromptMentionCursors(input);
    const attempts = this.deps.queue.findAdmittedEntriesForMessages(
      input.threadId,
      input.messageIds,
      input.userId,
      input.catId,
    );
    for (const entry of attempts) {
      const result = await this.deps.queue.markProcessingSeen(
        input.threadId,
        input.userId,
        entry.id,
        input.catId,
        input.invocationId,
        input.seenAt,
      );
      if (result?.newlySeen) recordQueuedSeenTelemetry();
    }
  }

  /**
   * Persist the exact child-created boundary before the generator can advance
   * to prompt exposure. This is intentionally separate from queued_seen.
   */
  async markPromptMessagesAwakened(input: PromptMessagesAwakenedInput): Promise<void> {
    const attempts = this.deps.queue.findAdmittedEntriesForMessages(
      input.threadId,
      input.messageIds,
      input.userId,
      input.catId,
    );
    for (const entry of attempts) {
      if (
        !(await this.deps.queue.markProcessingAwakened(
          input.threadId,
          input.userId,
          entry.id,
          input.catId,
          input.invocationId,
          input.awakenedAt,
        ))
      ) {
        throw new Error(`Queue awakened evidence changed before commit: ${entry.id}`);
      }
    }
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

  /** Process-local proof that an execute coroutine still owns this cat slot. */
  hasProcessingSlotReservation(threadId: string, catId: string): boolean {
    return this.processingSlots.has(QueueProcessor.slotKey(threadId, catId));
  }

  /** #555: Cat-specific busy check — covers processingSlots + queue entries for this cat. */
  isCatBusy(threadId: string, catId: string): boolean {
    const reservation = this.processingSlots.get(QueueProcessor.slotKey(threadId, catId));
    if (reservation) return true;
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
    return !processingEntry || queueEntryOwnerId(processingEntry) === requestUserId;
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
    if (
      capsule.continuationReason !== 'dispatch_handled' &&
      recent.length >= QueueProcessor.MAX_CONTINUATIONS_PER_WINDOW
    ) {
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

    const result = await this.deps.queue.enqueueDurable({
      from: { kind: 'agent', catId },
      threadId,
      userId,
      kind: 'private_input',
      ownerAuthProvenance,
      content: formatContinuationPrompt(capsule),
      sourceCategory: 'continuation',
      sourceId: continuationKey,
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
      priority: 'urgent',
    });
    if (result.outcome === 'full' || !result.entry) {
      this.setContinuationWindow(key, recent);
      this.deps.log.warn({ threadId, catId }, '[QueueProcessor] continuation skipped: queue full');
      return { outcome: 'queue_full' };
    }

    if (capsule.continuationReason !== 'dispatch_handled') recent.push(now);
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

  /** Atomic process-local Queue → admitted handoff immediately before provider creation. */
  private async admitQueueEntriesForProvider(entries: readonly QueueEntry[]): Promise<void> {
    const primary = entries[0];
    if (!primary) throw new Error('Queue admission requires at least one claimed row');
    const admittedAt = Math.max(Date.now(), ...entries.map((entry) => entry.enqueuedAt));
    const allMessageIds = [...new Set(entries.flatMap((entry) => queueEntryMessageIds(entry)))];
    const newlyPublished = await this.markDeliveredAndEmit(
      queueEntryOwnerId(primary),
      primary.threadId,
      allMessageIds,
      admittedAt,
    );
    if (newlyPublished.failedIds.length > 0) {
      throw new Error(`Queue admission failed to publish History sources: ${newlyPublished.failedIds.join(',')}`);
    }
    for (const messageId of allMessageIds) {
      const message = await this.deps.messageStore.getById(messageId);
      if (!message || !isTimelinePublished(message)) {
        throw new Error(`Queue admission source did not enter History: ${messageId}`);
      }
    }
    if (
      entries.length > 0 &&
      !(await this.deps.queue.commitClaimedProcessing(
        entries[0]!.threadId,
        entries.map((entry) => entry.id),
        admittedAt,
      ))
    ) {
      throw new Error(`Queue admission lost durable claim: ${entries.map((entry) => entry.id).join(',')}`);
    }
  }

  /** Forget one admitted process-local attempt after its response reaches terminal. */
  private async settleAttemptQueueEntry(attempted: QueueEntry, finalStatus: InvocationFinalStatus): Promise<void> {
    const terminal =
      finalStatus === 'succeeded'
        ? ({ outcome: 'handled' } as const)
        : finalStatus === 'failed'
          ? ({ outcome: 'failed', reason: 'invocation_failed' } as const)
          : finalStatus === 'canceled_by_user'
            ? ({ outcome: 'cancelled', reason: 'invocation_cancelled' } as const)
            : ({ outcome: 'interrupted', reason: 'invocation_cancelled' } as const);
    const removed = await this.deps.queue.removeProcessedAcrossUsersDurable(
      attempted.threadId,
      attempted.id,
      terminal.outcome,
      'reason' in terminal ? terminal.reason : undefined,
    );
    if (!removed) throw new Error(`admitted attempt cleanup lost source entry ${attempted.id}`);
  }

  /** Provider admission accepts only exact durable source custody or a source-less internal carrier. */
  private async ensureAttemptMessageCustody(attempted: QueueEntry): Promise<'durable' | 'absent'> {
    const messageIds = queueEntryMessageIds(attempted);
    if (messageIds.length === 0) return 'absent';

    for (const messageId of messageIds) {
      let message;
      try {
        message = await this.deps.messageStore.getById(messageId);
      } catch (error) {
        this.deps.log.warn(
          { err: error, threadId: attempted.threadId, queueEntryId: attempted.id, messageId },
          '[QueueProcessor] queued source custody lookup failed; refusing provider admission',
        );
        throw new Error(`queued source custody lookup failed for ${messageId}`, { cause: error });
      }
      if (!message) {
        throw new Error(`queued source is missing for ${messageId}`);
      }
      if (message.deliveryStatus === 'canceled') throw new Error(`queued source was canceled: ${messageId}`);
    }
    return 'durable';
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
      lifecycle?: import('@cat-cafe/shared').LifecycleStoredMessageMetadata;
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
        const projectedExtra = result.extra ?? {};
        deliveredMessages.push({
          id: result.id,
          ...(result.from ? { from: result.from } : {}),
          content: result.content,
          ...(result.lifecycle ? { lifecycle: result.lifecycle } : {}),
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

  /** Publish one exact same-id lifecycle snapshot; clients upsert without inventing state. */
  private emitLifecycleMessageUpdated(userId: string, message: StoredMessage): void {
    if (!message.lifecycle) return;
    this.deps.socketManager.emitToUser(userId, 'message_lifecycle_updated', {
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
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      },
    });
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
    for (const key of this.processingSlots.keys()) {
      if (QueueProcessor.slotMatchesThread(key, threadId)) return true;
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

  /**
   * Retire only projections owned by the exact parent execution. This is the shared
   * fence for explicit reaping and terminal cleanup; a replacement on one cat never
   * inherits the older execution's deletion.
   */
  releaseExactExecutionOwner(
    threadId: string,
    targetCats: readonly string[],
    invocationId: string,
  ): {
    recoveredCatIds: string[];
    replacementCatIds: string[];
    ownerStates: Record<string, ExactExecutionOwnerState>;
  } {
    return this.releaseExactExecutionOwnerWith(threadId, targetCats, invocationId, (catId) =>
      this.deps.invocationTracker.completeByExecutionId(threadId, catId, invocationId),
    );
  }

  /**
   * Reaper-only release after independent durable/provider terminal proof. This
   * intentionally reaches canceled tombstones that routine terminal cleanup
   * must leave fenced until route-finally runs.
   */
  releaseExactTerminalExecutionOwner(
    threadId: string,
    targetCats: readonly string[],
    invocationId: string,
  ): {
    recoveredCatIds: string[];
    replacementCatIds: string[];
    ownerStates: Record<string, ExactExecutionOwnerState>;
  } {
    return this.releaseExactExecutionOwnerWith(threadId, targetCats, invocationId, (catId) =>
      this.deps.invocationTracker.releaseTerminalByExecutionId(threadId, catId, invocationId),
    );
  }

  private releaseExactExecutionOwnerWith(
    threadId: string,
    targetCats: readonly string[],
    invocationId: string,
    releaseTrackerOwner: (catId: string) => ExactExecutionOwnerState,
  ): {
    recoveredCatIds: string[];
    replacementCatIds: string[];
    ownerStates: Record<string, ExactExecutionOwnerState>;
  } {
    const ownerProjections = [...new Set(targetCats)].map((catId) => {
      const trackerOwnerState = releaseTrackerOwner(catId);
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

    return { recoveredCatIds, replacementCatIds, ownerStates };
  }

  /**
   * F194: Recover a parent-scoped reconciled zombie through per-cat failed-terminal
   * paths after exact projections have been fenced and retired.
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
    const recovery = this.releaseExactExecutionOwner(threadId, targetCats, invocationId);
    this.deps.log.info(
      { threadId, invocationId, ...recovery },
      '[F194] classified every parent target for owner-fenced zombie recovery',
    );
    for (const catId of recovery.recoveredCatIds) {
      await this.onInvocationComplete(threadId, catId, 'failed', invocationId, [catId]);
    }
    return recovery;
  }

  /**
   * System-level entry: called when an invocation completes.
   * F108: Now slot-aware — catId identifies which slot completed.
   * - succeeded → auto-dequeue oldest across users
   * - canceled/failed → settle exact attempt evidence, then drain any remaining work
   */
  async onInvocationComplete(
    threadId: string,
    catId: string,
    status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
    invocationId?: string,
    _completedCatIds: readonly string[] = [],
    options: {
      suppressAutomaticDrain?: boolean;
      attemptedQueueEntryIds?: readonly string[];
      suppressAutomaticFollowUp?: boolean;
    } = {},
  ): Promise<void> {
    const { suppressAutomaticDrain = false, attemptedQueueEntryIds = [], suppressAutomaticFollowUp = false } = options;
    const sk = QueueProcessor.slotKey(threadId, catId);
    const isSuperseded = (candidateCatId: string): boolean =>
      invocationId !== undefined && this.hasReplacementExecutionOwner(threadId, candidateCatId, invocationId);
    if (
      (status === 'canceled_by_user' || status === 'canceled') &&
      this.consumeAutoResumeSuppression(sk, invocationId)
    ) {
      this.deps.log.info(
        { threadId, catId, status, invocationId },
        'Auto-resume suppressed (cancelAll) — queued entries preserved but not started',
      );
      return;
    }
    if (isSuperseded(catId) || suppressAutomaticFollowUp) return;
    if (suppressAutomaticDrain) {
      this.deps.log.error(
        { threadId, catId, status, invocationId, attemptedQueueEntryIds },
        '[QueueProcessor] Queue settlement needs recovery; refusing blind same-attempt drain',
      );
      return;
    }
    if (this.hasDispatchableQueuedForThread(threadId)) {
      await this.requestDrain(
        threadId,
        this.isAutoResumeSuppressedByDifferentExecution(sk, invocationId)
          ? { bypassSuppressionForCatId: catId }
          : undefined,
      );
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

  private isAutoResumeSuppressedByDifferentExecution(slotKey: string, invocationId: string | undefined): boolean {
    if (!invocationId || this.autoResumeSuppressionRemainingMs(slotKey) === 0) return false;
    const suppression = this.suppressedAutoResume.get(slotKey);
    return Boolean(suppression && !suppression.hasAnonymousFence && !suppression.executionIds.has(invocationId));
  }

  /**
   * User-level entry: co-creator manually triggers processing their next entry.
   */
  async processNext(threadId: string, userId: string): Promise<{ started: boolean; entry?: QueueEntry }> {
    return this.tryExecuteNextForUser(threadId, userId);
  }

  /**
   * Signal the single per-thread admission coordinator. Repeated signals while
   * it is running only set dirty; the current owner must observe that bit before
   * it can retire, so enqueue/terminal/reorder races cannot lose the last wake.
   */
  requestDrain(threadId: string, options?: { bypassSuppressionForCatId?: string }): Promise<void> {
    const state = this.threadDrains.get(threadId) ?? { dirty: false };
    this.threadDrains.set(threadId, state);
    state.dirty = true;
    if (options?.bypassSuppressionForCatId) {
      if (!state.bypassSuppressionForCatIds) state.bypassSuppressionForCatIds = new Set();
      state.bypassSuppressionForCatIds.add(options.bypassSuppressionForCatId);
    }
    if (!state.owner) {
      const owner = this.runDrain(threadId, state).finally(() => {
        if (state.owner === owner) state.owner = undefined;
        if (state.dirty) void this.requestDrain(threadId);
        else this.threadDrains.delete(threadId);
      });
      state.owner = owner;
    }
    return state.owner;
  }

  private async runDrain(threadId: string, state: ThreadDrainState): Promise<void> {
    while (true) {
      state.dirty = false;
      const bypassSuppressionForCatIds = new Set(state.bypassSuppressionForCatIds);
      state.bypassSuppressionForCatIds?.clear();
      while (true) {
        const result = await this.tryExecuteNextAcrossUsers(threadId, bypassSuppressionForCatIds);
        if (!result.started && !result.progressed) break;
      }
      if (!state.dirty) return;
    }
  }

  /** Start the exact ledger rows already claimed by a Steer request. */
  async processClaimedSteerEntries(
    threadId: string,
    userId: string,
    entryIds: readonly string[],
    targetCatId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry }> {
    const entries = entryIds
      .map((entryId) => this.deps.queue.getEntrySnapshot(threadId, userId, entryId))
      .filter((entry): entry is QueueEntry => !!entry);
    if (
      entries.length !== entryIds.length ||
      entries.some(
        (entry, index) =>
          entry.id !== entryIds[index] ||
          entry.status !== 'claimed' ||
          entry.claimedTargetIds?.length !== 1 ||
          entry.claimedTargetIds[0] !== targetCatId,
      )
    ) {
      return { started: false };
    }
    const slotKey = QueueProcessor.slotKey(threadId, targetCatId);
    if (this.processingSlots.has(slotKey) || this.deps.invocationTracker.has(threadId, targetCatId)) {
      await this.deps.queue.restoreClaimedEntries(threadId, entryIds);
      return { started: false };
    }
    const [entry, ...batchMembers] = entries;
    if (!entry) return { started: false };
    if (!(await this.startReservedEntry(entry, slotKey, targetCatId, [targetCatId], false, undefined, batchMembers))) {
      return { started: false };
    }
    return { started: true, entry };
  }

  // ── Internal ──

  private hasDispatchableQueuedForThread(threadId: string): boolean {
    return this.deps.queue.hasDispatchableQueuedForThread(threadId);
  }

  private async startReservedEntry(
    entry: QueueEntry,
    slotKey: string,
    catId: string,
    executionTargetCats?: readonly string[],
    suppressAutomaticFollowUp = false,
    conversationBatchResolution?: ConversationBatchResolution,
    claimedBatchMembers: readonly QueueEntry[] = [],
  ): Promise<boolean> {
    const attemptedQueueEntryIds = [entry.id, ...claimedBatchMembers.map((candidate) => candidate.id)];

    const reservation = this.reserveProcessingSlot(slotKey, entry.id, queueEntryOwnerId(entry));

    void this.executeEntry(
      entry,
      reservation,
      executionTargetCats,
      [...claimedBatchMembers],
      conversationBatchResolution,
    ).then(
      (result) => {
        if (!this.releaseProcessingSlot(slotKey, reservation)) {
          this.deps.log.info(
            { threadId: entry.threadId, catId, entryId: entry.id, invocationId: result.invocationId },
            '[QueueProcessor] skipped stale completion side effects after processing reservation changed',
          );
          this.signalDeliveryBatchDone(entry.threadId, result.status);
          return;
        }
        void this.onInvocationComplete(entry.threadId, catId, result.status, result.invocationId, [], {
          suppressAutomaticDrain: result.primarySettlementIncomplete,
          attemptedQueueEntryIds: result.attemptedQueueEntryIds,
          suppressAutomaticFollowUp,
        }).catch(() => {});
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
          .list(entry.threadId, queueEntryOwnerId(entry))
          .some((candidate) => candidate.id === entry.id && candidate.status === 'queued');
        void this.onInvocationComplete(entry.threadId, catId, 'failed', undefined, [], {
          suppressAutomaticDrain: requeued,
          attemptedQueueEntryIds,
          suppressAutomaticFollowUp,
        }).catch(() => {});
        this.signalDeliveryBatchDone(entry.threadId, 'failed');
      },
    );
    return true;
  }

  private async tryExecuteNextAcrossUsers(
    threadId: string,
    bypassSuppressionForCatIds: ReadonlySet<string> = new Set(),
  ): Promise<QueueAdmissionAttempt> {
    const comparatorHead = this.deps.queue.peekOldestAcrossUsers(threadId);
    if (!comparatorHead) {
      this.emitContinuationDiagnostic(threadId, 'unknown', classifyContinuationOutcome(0), 0);
      return { started: false };
    }

    let resolvedTargetCats = queueEntryTargetCats(comparatorHead).filter((targetCatId) =>
      isOrdinaryQueueTargetEligible(comparatorHead, targetCatId),
    );
    let conversationBatchResolution: ConversationBatchResolution | undefined;
    if (comparatorHead.kind === 'conversation_input') {
      const routingClass = queueEntryTargetCats(comparatorHead).length === 0 ? 'targetless' : 'explicit';
      if (routingClass === 'targetless' && this.deps.invocationTracker.has(threadId)) {
        this.emitContinuationDiagnostic(threadId, 'targetless', 'all_candidate_slots_busy', 1, comparatorHead.id);
        return { started: false };
      }
      resolvedTargetCats = await this.deps.router.resolveConversationTargetsAtAdmission(
        queueEntryTargetCats(comparatorHead),
        threadId,
      );
      if (resolvedTargetCats.length === 0) {
        const terminalized = await this.terminalizeUnavailableConversationHead(comparatorHead, routingClass);
        return { started: false, progressed: terminalized !== null, ...(terminalized ? { entry: terminalized } : {}) };
      }
      conversationBatchResolution = {
        routingClass,
        requestedTargets: [...queueEntryTargetCats(comparatorHead)],
        resolvedTargets: [...resolvedTargetCats],
      };
    } else {
      resolvedTargetCats = await this.deps.router.resolveExplicitTargets(
        queueEntryTargetCats(comparatorHead),
        threadId,
      );
      if (resolvedTargetCats.length === 0) {
        const terminalized =
          comparatorHead.kind === 'private_input'
            ? await this.terminalizeUnavailablePrivateHead(comparatorHead)
            : await this.terminalizeUnavailableConversationHead(comparatorHead, 'explicit');
        return { started: false, progressed: terminalized !== null, ...(terminalized ? { entry: terminalized } : {}) };
      }
    }

    const selectedTargetCatId = resolvedTargetCats.find(
      (targetCatId) =>
        (bypassSuppressionForCatIds.has(targetCatId) || !this.isAutoResumeSuppressed(threadId, targetCatId)) &&
        !this.processingSlots.has(QueueProcessor.slotKey(threadId, targetCatId)) &&
        !this.deps.invocationTracker.has(threadId, targetCatId),
    );
    if (!selectedTargetCatId) {
      this.emitContinuationDiagnostic(
        threadId,
        resolvedTargetCats[0] ?? 'unknown',
        'all_candidate_slots_busy',
        resolvedTargetCats.length,
        comparatorHead.id,
      );
      return { started: false };
    }

    const compatiblePrefix =
      comparatorHead.kind === 'conversation_input'
        ? this.deps.queue.collectCompatibleConversationPrefix(comparatorHead, conversationBatchResolution)
        : [];
    const claimedGroup = await this.deps.queue.markProcessingGroupAcrossUsersDurable(
      threadId,
      { entryId: comparatorHead.id, targetCats: [selectedTargetCatId] },
      [comparatorHead.id, ...compatiblePrefix.map((candidate) => candidate.id)],
    );
    const entry = claimedGroup?.entry;
    if (!entry) {
      this.emitContinuationDiagnostic(threadId, resolvedTargetCats[0] ?? 'unknown', classifyContinuationOutcome(0), 0);
      return { started: false };
    }

    const entryCat = selectedTargetCatId;
    const entrySk = QueueProcessor.slotKey(threadId, entryCat);

    if (this.processingSlots.has(entrySk) || this.deps.invocationTracker.has(threadId, entryCat)) {
      await this.deps.queue.rollbackProcessingDurable(threadId, entry.id);
      this.emitContinuationDiagnostic(threadId, entryCat, 'all_candidate_slots_busy', 1, entry.id);
      return { started: false };
    }

    if (
      !(await this.startReservedEntry(
        entry,
        entrySk,
        entryCat,
        [entryCat],
        false,
        conversationBatchResolution,
        claimedGroup.members,
      ))
    ) {
      this.emitContinuationDiagnostic(threadId, entryCat, 'start_rejected', 0, entry.id);
      return { started: false };
    }

    return { started: true, entry };
  }

  /**
   * Explain why a continuation attempt started nothing while entries were waiting.
   *
   * This path returned `started: false` from three different places without a
   * trace, so a message sitting queued for minutes left no evidence at all: the
   * only nearby drain log fires just when it has candidates, and it
   * only ever considers `autoExecute` entries — user messages are not in that
   * set. Absence of that log was therefore indistinguishable between "never ran"
   * and "ran and found nothing", which is exactly the question worth answering.
   *
   * Silent when the thread has nothing queued: an empty queue needs no excuse.
   */
  private emitContinuationDiagnostic(
    threadId: string,
    catId: string,
    outcome: ContinuationOutcome,
    deferredForBusySlot: number,
    entryId?: string,
  ): void {
    const diagnostic = describeContinuationOutcome({
      threadId,
      catId,
      outcome,
      deferredForBusySlot,
      entryId,
      hasDispatchableQueued: this.hasDispatchableQueuedForThread(threadId),
    });
    if (diagnostic) this.deps.log.info(diagnostic.payload, diagnostic.message);
  }

  private async tryExecuteNextForUser(threadId: string, userId: string): Promise<QueueAdmissionAttempt> {
    const nextEntry = this.deps.queue.peekNextQueued(threadId, userId);
    if (!nextEntry) return { started: false };

    let resolvedTargetCats = queueEntryTargetCats(nextEntry).filter((catId) =>
      isOrdinaryQueueTargetEligible(nextEntry, catId),
    );
    let conversationBatchResolution: ConversationBatchResolution | undefined;
    if (nextEntry.kind === 'conversation_input') {
      const routingClass = queueEntryTargetCats(nextEntry).length === 0 ? 'targetless' : 'explicit';
      if (routingClass === 'targetless' && this.deps.invocationTracker.has(threadId)) {
        this.deps.log.info(
          { event: 'queue_not_started', threadId, entryId: nextEntry.id, reason: 'thread_active' },
          '[QueueProcessor] processNext skipped: targetless admission waits for idle thread',
        );
        return { started: false };
      }
      resolvedTargetCats = await this.deps.router.resolveConversationTargetsAtAdmission(
        queueEntryTargetCats(nextEntry),
        threadId,
      );
      if (resolvedTargetCats.length === 0) {
        const terminalized = await this.terminalizeUnavailableConversationHead(nextEntry, routingClass);
        return { started: false, progressed: terminalized !== null, ...(terminalized ? { entry: terminalized } : {}) };
      }
      conversationBatchResolution = {
        routingClass,
        requestedTargets: [...queueEntryTargetCats(nextEntry)],
        resolvedTargets: [...resolvedTargetCats],
      };
    } else {
      resolvedTargetCats = await this.deps.router.resolveExplicitTargets(queueEntryTargetCats(nextEntry), threadId);
      if (resolvedTargetCats.length === 0) {
        const terminalized =
          nextEntry.kind === 'private_input'
            ? await this.terminalizeUnavailablePrivateHead(nextEntry)
            : await this.terminalizeUnavailableConversationHead(nextEntry, 'explicit');
        return { started: false, progressed: terminalized !== null, ...(terminalized ? { entry: terminalized } : {}) };
      }
    }

    const selectedTargetCatId = resolvedTargetCats.find(
      (catId) =>
        !this.processingSlots.has(QueueProcessor.slotKey(threadId, catId)) &&
        !this.deps.invocationTracker.has(threadId, catId),
    );
    if (!selectedTargetCatId) {
      this.deps.log.info(
        { event: 'queue_not_started', threadId, entryCat: resolvedTargetCats[0], reason: 'target_busy' },
        '[QueueProcessor] processNext skipped: target slot busy',
      );
      return { started: false };
    }

    const entryCat = selectedTargetCatId;
    const sk = QueueProcessor.slotKey(threadId, entryCat);

    const compatiblePrefix =
      nextEntry.kind === 'conversation_input'
        ? this.deps.queue.collectCompatibleConversationPrefix(nextEntry, conversationBatchResolution)
        : [];
    const claimedGroup = await this.deps.queue.markProcessingGroupDurable(
      threadId,
      userId,
      { entryId: nextEntry.id, targetCats: [selectedTargetCatId] },
      [nextEntry.id, ...compatiblePrefix.map((candidate) => candidate.id)],
    );
    const entry = claimedGroup?.entry;
    if (!entry) return { started: false };

    // Fire-and-forget execution — exact reservation cleanup owns completion side effects.
    if (
      !(await this.startReservedEntry(
        entry,
        sk,
        entryCat,
        [selectedTargetCatId],
        false,
        conversationBatchResolution,
        claimedGroup.members,
      ))
    ) {
      return { started: false };
    }

    return { started: true, entry };
  }

  /**
   * Close an exact public Queue head that cannot legally form an invocation.
   * The process-local claim fences comparator ownership; MessageStore then
   * publishes the input and adjacent failure in one durable CAS transaction.
   */
  private async terminalizeUnavailableConversationHead(
    expected: QueueEntry,
    routingClass: ConversationBatchResolution['routingClass'],
  ): Promise<QueueEntry | null> {
    const claimed = await this.deps.queue.claimPreAdmissionFailureAcrossUsersDurable(expected.threadId, expected.id);
    if (!claimed) return null;
    try {
      if (!claimed.payload.messageId) {
        throw new Error(`public Queue head has no durable source message: ${claimed.id}`);
      }
      const source = await this.deps.messageStore.getById(claimed.payload.messageId);
      if (!source) {
        throw new Error(`public Queue head source message is missing: ${claimed.id}`);
      }
      const reason = routingClass === 'targetless' ? 'no_available_target' : 'invalid_explicit_target';
      const failedTargets = [...queueEntryTargetCats(claimed)];
      const wakeTargetLabel = failedTargets.length > 0 ? failedTargets.join('、') : '处理成员';
      const content =
        reason === 'no_available_target'
          ? `唤起${wakeTargetLabel}失败：当前没有可用的接收对象。`
          : `唤起${wakeTargetLabel}失败：指定的接收对象当前无效。`;
      const result = await this.deps.messageStore.commitLifecyclePreAdmissionFailure({
        sourceMessageId: source.id,
        expectedEntryId: claimed.id,
        requestedTargets: failedTargets,
        reason,
        content,
        failedAt: Math.max(Date.now(), source.timestamp),
      });
      if (result.kind !== 'applied' && result.kind !== 'replayed') {
        throw new Error(
          `pre-admission failure transaction rejected ${claimed.id}: ${result.kind}:${
            'reason' in result ? result.reason : 'missing'
          }`,
        );
      }
      const removed = await this.deps.queue.removeProcessedAcrossUsersDurable(
        claimed.threadId,
        claimed.id,
        'failed',
        'invocation_failed',
      );
      if (!removed) {
        throw new Error(`pre-admission failure transaction lost claimed Queue entry: ${claimed.id}`);
      }
      this.emitLifecycleMessageUpdated(queueEntryOwnerId(claimed), result.inputMessage);
      this.emitLifecycleMessageUpdated(queueEntryOwnerId(claimed), result.failureMessage);
      await emitQueueUpdated(
        this.deps.socketManager,
        queueEntryOwnerId(claimed),
        claimed.threadId,
        this.deps.queue.list(claimed.threadId, queueEntryOwnerId(claimed)),
        this.deps.messageStore,
        'pre_admission_failed',
      );
      this.deps.log.warn(
        { threadId: claimed.threadId, entryId: claimed.id, routingClass, reason },
        '[QueueProcessor] public Queue head terminalized before admission',
      );
      return removed;
    } catch (error) {
      await this.deps.queue.rollbackProcessingDurable(claimed.threadId, claimed.id);
      throw error;
    }
  }

  /**
   * Close an exact private Queue head without publishing its body or a History result.
   * The structured internal diagnostic is the only lifecycle projection owned here;
   * any typed source owner remains responsible for its own terminal disposition.
   */
  private async terminalizeUnavailablePrivateHead(expected: QueueEntry): Promise<QueueEntry | null> {
    const claimed = await this.deps.queue.claimPreAdmissionFailureAcrossUsersDurable(expected.threadId, expected.id);
    if (!claimed) return null;
    if (claimed.kind !== 'private_input') {
      await this.deps.queue.rollbackProcessingDurable(claimed.threadId, claimed.id);
      throw new Error(`private pre-admission terminalization received ${claimed.kind}: ${claimed.id}`);
    }
    const removed = await this.deps.queue.removeProcessedAcrossUsersDurable(
      claimed.threadId,
      claimed.id,
      'failed',
      'invocation_failed',
    );
    if (!removed) {
      await this.deps.queue.rollbackProcessingDurable(claimed.threadId, claimed.id);
      throw new Error(`private pre-admission terminalization lost claimed Queue entry: ${claimed.id}`);
    }
    this.deps.log.warn(
      {
        event: 'private_input_pre_admission_failed',
        threadId: claimed.threadId,
        entryId: claimed.id,
        requestedTargets: [...queueEntryTargetCats(claimed)],
        reason: 'invalid_explicit_target',
      },
      '[QueueProcessor] private Queue head terminalized before admission',
    );
    try {
      await emitQueueUpdated(
        this.deps.socketManager,
        queueEntryOwnerId(claimed),
        claimed.threadId,
        this.deps.queue.list(claimed.threadId, queueEntryOwnerId(claimed)),
        this.deps.messageStore,
        'pre_admission_failed',
      );
    } catch (error) {
      this.deps.log.error(
        { error, threadId: claimed.threadId, entryId: claimed.id },
        '[QueueProcessor] private pre-admission terminal notification failed after exact removal',
      );
    }
    return removed;
  }

  /**
   * Execute a queue entry — mirrors messages.ts background invocation pipeline.
   * Creates InvocationRecord → tracker.start → route execution → complete → cleanup.
   * Returns final status for chain auto-dequeue (called by tryExecuteNext*).
   */
  private async executeEntry(
    entry: QueueEntry,
    processingReservation?: ProcessingSlotReservation,
    executionTargetCats?: readonly string[],
    exactBatchEntries: readonly QueueEntry[] = [],
    conversationBatchResolution?: ConversationBatchResolution,
  ): Promise<QueueExecutionResult> {
    const { queue, invocationTracker, invocationRecordStore, router, socketManager, messageStore, log } = this.deps;
    const threadId = entry.threadId;
    const userId = queueEntryOwnerId(entry);
    const intent = entry.execution.intent;
    const messageId = entry.payload.messageId;
    const targetCats = [...(executionTargetCats ?? queueEntryTargetCats(entry))];
    const primaryCat = targetCats[0] ?? 'unknown';

    const batchedEntryIds: string[] = exactBatchEntries.map((candidate) => candidate.id);
    const batchedMessageIds: string[] = exactBatchEntries.flatMap(queueEntryMessageIds);
    let content = entry.payload.content;

    let controller: AbortController | undefined;
    let invocationId: string | undefined;
    let expectedInvocationStatus: InvocationStatus = 'queued';
    let finalStatus: InvocationFinalStatus = 'failed';
    let replayClaimLost = false;
    let processingReservationReplaced = false;
    const terminalDispositions = new PerCatTerminalDispositionCollector({
      targetCatIds: targetCats,
      isCanceled: (catId) => invocationTracker.getSlotState?.(threadId, catId) === 'canceled',
    });
    let responseText = '';
    // F122B B6: completion hooks are registered before drain; keep their
    // target-partitioned response buffer alive through finally settlement.
    const entryCompleteHooks = (this.entryCompleteHooks.get(entry.id) ?? []).filter(
      (registration) => !registration.targetCatId || targetCats.includes(registration.targetCatId),
    );
    const hookResponseTextByTarget = new Map<string, string>();
    const cursorBoundaries = new Map<string, string>();
    const continuationCapsules = new Map<string, CollaborationContinuityCapsuleV1>();
    // Cloud Codex P2: track consumed continuation so we can re-store on failure/cancel.
    let consumedContinuation: ConsumedContinuationToken | undefined;
    // R4 fix: hoist streamStartPromise above try so the catch block can await it
    // before calling onStreamEnd → cleanupPlaceholders (the correct failure cleanup
    // sequence per messages.ts cleanupStreamingOnFailure).
    let streamStartPromise: Promise<void> | undefined;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    let executionError: unknown;
    let freshnessSupplementOriginalMessageId: string | undefined;
    let freshnessSupplementRequiredMessageIds: string[] = [];
    let supplementToolExecutionPolicy = entry.execution.readOnlyToolPolicy;
    const bufferedSupplementMessages: unknown[] = [];
    let actionFencePreflightRejected = false;
    let actionFenceAggregateSucceeded = false;
    const actionFenceCommittedHolderCatIds = new Set<string>();
    const actionFenceOutputValidatedHolderCatIds = new Set<string>();
    const lifecycleInputMessageIds = [
      ...(entry.payload.messageId ? [entry.payload.messageId] : []),
      ...batchedMessageIds,
    ];
    const lifecycleResponseMessageIds = new Set<string>();
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
      const result: QueueExecutionResult = {
        status,
        ...(invocationId ? { invocationId } : {}),
        attemptedQueueEntryIds: [entry.id, ...batchedEntryIds],
      };
      returnedExecutionResult = result;
      return result;
    };
    const finalizeActionFenceOutcome = async (
      outcome: 'failed' | 'canceled',
      hasResponse: boolean,
      catIds: readonly string[] = [primaryCat],
    ): Promise<boolean> => {
      const fence = entry.execution.actionSuccessorFence;
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
      const fence = entry.execution.actionSuccessorFence;
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
      if (entry.execution.actionSuccessorFence) {
        const leaseStore = this.deps.actionSuccessorLeaseStore;
        if (!leaseStore) {
          log.error(
            { threadId, entryId: entry.id, leaseId: entry.execution.actionSuccessorFence.leaseId },
            '[F167-S] action successor lease store unavailable; canceling fenced queue entry',
          );
          actionFencePreflightRejected = true;
          finalStatus = 'canceled';
          await this.cancelMessageIds(queueEntryMessageIds(entry), log, 'start_preflight_store_unavailable');
          return executionResult('canceled');
        }
        try {
          const preflight = await leaseStore.preflight(
            entry.execution.actionSuccessorFence.leaseId,
            entry.execution.actionSuccessorFence.generation,
            entry.execution.actionSuccessorFence.terminalPredicateDigest,
          );
          if (!preflight.ok) {
            log.info(
              {
                threadId,
                entryId: entry.id,
                leaseId: entry.execution.actionSuccessorFence.leaseId,
                generation: entry.execution.actionSuccessorFence.generation,
                reason: preflight.reason,
              },
              '[F167-S] action successor canceled at queue preflight',
            );
            actionFencePreflightRejected = true;
            finalStatus = 'canceled';
            await this.cancelMessageIds(queueEntryMessageIds(entry), log, 'start_preflight_rejected');
            return executionResult('canceled');
          }
        } catch (err) {
          log.error(
            { err, threadId, entryId: entry.id, leaseId: entry.execution.actionSuccessorFence.leaseId },
            '[F167-S] action successor preflight failed; canceling fenced queue entry',
          );
          actionFencePreflightRejected = true;
          finalStatus = 'canceled';
          await this.cancelMessageIds(queueEntryMessageIds(entry), log, 'start_preflight_error');
          return executionResult('canceled');
        }
      }

      // 1. Create InvocationRecord (before batching — avoid claiming entries on duplicate)
      // Invocation identity is source × target: one source row can dispatch its
      // pending targets independently without treating a sibling as a replay.
      const source = queueEntrySource(entry);
      const connectorReplayCarrier = source === 'connector' || entry.sourceCategory === 'scheduled';
      const actionSuccessorKey =
        entry.execution.actionSuccessorFence && entry.payload.sourceRecordId
          ? actionSuccessorInvocationIdempotencyKey(entry.payload.sourceRecordId)
          : undefined;
      const idempotencyKey =
        connectorReplayCarrier && messageId
          ? `connector-${messageId}:${primaryCat}`
          : actionSuccessorKey
            ? actionSuccessorKey.endsWith(`:${primaryCat}`)
              ? actionSuccessorKey
              : `${actionSuccessorKey}:${primaryCat}`
            : `queue-${entry.id}:${primaryCat}`;
      const actionLeaseCarrier: InvocationActionLeaseCarrier = entry.execution.actionSuccessorFence
        ? {
            kind: 'action_successor',
            leaseId: entry.execution.actionSuccessorFence.leaseId,
            generation: entry.execution.actionSuccessorFence.generation,
          }
        : { kind: 'none' };
      const createResult = await invocationRecordStore.create({
        threadId,
        userId,
        targetCats,
        intent,
        idempotencyKey,
        actionLeaseCarrier,
        ...(entry.execution.waitContinuationCarrier
          ? { waitContinuationCarrier: entry.execution.waitContinuationCarrier }
          : {}),
      });

      invocationId = createResult.invocationId;
      if (createResult.outcome === 'duplicate') {
        const replayEligible =
          (connectorReplayCarrier && Boolean(messageId)) || Boolean(entry.execution.actionSuccessorFence);
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
            ...(entry.execution.waitContinuationCarrier
              ? { waitContinuationCarrier: entry.execution.waitContinuationCarrier }
              : {}),
          })
        ) {
          log.warn({ threadId, entryId: entry.id }, '[QueueProcessor] Duplicate invocation, skipping');
          if (entry.execution.freshnessSupplementId && this.deps.freshnessClosureStore) {
            const supplement = await this.deps.freshnessClosureStore.getSupplement(
              entry.execution.freshnessSupplementId,
            );
            if (supplement?.status === 'pending') {
              const failed = await this.deps.freshnessClosureStore.failSupplement(supplement.id, {
                reason: 'infrastructure',
                now: Date.now(),
              });
              this.broadcastFreshnessSupplement(failed);
            }
          }
          // This attempt did not create, replay, or run the duplicate invocation.
          // Never forward another owner's invocationId into onInvocationComplete:
          // exact queued_seen evidence may belong to that invocation and would be
          // falsely settled by this carrier-only retirement.
          invocationId = undefined;
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
        processingReservationReplaced = true;
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
      if (entry.execution.freshnessSupplementId) {
        const supplementStore = this.deps.freshnessClosureStore;
        if (!supplementStore) {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: 'freshness supplement store unavailable',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }
        if (entry.execution.freshnessClosureId) {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: 'queue entry cannot carry both freshness closure and supplement identities',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }
        const supplement = await supplementStore.getSupplement(entry.execution.freshnessSupplementId);
        // External replacement retires the exact Queue reservation synchronously, but
        // `getSupplement()` can still be awaiting durable state when that happens. Fence
        // immediately after the await, before interpreting or mutating supplement truth;
        // otherwise this stale coroutine can report a generic carrier cancellation (or
        // race a claim) instead of closing its own InvocationRecord as superseded.
        if (
          processingReservation &&
          !this.canStartReservedTargetSet(threadId, targetCats, primaryCat, processingReservation, invocationId)
        ) {
          processingReservationReplaced = true;
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
              supplementId: entry.execution.freshnessSupplementId,
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
          entry.execution.freshnessSupplementLineageId !== supplement.lineageId ||
          entry.execution.freshnessSupplementSeq !== supplement.seq;
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
        if (entry.execution.readOnlyToolPolicy?.mode !== 'read_only') {
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
      if (entry.execution.freshnessClosureId) {
        const closureStore = this.deps.freshnessClosureStore;
        if (!closureStore) {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            error: 'freshness closure store unavailable',
          });
          finalStatus = 'failed';
          return executionResult('failed');
        }
        const closure = await closureStore.get(entry.execution.freshnessClosureId);
        if (!closure || closure.status !== 'pending') {
          recordFreshnessSuccessorPreflightCanceled(closure?.status ?? 'missing');
          log.info(
            {
              threadId,
              entryId: entry.id,
              closureId: entry.execution.freshnessClosureId,
              status: closure?.status ?? 'missing',
            },
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

      // F194 R7: freshness/action carrier preflight can await after the reservation
      // binds. Re-fence the complete target set immediately before tracker
      // registration: the primary must still own its exact reservation, and every
      // secondary target must still be free. The first attempt is synchronous; if a
      // session-seal CAS rejects admission, the retry path below re-fences the exact
      // processing reservation after waiting for the guard to release.
      if (
        processingReservation &&
        !this.canStartReservedTargetSet(threadId, targetCats, primaryCat, processingReservation, invocationId)
      ) {
        processingReservationReplaced = true;
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
      controller = invocationTracker.startAll(threadId, targetCats, userId, invocationId) ?? undefined;
      while (!controller) {
        log.info(
          { threadId, entryId: entry.id, invocationId, targetCats },
          '[QueueProcessor] queued admission parked behind session-seal CAS',
        );
        await invocationTracker.waitForSessionSealRelease(threadId, targetCats);
        if (
          processingReservation &&
          !this.canStartReservedTargetSet(threadId, targetCats, primaryCat, processingReservation, invocationId)
        ) {
          processingReservationReplaced = true;
          log.info(
            { threadId, entryId: entry.id, invocationId },
            '[QueueProcessor] canceled parked execution after its processing reservation was replaced',
          );
          await invocationRecordStore.update(invocationId, {
            status: 'canceled',
            error: 'queue_processing_reservation_replaced',
          });
          finalStatus = 'canceled';
          return executionResult('canceled');
        }
        controller = invocationTracker.startAll(threadId, targetCats, userId, invocationId) ?? undefined;
      }
      if (processingReservation) processingReservation.trackerStarted = true;

      // F216 c3: supersede tombstone guard. If a same-turn follow-up arrived during the
      // pre-start window (between markProcessingById and startAll), callback-a2a-trigger
      // removed this entry as a tombstone signal. Detect it here and self-abort before
      // routeExecution — the follow-up is already queued and will run after this returns.
      //
      // Status: 'canceled_by_user' (not plain 'canceled') so onInvocationComplete normally
      // takes the immediate-restart branch (requestDrain) rather than the 10s delay
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

      // F220 Phase 1: intent_mode stays deferred until the first CLI event (#768);
      // spawn_started is only "process is being spawned".
      if (!controller.signal.aborted) {
        socketManager.broadcastToRoom(`thread:${threadId}`, 'spawn_started', {
          threadId,
          targetCats,
          invocationId,
        });
      }

      // 5. intent_mode deferred to first CLI event (#768: avoid "replying" when CLI never starts)
      let intentModeBroadcast = false;

      for (const queueEntryId of [entry.id, ...batchedEntryIds]) {
        const queueEntry =
          queue.getEntrySnapshot(threadId, userId, queueEntryId) ?? (queueEntryId === entry.id ? entry : null);
        if (queueEntry) {
          await this.ensureAttemptMessageCustody(queueEntry);
        }
      }
      // 6b. F224: single-cat continuation lifecycle is owned by
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
              entry.payload.sourceRecordId === QueueProcessor.continuationKey(capsule);
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
      // Preserve every ledger row as a separate persisted prompt message; never
      // concatenate independent authors or message identities into one body.
      const messageIds = [...new Set([messageId ?? '', ...batchedMessageIds].filter(Boolean))];
      const contentBlocks: MessageContent[] = [];
      const persistedPromptMessages: PersistedPromptMessage[] = [];
      const asrPersonMemoryScenes: Array<
        import('../../../../memory/people/AsrPersonMemoryOpportunityPromptService.js').BoundAsrPersonMemoryScene
      > = [];
      for (const id of messageIds) {
        try {
          const stored = await messageStore.getById(id);
          if (stored) {
            if (stored.extra?.messageBundle) {
              if (!this.deps.threadStore?.get) {
                throw new MessageBundlePromptUnavailableError('thread_store_unavailable');
              }
              const bundlePrompt = await resolveMessageBundlePrompt({
                bundleMessageId: stored.id,
                forwarderUserId: stored.userId,
                carrier: stored.extra.messageBundle,
                messageStore,
                threadStore: { get: (threadId) => this.deps.threadStore!.get!(threadId) },
              });
              if (bundlePrompt.status !== 'ready') {
                throw new MessageBundlePromptUnavailableError(bundlePrompt.reason);
              }
              persistedPromptMessages.push({
                messageId: id,
                content: bundlePrompt.content,
                forceExplicitProjection: true,
              });
              continue;
            }
            persistedPromptMessages.push({
              messageId: id,
              content: stored.content,
              ...(stored.contentBlocks?.length ? { contentBlocks: stored.contentBlocks } : {}),
            });
            asrPersonMemoryScenes.push(
              ...bindAsrPersonMemoryScenesFromQueueMessage(stored, { ownerUserId: userId, threadId }),
            );
            asrPersonMemoryScenes.push(
              ...(await bindAsrPersonMemoryReentryFromSchedulerMessage({
                triggerMessage: stored,
                ownerUserId: userId,
                threadId,
                targetCatId: primaryCat,
                messageStore,
              })),
            );
            asrPersonMemoryScenes.push(
              ...(await bindAsrPersonMemoryPresentationRetryFromSchedulerMessage({
                triggerMessage: stored,
                ownerUserId: userId,
                threadId,
                targetCatId: primaryCat,
                messageStore,
              })),
            );
          }
          if (stored?.contentBlocks && stored.contentBlocks.length > 0) {
            contentBlocks.push(...stored.contentBlocks);
          }
        } catch (err) {
          if (err instanceof MessageBundlePromptUnavailableError) throw err;
          log.warn(
            { threadId, entryId: entry.id, messageId: id, err },
            '[QueueProcessor] messageStore.getById failed, degrading to text-only execution',
          );
        }
      }
      // F088 fix: start streaming placeholder on external platforms
      if (this.deps.streamingHook && !entry.execution.actionSuccessorFence && !entry.execution.freshnessSupplementId) {
        streamStartPromise = this.deps.streamingHook
          .onStreamStart(threadId, primaryCat, invocationId, queueEntrySenderMeta(entry))
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
          entrySource: queueEntrySource(entry),
          messageId: messageId ?? null,
          expectedThreadId: threadId,
          expectedUserId: userId,
          messageStore,
        });
      } catch (err) {
        log.warn({ err, threadId, entryId: entry.id }, '[F287] connector Cue carrier read failed closed');
      }

      const admissionEntries = [entry.id, ...batchedEntryIds].map((entryId) => {
        const current = queue.getEntrySnapshot(threadId, userId, entryId);
        if (!current || current.status !== 'claimed') {
          throw new Error(`Queue admission requires one exact claimed owner: ${entryId}`);
        }
        return current;
      });
      await this.admitQueueEntriesForProvider(admissionEntries);
      // Publish processing only after the same durable admission moved the
      // source into History and retired its Queue custody. Emitting before
      // admission left browsers holding a stale queued row for the full run.
      await emitQueueUpdated(socketManager, userId, threadId, queue.list(threadId, userId), messageStore, 'processing');

      const HEARTBEAT_INTERVAL_MS = 30_000;
      heartbeatInterval = setInterval(() => {
        socketManager.broadcastToRoom(`thread:${threadId}`, 'heartbeat', {
          threadId,
          timestamp: Date.now(),
        });
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatInterval.unref();

      for await (const msg of router.routeExecution(
        userId,
        content,
        threadId,
        entry.execution.cloudDispatchProvenance?.sourceMessageId ?? messageId ?? null,
        targetCats,
        {
          intent,
          ...(entry.execution.suggestedSkill ? { promptTags: [`skill:${entry.execution.suggestedSkill}`] } : {}),
        },
        {
          ownerAuthProvenance: entry.execution.ownerAuthProvenance,
          humanDispositionInvocationOrigin: 'queue_replay',
          ...(memoryCueOpportunitySeeds.length > 0 ? { memoryCueOpportunitySeeds } : {}),
          ...(asrPersonMemoryScenes.length > 0 ? { asrPersonMemoryScenes } : {}),
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
          getQueuedFreshnessMessagesForCat: (tid: string, uid: string, catId: string, parentInvocationId?: string) =>
            queue.getQueuedFreshnessMessagesForCat(tid, uid, catId, { excludeEntryId: entry.id, parentInvocationId }),
          commitCompletedA2AWake: (input: Parameters<NonNullable<RouteOptions['commitCompletedA2AWake']>>[0]) =>
            commitCompletedResponseAndEnqueueA2ATargets(
              {
                socketManager: this.deps.socketManager,
                invocationTracker: this.deps.invocationTracker,
                ...(this.deps.deliveryCursorStore ? { deliveryCursorStore: this.deps.deliveryCursorStore } : {}),
                queueProcessor: this,
                messageStore,
                invocationQueue: queue,
                log,
              },
              input,
            ),
          commitFailedA2AReport: (input: Parameters<NonNullable<RouteOptions['commitFailedA2AReport']>>[0]) =>
            commitFailedResponseAndEnqueueA2ACaller(
              {
                socketManager: this.deps.socketManager,
                invocationTracker: this.deps.invocationTracker,
                ...(this.deps.deliveryCursorStore ? { deliveryCursorStore: this.deps.deliveryCursorStore } : {}),
                queueProcessor: this,
                messageStore,
                invocationQueue: queue,
                log,
              },
              input,
            ),
          ...(entry.sourceCategory === 'a2a_failure' ? { a2aFailureReport: true } : {}),
          // F254 B3: freshness re-invoke enqueue — strips freshnessContext before queueing
          // (queue only stores standard QueueEntry fields; context is for event-log correlation).
          freshnessReinvokeEnqueue: (e: any) => {
            const { freshnessContext: _ctx, ...queueFields } = e;
            return queue.enqueueDurable({
              ...queueFields,
              kind: 'private_input',
              ownerAuthProvenance: entry.execution.ownerAuthProvenance,
              sourceId:
                queueFields.idempotencyKey ??
                queueFields.freshnessSupplementId ??
                queueFields.freshnessClosureId ??
                `freshness-reinvoke:${queueFields.threadId}:${queueFields.from.catId}:${queueFields.freshnessContext?.sourceNoticeIds?.join(',') ?? ''}`,
            });
          },
          hasPendingForCat: (tid: string, uid: string, catId: string) =>
            queue.hasPendingForCat(tid, catId, { excludeEntryId: entry.id, userId: uid }),
          cursorBoundaries,
          persistenceContext,
          ...(invocationId ? { parentInvocationId: invocationId } : {}),
          persistedPromptMessageIds: messageIds,
          // F063: this is the authoritative per-message hydration subset. Passing
          // an explicit empty/partial array prevents the aggregate raw batch text
          // from becoming either a prompt fallback or durable exposure evidence.
          persistedPromptMessages,
          onLifecycleInvocationStarted: async (
            input: Parameters<NonNullable<RouteOptions['onLifecycleInvocationStarted']>>[0],
          ) => {
            const lifecycleInputMessages = (
              await Promise.all(messageIds.map((inputMessageId) => messageStore.getById(inputMessageId)))
            ).filter((message): message is StoredMessage =>
              Boolean(
                message &&
                  isTimelinePublished(message) &&
                  message.visibility !== 'whisper' &&
                  !message.recall &&
                  !message._tombstone,
              ),
            );
            const lifecycleReplyToCandidate = entry.execution.a2aTriggerMessageId ?? messageId;
            const lifecycleReplyTo = lifecycleInputMessages.some((message) => message.id === lifecycleReplyToCandidate)
              ? lifecycleReplyToCandidate
              : undefined;
            const observed = await messageStore.appendAndObservePriorFrontier({
              from: { kind: 'agent', catId: input.catId },
              userId: input.userId,
              content: '',
              mentions: [],
              origin: 'stream',
              timestamp: input.startedAt,
              threadId: input.threadId,
              ...(lifecycleReplyTo ? { replyTo: lifecycleReplyTo } : {}),
              idempotencyKey: `message-lifecycle-response:${input.invocationId}`,
              extra: {
                stream: {
                  invocationId: input.parentInvocationId,
                  turnInvocationId: input.invocationId,
                },
              },
              lifecycle: {
                kind: 'response',
                orderKey: `${input.startedAt}:${input.invocationId}`,
                invocationId: input.invocationId,
                targetId: input.catId,
                inputEntryIds: admissionEntries.map((candidate) => candidate.id),
                inputMessageIds: lifecycleInputMessages.map((message) => message.id),
                status: 'processing',
                startedAt: input.startedAt,
              },
            });
            if (
              observed.message.lifecycle?.kind !== 'response' ||
              observed.message.lifecycle.invocationId !== input.invocationId ||
              observed.message.lifecycle.status !== 'processing'
            ) {
              throw new Error(`Lifecycle response admission conflict: ${input.invocationId}`);
            }
            lifecycleResponseMessageIds.add(observed.message.id);
            const lifecycleInputSnapshots: StoredMessage[] = [];
            for (const inputMessage of lifecycleInputMessages) {
              const transition = await messageStore.advanceLifecycleInputDispatch(inputMessage.id, {
                ...lifecycleInputIdentityForStoredMessage(inputMessage),
                targetId: input.catId,
                phase: 'dispatched',
                statusMessageId: observed.message.id,
                dispatchedAt: input.startedAt,
              });
              if (transition.kind !== 'applied' && transition.kind !== 'replayed') {
                await messageStore.commitLifecycleResponseTerminal(observed.message.id, {
                  invocationId: input.invocationId,
                  status: 'interrupted',
                  completedAt: Date.now(),
                  reason: 'input_dispatch_projection_conflict',
                  content: '',
                  extra: observed.message.extra,
                  mentions: [],
                  origin: 'stream',
                });
                throw new Error(
                  `Lifecycle input dispatch conflict: ${inputMessage.id}:${transition.kind}:${'reason' in transition ? transition.reason : 'missing'}`,
                );
              }
              lifecycleInputSnapshots.push(transition.message);
            }
            const activeRun: LifecycleActiveRun = {
              threadId: input.threadId,
              targetId: input.catId,
              invocationId: input.invocationId,
              responseMessageId: observed.message.id,
              inputEntryIds: admissionEntries.map((candidate) => candidate.id),
              inputMessageIds: lifecycleInputMessages.map((message) => message.id),
              privateInputEntryIds: admissionEntries
                .filter((candidate) => candidate.kind === 'private_input')
                .map((candidate) => candidate.id),
              startedAt: input.startedAt,
            };
            if (
              invocationTracker.bindLifecycleActiveRun &&
              !invocationTracker.bindLifecycleActiveRun(activeRun, input.parentInvocationId)
            ) {
              await messageStore.commitLifecycleResponseTerminal(observed.message.id, {
                invocationId: input.invocationId,
                status: 'interrupted',
                completedAt: Date.now(),
                reason: 'active_run_owner_mismatch',
                content: '',
                extra: observed.message.extra,
                mentions: [],
                origin: 'stream',
              });
              throw new Error(`Lifecycle ActiveRun owner mismatch: ${input.invocationId}`);
            }
            await this.markPromptMessagesAwakened({
              threadId: input.threadId,
              userId: input.userId,
              catId: input.catId,
              invocationId: input.invocationId,
              messageIds: [
                ...new Set(
                  admissionEntries
                    .map((candidate) => candidate.payload.messageId)
                    .filter((messageId): messageId is string => typeof messageId === 'string'),
                ),
              ],
              awakenedAt: input.startedAt,
            });
            for (const inputSnapshot of lifecycleInputSnapshots) {
              this.emitLifecycleMessageUpdated(input.userId, inputSnapshot);
            }
            this.emitLifecycleMessageUpdated(input.userId, observed.message);
            return {
              responseMessageId: observed.message.id,
              priorFrontierMessageId: observed.priorFrontierMessageId,
              activeRun,
            };
          },
          onAgentClientActiveRunReady: (
            input: Parameters<NonNullable<RouteOptions['onAgentClientActiveRunReady']>>[0],
          ) => {
            const { catId, dispatcher } = input;
            const release = invocationTracker.bindAgentClientActiveRunDispatcher?.(
              threadId,
              catId,
              dispatcher,
              invocationId,
            );
            if (!release) {
              throw new Error(`Agent Client ActiveRun dispatcher owner mismatch: ${dispatcher.invocationId}`);
            }
            return release;
          },
          onPromptMessagesExposed: (input: PromptMessagesExposedInput) => this.markPromptMessagesSeen(input),
          ...(freshnessSupplementOriginalMessageId
            ? { a2aTriggerMessageId: freshnessSupplementOriginalMessageId }
            : entry.execution.a2aTriggerMessageId
              ? { a2aTriggerMessageId: entry.execution.a2aTriggerMessageId }
              : {}),
          ...((freshnessSupplementOriginalMessageId || entry.execution.a2aTriggerMessageId) &&
          queueEntryCallerCatId(entry)
            ? { a2aCallerCatId: queueEntryCallerCatId(entry) }
            : {}),
          ...(entry.execution.callerTraceContext ? { callerTraceContext: entry.execution.callerTraceContext } : {}),
          ...(entry.execution.cloudDispatchProvenance
            ? { cloudDispatchProvenance: entry.execution.cloudDispatchProvenance }
            : {}),
          ...(entry.execution.requiresExactCloudDispatchProvenance
            ? { requiresExactCloudDispatchProvenance: true }
            : {}),
          ...(entry.execution.freshnessClosureId
            ? {
                freshnessClosureId: entry.execution.freshnessClosureId,
                freshnessClosureRequiredMessageIds:
                  (await this.deps.freshnessClosureStore?.get(entry.execution.freshnessClosureId))
                    ?.requiredMessageIds ?? [],
              }
            : {}),
          ...(entry.execution.freshnessSupplementId
            ? {
                freshnessSupplementId: entry.execution.freshnessSupplementId,
                freshnessSupplementRequiredMessageIds,
                toolExecutionPolicy: supplementToolExecutionPolicy,
              }
            : {}),
          // F222 P1: Only user-originated queue entries trigger frustration detection.
          // Whitelist (not blacklist) — agent + connector sources both suppressed.
          frustrationAutoIssueEligible: entry.from.kind === 'user',
          // User and A2A turns own conversational ball-pass expectations. Connector
          // wakes and private system computations do not.
          verdictPassWarningEnabled: entry.from.kind === 'user' || entry.from.kind === 'agent',
          ...(entry.execution.actionSuccessorFence
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
        if (!intentModeBroadcast && !entry.execution.actionSuccessorFence) {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', {
            threadId,
            mode: intent,
            targetCats,
            invocationId,
          });
          intentModeBroadcast = true;
        }
        if (
          entryCompleteHooks.length > 0 &&
          msg.catId === primaryCat &&
          msg.type === 'text' &&
          (msg as { content?: string }).content
        ) {
          responseText = accumulateTextAggregate(
            responseText,
            (msg as { content?: string }).content!,
            (msg as { textMode?: 'append' | 'replace' }).textMode,
          );
        } else if (
          entryCompleteHooks.length > 0 &&
          entry.execution.requiresExactCloudDispatchProvenance &&
          msg.catId === primaryCat &&
          msg.type === 'system_info' &&
          (msg as { content?: string }).content
        ) {
          const visibleNotice = userFacingSystemInfoNoticeContent((msg as { content?: string }).content!, primaryCat);
          if (visibleNotice) responseText = accumulateTextAggregate(responseText, visibleNotice, 'append');
        }
        if (
          entryCompleteHooks.length > 0 &&
          msg.catId &&
          msg.type === 'text' &&
          (msg as { content?: string }).content
        ) {
          hookResponseTextByTarget.set(
            msg.catId,
            accumulateTextAggregate(
              hookResponseTextByTarget.get(msg.catId) ?? '',
              (msg as { content?: string }).content!,
              (msg as { textMode?: 'append' | 'replace' }).textMode,
            ),
          );
        } else if (
          entryCompleteHooks.length > 0 &&
          entry.execution.requiresExactCloudDispatchProvenance &&
          msg.catId &&
          msg.type === 'system_info' &&
          (msg as { content?: string }).content
        ) {
          const visibleNotice = userFacingSystemInfoNoticeContent((msg as { content?: string }).content!, msg.catId);
          if (visibleNotice) {
            hookResponseTextByTarget.set(
              msg.catId,
              accumulateTextAggregate(hookResponseTextByTarget.get(msg.catId) ?? '', visibleNotice, 'append'),
            );
          }
        }
        const continuationCapsule = extractContinuityCapsuleFromAgentMessage(msg);
        if (continuationCapsule) {
          continuationCapsules.set(continuationCapsule.catId, continuationCapsule);
        }
        terminalDispositions.observe(msg);
        if (isTerminalDispositionEvent(msg) && msg.catId) {
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
          if (this.deps.outboundHook && !entry.execution.actionSuccessorFence) {
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
          if (
            this.deps.streamingHook &&
            !entry.execution.actionSuccessorFence &&
            !entry.execution.freshnessSupplementId
          ) {
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
        if (entry.execution.actionSuccessorFence) {
          bufferedActionMessages.push(visibleMessage);
        } else if (entry.execution.freshnessSupplementId) {
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
          const entryCat = queueEntryTargetCats(entry)[0] ?? 'unknown';
          this.suppressAutoResume(threadId, entryCat, [invocationId]);
        }
        await this.cleanupStreamingOnFailure(threadId, invocationId, streamStartPromise, log);
        return executionResult(finalStatus);
      }

      if (persistenceContext.failed) {
        const errorDetail = persistenceContext.errors.map((error) => `${error.catId}: ${error.error}`).join('; ');
        await invocationRecordStore.update(invocationId, {
          status: 'failed',
          error: `Message delivered but persistence failed: ${errorDetail}`,
        });
        socketManager.broadcastAgentMessage(
          {
            type: 'error',
            catId: primaryCat,
            error: '消息已发送但未能保存，刷新后可能丢失。可点击重试。',
            timestamp: Date.now(),
          },
          threadId,
        );
        const pushService = this.deps.getPushService?.();
        if (pushService) {
          void pushService
            .notifyUser(userId, {
              title: '猫猫消息保存失败',
              body: '消息已发送但未能保存，请检查',
              tag: `cat-error-${threadId}`,
              data: { threadId, url: `/?thread=${threadId}` },
            })
            .catch((pushErr) =>
              log.warn({ err: pushErr, threadId }, '[QueueProcessor] persistence failure push notification failed'),
            );
        }
        finalStatus = 'failed';
        await this.cleanupStreamingOnFailure(threadId, invocationId, streamStartPromise, log);
        return executionResult('failed');
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

      if (!entry.execution.actionSuccessorFence && terminalDispositions.getSuccessfulCatIds().length === 0) {
        throw new Error(
          terminalDispositions.getPrimaryTerminalError() ?? 'all targeted cats completed without a success witness',
        );
      }

      if (entry.execution.actionSuccessorFence) {
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
              leaseId: entry.execution.actionSuccessorFence.leaseId,
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
              leaseId: entry.execution.actionSuccessorFence.leaseId,
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
            .onStreamStart(threadId, primaryCat, invocationId, queueEntrySenderMeta(entry))
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
      const adoptedClosureDecision = entry.execution.freshnessClosureId
        ? persistenceContext.outputCommitDecisions?.[primaryCat]
        : undefined;
      const adoptedClosureStatus =
        adoptedClosureDecision?.kind === 'committed_fresh' &&
        adoptedClosureDecision.closureId === entry.execution.freshnessClosureId
          ? 'committed'
          : adoptedClosureDecision?.kind === 'superseded_positive_stale' &&
              adoptedClosureDecision.closureId === entry.execution.freshnessClosureId
            ? 'pending'
            : adoptedClosureDecision?.kind === 'blocked_known_closure' &&
                adoptedClosureDecision.closureId === entry.execution.freshnessClosureId
              ? 'blocked'
              : undefined;
      let freshnessSupplementStatus: 'committed' | 'declined' | undefined;
      if (entry.execution.freshnessSupplementId && this.deps.freshnessClosureStore) {
        let supplement = await this.deps.freshnessClosureStore.getSupplement(entry.execution.freshnessSupplementId);
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
                freshnessSupplementId: entry.execution.freshnessSupplementId,
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

      if (entry.from.kind === 'user') {
        const pushService = this.deps.getPushService?.();
        if (pushService) {
          const pushTurns = outboundTurns.filter((turn) =>
            isConnectorDeliverable(persistenceContext.outputCommitDecisions?.[turn.catId]),
          );
          const assistantText = (
            outboundTurns.length > 0
              ? flattenTurnTextParts(pushTurns)
              : isConnectorDeliverable(persistenceContext.outputCommitDecisions?.[primaryCat])
                ? flattenTextParts(collectedTextParts)
                : ''
          ).trim();
          const hasKnownUndeliverableOutput = Object.values(persistenceContext.outputCommitDecisions ?? {}).some(
            (decision) => !isConnectorDeliverable(decision),
          );
          if (!hasKnownUndeliverableOutput || assistantText.length > 0) {
            const needsDecision = assistantText.length > 0 && shouldMarkDecisionNotification(assistantText);
            const catNames = targetCats.join(', ');
            void pushService
              .notifyUser(userId, {
                title: needsDecision ? `${catNames} 需要你决策` : `${catNames} 回复了`,
                body: (assistantText || '猫猫已处理，请打开会话查看详情').slice(0, 80),
                icon: targetCats.length === 1 ? `/avatars/${targetCats[0]}.png` : '/icons/icon-192x192.png',
                tag: `${needsDecision ? 'cat-decision' : 'cat-reply'}-${threadId}`,
                data: {
                  threadId,
                  url: `/?thread=${threadId}`,
                  ...(needsDecision ? { requiresDecision: true } : {}),
                },
              })
              .catch((err) => log.warn({ err, threadId }, '[QueueProcessor] push notification failed'));
          }
        }
      }

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
      const exposeFailure = entry.execution.actionSuccessorFence
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
        if (exposeFailure && !entry.execution.freshnessSupplementId) {
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
          if (entry.from.kind === 'user') {
            const pushService = this.deps.getPushService?.();
            if (pushService) {
              void pushService
                .notifyUser(userId, {
                  title: '猫猫出错了',
                  body: errMsg.slice(0, 100),
                  tag: `cat-error-${threadId}`,
                  data: { threadId, url: `/?thread=${threadId}` },
                })
                .catch((pushErr) =>
                  log.warn({ err: pushErr, threadId }, '[QueueProcessor] error push notification failed'),
                );
            }
          }
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
      if (!entry.execution.freshnessClosureId && !entry.execution.freshnessSupplementId) {
        await this.cleanupStreamingOnFailure(threadId, invocationId, streamStartPromise, log);
      }

      // R3 P2 fix (#873): Deliver error message to external IM so user sees
      // a reply instead of silence (mirrors ConnectorInvokeTrigger error path).
      // R6 fix: timeout prevents adapter hang from pinning queue slot (Cloud P1).
      if (
        this.deps.outboundHook &&
        !entry.execution.freshnessClosureId &&
        !entry.execution.freshnessSupplementId &&
        exposeFailure
      ) {
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
      if (heartbeatInterval !== undefined) clearInterval(heartbeatInterval);
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

      // Response terminalization also settles every linked input ref in the
      // store CAS. Publish those exact same-id snapshots before retiring the
      // ActiveRun so clients observe terminal truth without an F5 refresh.
      for (const lifecycleMessageId of [...lifecycleInputMessageIds, ...lifecycleResponseMessageIds]) {
        try {
          const lifecycleMessage = await messageStore.getById(lifecycleMessageId);
          if (lifecycleMessage?.lifecycle) this.emitLifecycleMessageUpdated(userId, lifecycleMessage);
        } catch (err) {
          log.warn(
            { err, threadId, lifecycleMessageId },
            '[QueueProcessor] failed to publish terminal lifecycle message snapshot',
          );
        }
      }

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
      // Close the supplement's own lifecycle before terminalizing its Queue row.
      if (!processingReservationReplaced) {
        await this.terminalizeFreshnessSupplementCarrier(entry, invocationId, finalStatus, executionError);
      }
      if (!processingReservationReplaced) {
        try {
          await this.settleAttemptQueueEntry(entry, finalStatus);
        } catch (err) {
          log.error(
            { err, threadId, queueEntryId: entry.id, finalStatus },
            '[QueueProcessor] Queue attempt settlement failed closed; durable nonterminal row needs recovery',
          );
          if (returnedExecutionResult) returnedExecutionResult.primarySettlementIncomplete = true;
        }
      } else {
        log.info(
          { threadId, queueEntryId: entry.id, invocationId },
          '[QueueProcessor] skipped stale Queue settlement after durable retirement barrier replaced the attempt',
        );
      }
      if (entry.execution.freshnessClosureId && invocationId && this.deps.freshnessClosureStore) {
        try {
          const closure = await this.deps.freshnessClosureStore.get(entry.execution.freshnessClosureId);
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
            { err, threadId, entryId: entry.id, closureId: entry.execution.freshnessClosureId },
            '[F254-E] failed to close unfinished queue attempt',
          );
        }
      }
      // F175 batch members settle through the same per-entry decision as the primary.
      for (const bid of processingReservationReplaced ? [] : batchedEntryIds) {
        const batched = queue.getEntrySnapshot(threadId, userId, bid);
        if (!batched) continue;
        try {
          await this.settleAttemptQueueEntry(batched, finalStatus);
        } catch (err) {
          log.error(
            { err, threadId, queueEntryId: bid, finalStatus },
            '[QueueProcessor] batched Queue attempt settlement failed closed',
          );
        }
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
        if (!(await this.shouldEnqueueContinuation(continuationCapsule, userId, finalStatus))) {
          log.info(
            { threadId, catId: continuationCapsule.catId },
            '[QueueProcessor] #836: reborn session — skipping continuation enqueue',
          );
          continue;
        }
        await this.enqueueContinuation({
          threadId,
          userId,
          ownerAuthProvenance: entry.execution.ownerAuthProvenance,
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
      if (entry.execution.actionSuccessorFence && !actionFencePreflightRejected && !replayClaimLost) {
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
      if (entry.execution.actionSuccessorFence && actionFencePreflightRejected) {
        completionHookStatus = 'canceled';
        completionHookResponse = '';
      }
      // F122B B6: Fire completion hook (one-shot) and clean up
      const registeredCompleteHooks = this.entryCompleteHooks.get(entry.id) ?? [];
      const completeHooks = registeredCompleteHooks.filter(
        (registration) => !registration.targetCatId || targetCats.includes(registration.targetCatId),
      );
      if (completeHooks.length > 0) {
        const remainingHooks = registeredCompleteHooks.filter((registration) => !completeHooks.includes(registration));
        if (remainingHooks.length > 0) this.entryCompleteHooks.set(entry.id, remainingHooks);
        else this.entryCompleteHooks.delete(entry.id);
        if (!replayClaimLost) {
          for (const registration of completeHooks) {
            const targetStatus = registration.targetCatId
              ? (terminalDispositions.getTerminalStatus(registration.targetCatId) ??
                (completionHookStatus === 'succeeded' ? 'failed' : completionHookStatus))
              : completionHookStatus;
            const targetResponse = registration.targetCatId
              ? (hookResponseTextByTarget.get(registration.targetCatId) ?? '')
              : completionHookResponse;
            try {
              registration.hook(entry.id, targetStatus, targetResponse);
            } catch {
              /* best-effort: hook errors must not break queue chain */
            }
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

  private async shouldEnqueueContinuation(
    capsule: CollaborationContinuityCapsuleV1,
    userId: string,
    finalStatus: InvocationFinalStatus,
  ): Promise<boolean> {
    // A handled dispatch continues inside the same Agent Client session. It is
    // terminal evidence for this Queue attempt, never admission for another
    // Queue row / InvocationRecord.
    if (capsule.continuationReason === 'dispatch_handled') return false;
    // runtime_replacement describes how this attempt recovered its writer. Once
    // that recovered attempt succeeds, replaying the capsule creates a second,
    // source-less invocation and can publish a duplicate terminal bubble.
    if (capsule.continuationReason === 'runtime_replacement' && finalStatus === 'succeeded') return false;
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
}
