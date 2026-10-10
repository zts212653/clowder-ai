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
  commitRecoveredFailedResponse,
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
import {
  checkDeploymentWaitStart,
  type DeploymentWaitStartDecision,
  type DeploymentWaitStartGuard,
} from '../../../../runtime-deployment/DeploymentWaitStartGuard.js';
import { bindAsrPersonMemoryScenesFromQueueMessage } from '../../../../signal-intake/AsrPersonMemoryQueueCarrier.js';
import {
  MessageBundlePromptUnavailableError,
  resolveMessageBundlePrompt,
} from '../../context/MessageBundlePromptResolver.js';
import type { FreshnessAttentionEventLog } from '../../freshness/FreshnessAttentionEventLog.js';
import { recordQueuedHandledTelemetry, recordQueuedSeenTelemetry } from '../../freshness/freshness-queue-telemetry.js';
import { shouldMarkDecisionNotification } from '../../push/decision-notification-policy.js';
import type { PushPayload } from '../../push/PushNotificationService.js';
import { messageFrom } from '../../stores/message-from.js';
import type { DeliveryCursorStore } from '../../stores/ports/DeliveryCursorStore.js';
import type { IDraftStore } from '../../stores/ports/DraftStore.js';
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
  settleLifecycleResponseInputs,
} from '../../stores/ports/MessageStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import { canViewMessage, getTimelineOrderTime, resolveDeliveryTimelineScore } from '../../stores/visibility.js';
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
  type CallerDispatchObservationProjection,
  CallerDispatchObservationRegistry,
} from './CallerDispatchObservationRegistry.js';
import {
  type CollaborationContinuityCapsuleV1,
  extractContinuityCapsuleFromAgentMessage,
  formatContinuationPrompt,
  isCollaborationContinuityCapsuleV1,
} from './CollaborationContinuityCapsule.js';
import { type EnsureTerminalDeps, ensureTerminalStatus, RouteChainCompletionTracker } from './ensureTerminalStatus.js';
import type { StaleProcessingOwnerLease } from './InvocationOwnerLeaseCandidates.js';
import {
  actionSuccessorInvocationKeyForTarget,
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
import { emitLifecycleMessageUpdated } from './lifecycle-message-update.js';
import {
  appendLifecycleResponseWithReadBack,
  LifecycleResponseAdmissionUnknownError,
} from './lifecycle-response-admission.js';
import { createMemberTimeoutStop } from './member-output-timeout.js';
import { requireOwnerAuthProvenance } from './owner-auth-provenance.js';
import {
  isTerminalDispositionEvent,
  PerCatTerminalDispositionCollector,
} from './PerCatTerminalDispositionCollector.js';
import type { OwnedQueueProgress } from './PersistedQueueCarrier.js';
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
import {
  collectiveQueueRefusalError,
  isPermanentCollectiveQueueRefusal,
  persistCollectiveRefusalRecord,
  retireRefusedCollectiveQueueCarrier,
} from './queue-private-refusal-disposition.js';
import { type QueueRetryDeferralOptions, QueueRetryDeferrals } from './queue-retry-deferrals.js';
import { requireInvocationRecordUpdate } from './require-invocation-record-update.js';
import {
  lifecycleResponseIdempotencyKey,
  recordTurnOutputVerdict,
  settleResponseFromDraft,
} from './response-draft-settlement.js';
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
  /** F117 KD-22: stop one member the way Stop does (the member timeout passes reason `timeout`). */
  cancel?(threadId: string, catId: string, requestUserId?: string, abortReason?: string): { cancelled: boolean };
  /** F117 KD-22: the member was stopped by its output timeout — a failure, not a cancellation. */
  isTimedOut?(threadId: string, catId: string): boolean;
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
  /** Actual children admitted through durable History; never inferred from a Queue parent ID. */
  terminalInvocationIdByCatId: Record<string, string>;
  /**
   * The attempt failed before its handoff (or its Queue settlement failed), so its entries must not
   * be retried at once: each waits for its retry time while the rest of the thread keeps draining.
   */
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

/** The targets a queued entry asks for, independent of their order. */
function requestedTargetsKey(entry: QueueEntry): string {
  return JSON.stringify([...queueEntryTargetCats(entry)].sort());
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
  debug?(obj: unknown, msg?: string): void;
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

export interface QueueProcessorDeps {
  queue: InvocationQueue;
  liveCompanionSessions?: Pick<
    import('../../../../concierge/live/LiveCompanionSessions.js').LiveCompanionSessions,
    'claim' | 'rejectUnclaimed'
  >;
  invocationTracker: TrackerLike;
  invocationRecordStore: InvocationRecordStoreLike;
  router: RouterLike;
  socketManager: SocketManagerLike;
  messageStore: IMessageStore;
  /** F117 KD-21: the in-flight bodies of responses an execution that throws leaves processing. */
  draftStore?: Pick<IDraftStore, 'getByThread' | 'delete'>;
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
  /** Outbound delivery timeout in ms (default 10_000). Mirrors the connector delivery path. */
  deliverTimeoutMs?: number;
  /** #813: Thread store for passive continuation (write/consume pending continuation). */
  threadStore?: ThreadStoreLike;
  /** F224: continuation lifecycle coordinator boundary. */
  sessionContinuationCoordinator?: SessionContinuationCoordinatorLike;
  /** F254: audit stream for exact queued-body adoption and other freshness lifecycle events. */
  freshnessEventLog?: FreshnessAttentionEventLog;
  /** F254 Phase E: typed successor preflight/adoption and crash closure. */
  /** Durable child lifecycle and causal coverage; auth registry is not historical truth. */
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get' | 'clearResponsePending' | 'settleOutputFence'>;
  /** F167 Phase S.1: carrier preflight plus failed/canceled runtime outcomes; success requires Evidence→Verdict. */
  actionSuccessorLeaseStore?: Pick<ActionSuccessorLeaseStore, 'preflight' | 'preflightOutput' | 'commitOutcome'>;
  deploymentWaitStartGuard?: Pick<DeploymentWaitStartGuard, 'check'>;
  /**
   * F254 Phase E (ADR-041 §5): seed the freshness seenCursor when closure adoption
   * injects required bodies — injection must count as seen, or the output gate
   * re-reads a frozen cursor and supersedes every replacement forever.
   */
  deliveryCursorStore?: Pick<DeliveryCursorStore, 'ackSeenCursor' | 'ackMentionCursor'>;
  /** F117 Phase H: process-local index; History remains the only lifecycle truth. */
  callerDispatchObservationRegistry?: CallerDispatchObservationRegistry;
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
  | { outcome: 'appended'; entry: QueueEntry; acceptedTargetIds: string[]; rejectedTargetIds?: string[] }
  | {
      outcome: 'rejected';
      reason:
        | 'append_unavailable'
        | 'active_run_pending'
        | 'state_changed'
        | 'custody_unavailable'
        | 'lifecycle_conflict'
        | 'provider_rejected';
      rejectedTargetIds?: string[];
    };

interface AutoResumeSuppression {
  setAt: number;
  epoch: number;
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
  bypassSuppressionEpochByCatId?: Map<string, number>;
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
  private nextAutoResumeSuppressionEpoch = 0;
  /** RFC #1356: one event-driven drain owner plus a no-lost-wakeup dirty bit per thread. */
  private readonly threadDrains = new Map<string, ThreadDrainState>();
  /** Native Append ACK holds only its target, after the durable handoff frees the drain. */
  private readonly automaticAppendSlots = new Set<string>();
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
  private readonly callerDispatchObservations: CallerDispatchObservationRegistry;
  private readonly callerDispatchProcessStart?: {
    processGenerationId: string;
  };
  /** F117 soak: entries whose attempt failed before handoff, each waiting for its retry time. */
  private readonly retryDeferrals: QueueRetryDeferrals;

  constructor(
    deps: QueueProcessorDeps,
    opts?: {
      processingSlotTtlMs?: number;
      callerDispatchProcessStart?: { processGenerationId: string };
      retryDeferral?: QueueRetryDeferralOptions;
    },
  ) {
    this.deps = deps;
    this.retryDeferrals = new QueueRetryDeferrals((threadId) => {
      this.requestDrain(threadId).catch((err) =>
        deps.log.error({ err, threadId }, '[QueueProcessor] drain after a retry wait failed'),
      );
    }, opts?.retryDeferral);
    this.processingSlotTtlMs = opts?.processingSlotTtlMs ?? DEFAULT_PRESTART_RESERVATION_TTL_MS;
    this.sessionContinuationCoordinator =
      deps.sessionContinuationCoordinator ?? QueueProcessor.createSessionContinuationCoordinator(deps.threadStore);
    this.callerDispatchObservations = deps.callerDispatchObservationRegistry ?? new CallerDispatchObservationRegistry();
    this.callerDispatchProcessStart = opts?.callerDispatchProcessStart;
  }

  /**
   * Record durable Queue target selection for an agent-authored source. This is
   * process-local caller context only; Queue and History remain canonical.
   */
  registerCallerDispatchInitialTargets(source: StoredMessage, targetIds: readonly string[]): void {
    this.callerDispatchObservations.registerInitialSource(source, targetIds);
  }

  /** Record only Steer changes that already committed to the durable Queue. */
  registerCallerDispatchSteerChanges(
    source: StoredMessage,
    changes: { readonly addedTargetIds: readonly string[]; readonly removedTargetIds: readonly string[] },
  ): void {
    this.callerDispatchObservations.registerSteerChanges(source, changes);
  }

  /** Record a committed whole-entry withdrawal without a post-commit History read. */
  registerCallerDispatchQueueWithdrawal(entry: QueueEntry): void {
    const sourceMessageId = entry.payload.messageId;
    if (!isPublicQueueEntry(entry) || entry.from.kind !== 'agent' || !sourceMessageId) return;
    this.callerDispatchObservations.registerQueueWithdrawalByIdentity({
      ownerId: queueEntryOwnerId(entry),
      threadId: entry.threadId,
      callerCatId: entry.from.catId,
      sourceMessageId,
      targetIds: queueEntryTargetCats(entry),
    });
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

  private isExactActiveRun(
    threadId: string,
    run: { targetId: string; invocationId: string; responseMessageId: string },
  ) {
    const current = this.deps.invocationTracker
      .getActiveSlots?.(threadId)
      .find((slot) => slot.catId === run.targetId)?.activeRun;
    return current?.invocationId === run.invocationId && current.responseMessageId === run.responseMessageId;
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
    {
      const delivery = await this.markDeliveredAndEmit(
        queueEntryOwnerId(input.entry),
        input.entry.threadId,
        [...input.inputMessageIds],
        Math.max(Date.now(), input.failedAtLowerBound),
        new Set(),
      );
      if (delivery.failedIds.length > 0) {
        throw new Error(`rejected Append could not be published: ${delivery.failedIds.join(',')}`);
      }
    }
  }

  /**
   * Admission-owned automatic Queue -> Active Run transfer. An explicit delivery
   * choice must remain bound to its selected parent for every source kind.
   * Source identity does not determine the target's guidance capability.
   * The exact run/capability/revision fences remain owned by the shared
   * lifecycle projection and append transaction below.
   */
  async tryAutoAppendExactEntry(
    input: {
      threadId: string;
      userId: string;
      entryId: string;
      targetCatId?: string;
    },
    onHandoff?: () => void,
  ): Promise<AppendExactEntryResult> {
    const { queue, invocationTracker } = this.deps;
    const entry = queue.getEntrySnapshot(input.threadId, input.userId, input.entryId);
    if (!entry || entry.execution.liveSessionId) {
      return { outcome: 'rejected', reason: 'append_unavailable' };
    }
    const requestedTargets = input.targetCatId ? [input.targetCatId] : queueEntryTargetCats(entry);
    {
      // New send admissions persist intent; legacy rows without it cannot imply immediate guidance.
      if (!invocationTracker.getExecutionId) {
        return { outcome: 'rejected', reason: 'append_unavailable' };
      }
      const remainsBoundToRequestedParent = requestedTargets.every((targetId) => {
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
      ...(input.targetCatId ? { targetIds: [input.targetCatId] } : {}),
    });
    if (!projection.available) {
      // An exact parent may still be preparing its native turn. Absence of its
      // dispatcher is not evidence that the parent ended or rejected guidance.
      const awaitingDispatcher =
        (projection.reason === 'active_run_missing' || projection.reason === 'client_unsupported') &&
        requestedTargets.length > 0 &&
        requestedTargets.every(
          (targetId) => !invocationTracker.getAgentClientActiveRunDispatcher?.(input.threadId, targetId),
        );
      return { outcome: 'rejected', reason: awaitingDispatcher ? 'active_run_pending' : 'append_unavailable' };
    }
    return this.appendExactEntry(
      {
        threadId: input.threadId,
        userId: input.userId,
        entryId: input.entryId,
        expectedQueueRevision: projection.action.expectedQueueRevision,
        expectedRuns: projection.action.expectedRuns,
      },
      onHandoff,
    );
  }

  /** Wait for durable admission, keeping a native ACK on its own target rather than the thread owner. */
  private async appendFromDrain(input: {
    threadId: string;
    userId: string;
    entryId: string;
    targetCatId: string;
  }): Promise<AppendExactEntryResult | undefined> {
    const slotKey = QueueProcessor.slotKey(input.threadId, input.targetCatId);
    this.automaticAppendSlots.add(slotKey);
    let handedOff = false;
    let releaseDrain!: () => void;
    const handoff = new Promise<undefined>((resolve) => {
      releaseDrain = () => resolve(undefined);
    });
    const completion = this.tryAutoAppendExactEntry(input, () => {
      handedOff = true;
      releaseDrain();
    }).finally(() => {
      this.automaticAppendSlots.delete(slotKey);
      if (handedOff) {
        void this.requestDrain(input.threadId).catch((err) =>
          this.deps.log.error(
            { err, threadId: input.threadId, entryId: input.entryId },
            '[QueueProcessor] Append completion failed to signal Queue progress',
          ),
        );
      }
    });
    return Promise.race([completion, handoff]);
  }

  /**
   * Explicit Queue -> existing Active Run transfer. Every capability/run fence
   * is revalidated before the synchronous Queue claim; provider side effects
   * occur only after exposure, lifecycle refs, and History admission are durable.
   */
  async appendExactEntry(
    input: {
      threadId: string;
      userId: string;
      entryId: string;
      expectedQueueRevision: string;
      expectedRuns: readonly { targetId: string; invocationId: string; responseMessageId: string }[];
    },
    onHandoff?: () => void,
  ): Promise<AppendExactEntryResult> {
    if (input.expectedRuns.length > 1) {
      if (this.deps.queue.snapshotRevision(input.threadId, input.userId) !== input.expectedQueueRevision) {
        return { outcome: 'rejected', reason: 'state_changed' };
      }
      const acceptedTargetIds: string[] = [];
      const rejectedTargetIds: string[] = [];
      let acceptedEntry: QueueEntry | undefined;
      let firstRejection: Extract<AppendExactEntryResult, { outcome: 'rejected' }> | undefined;
      for (const expectedRun of input.expectedRuns) {
        const result = await this.appendExactEntry({
          ...input,
          expectedQueueRevision: this.deps.queue.snapshotRevision(input.threadId, input.userId),
          expectedRuns: [expectedRun],
        });
        if (result.outcome === 'appended') {
          acceptedTargetIds.push(...result.acceptedTargetIds);
          acceptedEntry = result.entry;
        } else {
          firstRejection ??= result;
          rejectedTargetIds.push(expectedRun.targetId);
        }
      }
      if (acceptedEntry) {
        return {
          outcome: 'appended',
          entry: acceptedEntry,
          acceptedTargetIds,
          ...(rejectedTargetIds.length > 0 ? { rejectedTargetIds } : {}),
        };
      }
      return firstRejection ?? { outcome: 'rejected', reason: 'append_unavailable' };
    }
    const { queue, invocationTracker, messageStore, socketManager } = this.deps;
    if (input.expectedRuns.length === 0) {
      return { outcome: 'rejected', reason: 'custody_unavailable' };
    }
    const entry = queue.getEntrySnapshot(input.threadId, input.userId, input.entryId);
    if (
      !entry ||
      entry.execution.liveSessionId ||
      input.expectedRuns.length !== 1 ||
      input.expectedRuns.some((run) => !queueEntryTargetCats(entry).includes(run.targetId))
    ) {
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
    let providerDispatchStarted = false;
    let sourceMessages: StoredMessage[] = [];
    try {
      const sourceMessagesBeforeAdmission = (
        await Promise.all(inputMessageIds.map((messageId) => messageStore.getById(messageId)))
      ).filter((message): message is StoredMessage => !!message);
      if (sourceMessagesBeforeAdmission.length !== inputMessageIds.length) {
        throw new Error(`lifecycle Append source vanished before admission: ${input.entryId}`);
      }
      if (
        sourceMessagesBeforeAdmission.some((source) =>
          input.expectedRuns.some((run) => !canViewMessage(source, { type: 'cat', catId: run.targetId as CatId })),
        )
      ) {
        await queue.restoreClaimedEntries(input.threadId, [input.entryId]);
        return { outcome: 'rejected', reason: 'append_unavailable' };
      }
      sourceMessages = sourceMessagesBeforeAdmission;
      const imagePaths = sourceMessagesBeforeAdmission.flatMap((message) => extractImagePaths(message.contentBlocks));
      // Fence the response receiving this delivery. Model consumption is not a second admission.
      for (const run of input.expectedRuns) {
        if (!this.isExactActiveRun(input.threadId, run)) {
          throw new Error(`Active Run changed during Append admission: ${run.targetId}/${run.invocationId}`);
        }
      }

      const admission = await messageStore.commitLifecycleAppendAdmission({
        threadId: input.threadId,
        entryId: input.entryId,
        inputMessageIds,
        runs: input.expectedRuns.map((run, index) => ({
          ...run,
          dispatchedAt: seenAt,
          ...(dispatchers[index]?.capabilities.inputReadReceipt ? { inputReadSupported: true } : {}),
        })),
      });
      if (admission.kind !== 'applied' && admission.kind !== 'replayed') {
        throw new Error(
          `lifecycle Append admission ${admission.kind}:${'reason' in admission ? admission.reason : ''}`,
        );
      }
      sourceMessages = admission.messages.slice(0, inputMessageIds.length);
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
          throw new Error(`Active Run changed after Append admission: ${run.targetId}/${run.invocationId}`);
        }
      }
      const delivery = await this.markDeliveredAndEmit(
        input.userId,
        input.threadId,
        [...inputMessageIds],
        seenAt,
        new Set(),
      );
      if (delivery.failedIds.length > 0) throw new Error(`Append publication failed: ${delivery.failedIds.join(',')}`);
      for (const sourceMessage of sourceMessages) {
        this.callerDispatchObservations.registerPersistedSource(
          sourceMessage,
          input.expectedRuns.map((run) => run.targetId),
        );
      }
      if (!(await queue.commitClaimedProcessing(input.threadId, [input.entryId], seenAt))) {
        throw new Error(`claimed Append Queue target retirement did not commit: ${input.entryId}`);
      }
      removed = await queue.removeProcessedDurable(input.threadId, input.userId, input.entryId);
      if (!removed) throw new Error(`claimed Append Queue entry vanished: ${input.entryId}`);

      try {
        for (const message of admission.messages) {
          const current = await messageStore.getById(message.id);
          if (current) this.emitLifecycleMessageUpdated(input.userId, current);
        }
        await emitQueueUpdated(
          socketManager,
          input.userId,
          input.threadId,
          queue.list(input.threadId, input.userId),
          'appended',
        );
      } catch (projectionErr) {
        this.deps.log.warn(
          { projectionErr, threadId: input.threadId, entryId: input.entryId },
          '[QueueProcessor] lifecycle Append committed but live projection emit failed',
        );
      }
      providerDispatchStarted = true;
      onHandoff?.();
      const results = await Promise.all(
        input.expectedRuns.map(async (run, index) => {
          try {
            return await dispatchers[index]!.dispatch(
              {
                text: claimed.payload.content,
                ...(imagePaths.length > 0 ? { imagePaths } : {}),
                messageIds: inputMessageIds,
                ...(dispatchers[index]!.capabilities.inputReadReceipt
                  ? {
                      onInputRead: async () => {
                        const response = await messageStore.getById(run.responseMessageId);
                        if (
                          response?.lifecycle?.kind !== 'response' ||
                          response.lifecycle.invocationId !== run.invocationId ||
                          response.lifecycle.targetId !== run.targetId
                        )
                          return;
                        for (const id of inputMessageIds) {
                          if (!response.lifecycle.inputMessageIds.includes(id)) continue;
                          const source = await messageStore.getById(id);
                          const refs =
                            source?.lifecycle?.dispatchRefs?.filter(
                              (ref) => ref.targetId === run.targetId && ref.statusMessageId === run.responseMessageId,
                            ) ?? [];
                          if (!source || refs.length !== 1 || !refs[0]!.inputRead) continue;
                          const result = await messageStore.advanceLifecycleInputDispatch(id, {
                            ...lifecycleInputIdentityForStoredMessage(source),
                            targetId: run.targetId,
                            statusMessageId: run.responseMessageId,
                            ...(refs[0]!.phase === 'dispatched'
                              ? { phase: 'dispatched' as const, dispatchedAt: refs[0]!.dispatchedAt ?? seenAt }
                              : { phase: 'settled' as const }),
                            inputRead: { status: 'read', at: Math.max(Date.now(), refs[0]!.dispatchedAt ?? seenAt) },
                          });
                          if (result.kind === 'applied') this.emitLifecycleMessageUpdated(input.userId, result.message);
                        }
                      },
                    }
                  : {}),
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
        await emitQueueUpdated(
          socketManager,
          input.userId,
          input.threadId,
          queue.list(input.threadId, input.userId),
          'append_rejected',
        ).catch((projectionErr: unknown) =>
          this.deps.log.warn(
            { projectionErr, threadId: input.threadId, entryId: input.entryId },
            '[QueueProcessor] rejected Append compensated but its Queue projection emit failed',
          ),
        );
        return { outcome: 'rejected', reason: 'provider_rejected', rejectedTargetIds };
      }
      return { outcome: 'appended', entry: removed, acceptedTargetIds: input.expectedRuns.map((run) => run.targetId) };
    } catch (err) {
      if (!providerDispatchStarted) {
        try {
          const recovered = await this.recoverLifecycleAdmission({
            threadId: input.threadId,
            entryId: input.entryId,
            messageIds: inputMessageIds,
            runs: input.expectedRuns,
          });
          if (recovered.committed) {
            // A lost store reply is not proof of rollback. The provider has not
            // been called, so compensate only the exact durable hand-over.
            await this.compensateLifecycleAppendTargets({
              entry: claimed,
              inputMessageIds,
              sourceMessages: recovered.messages,
              runs: input.expectedRuns,
              failedTargetIds: input.expectedRuns.map((run) => run.targetId),
              failedAtLowerBound: seenAt + 1,
            });
          }
          await emitQueueUpdated(
            socketManager,
            input.userId,
            input.threadId,
            queue.list(input.threadId, input.userId),
            recovered.committed ? 'append_failed' : 'append_rollback',
          );
        } catch (compensationErr) {
          this.deps.log.error(
            { compensationErr, threadId: input.threadId, entryId: input.entryId },
            '[QueueProcessor] lifecycle Append recovery remains uncertain; preserving its claim',
          );
        }
      }
      this.deps.log.error(
        { err, threadId: input.threadId, entryId: input.entryId },
        '[QueueProcessor] explicit lifecycle Append failed closed',
      );
      return { outcome: 'rejected', reason: 'lifecycle_conflict' };
    }
  }

  /** Recover a lost History acknowledgement without guessing that admission rolled back. */
  private async recoverLifecycleAdmission(input: {
    threadId: string;
    entryId: string;
    messageIds: readonly string[];
    runs: readonly { targetId: string; responseMessageId: string }[];
  }): Promise<{ committed: boolean; messages: StoredMessage[] }> {
    const messages = await Promise.all(
      input.messageIds.map(async (id) => {
        const message = await this.deps.messageStore.getById(id);
        if (!message || message.threadId !== input.threadId)
          throw new Error(`History recovery evidence unavailable: ${id}`);
        return message;
      }),
    );
    const committed = messages.every((message) =>
      input.runs.every((run) =>
        message.lifecycle?.dispatchRefs?.some(
          (ref) => ref.targetId === run.targetId && ref.statusMessageId === run.responseMessageId,
        ),
      ),
    );
    const sources = new Map(messages.map((message) => [message.id, message]));
    if (
      !(await this.deps.queue.reconcileClaimedLifecycleTargets(input.threadId, [input.entryId], {
        getById: async (id) => {
          const message = sources.get(id);
          if (!message) throw new Error(`History recovery source unavailable: ${id}`);
          return message;
        },
      }))
    )
      throw new Error(`History claim recovery did not converge: ${input.entryId}`);
    return { committed, messages };
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
      for (const sourceMessage of admission.messages.slice(0, messageIds.length)) {
        this.callerDispatchObservations.registerPersistedSource(sourceMessage, [input.catId]);
      }

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
      try {
        const recovered = await this.recoverLifecycleAdmission({
          threadId: input.threadId,
          entryId: claimed.id,
          messageIds,
          runs: [input.run],
        });
        if (!recovered.committed && liveProjectionExtended) {
          invocationTracker.detachLifecycleActiveRunInputs?.(
            input.threadId,
            input.catId,
            input.run,
            claimed.id,
            messageIds,
          );
        }
      } catch (recoveryErr) {
        // Unknown History cannot justify restoring executable work. Leave the
        // exact claim for canonical recovery once persistence is readable.
        this.deps.log.error(
          { recoveryErr, threadId: input.threadId, entryId: claimed.id },
          '[QueueProcessor] queued-body recovery evidence unavailable; preserving its claim',
        );
      }
      this.deps.log.error(
        { err, threadId: input.threadId, entryId: claimed.id, invocationId: input.invocationId },
        '[QueueProcessor] exact queued-body adoption failed closed',
      );
      return {
        outcome: 'rejected',
        // Explicit lifecycle conflicts returned above are 409s. A thrown store
        // operation is unavailable persistence, even before History commits.
        reason: 'persistence_unavailable',
        entryId: claimed.id,
      };
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
    const committed = commitPreparedPrestartRetirements({
      retirements,
      slots: this.processingSlots,
      queue: this.deps.queue,
    });
    if (committed) {
      for (const retirement of retirements) {
        for (const carrier of retirement.carriers) this.registerCallerDispatchQueueWithdrawal(carrier);
      }
    }
    return committed;
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
          this.callerDispatchObservations.registerPersistedSource(failure.inputMessage, requestedTargets);
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
    const targetCatIds = new Set<string>();
    for (const [key, reservation] of this.processingSlots) {
      const scope = QueueProcessor.parseSlotKey(key);
      if (scope?.threadId !== threadId || reservation.userId !== userId) continue;
      catIds.push(scope.catId);
      targetCatIds.add(scope.catId);
      for (const carrier of this.deps.queue.getProcessingGroupAcrossUsers(threadId, reservation.entryId) ?? []) {
        for (const targetCatId of queueEntryTargetCats(carrier)) targetCatIds.add(targetCatId);
      }
    }
    if (catIds.length === 0) return { outcome: 'none', retiredCatIds: [] };
    // A pre-start group still owns its complete target set even though the
    // process-local reservation is keyed by the primary cat. Never retire that
    // group through another user's live tracker owner on a sibling target.
    if (!this.canReplaceExternalTargetSet(threadId, [...targetCatIds], userId)) {
      return { outcome: 'state_changed', retiredCatIds: [] };
    }

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

  /** Fix each source's delivery clock at its durable Queue claim, not after the receiver is written. */
  private queueAdmissionDeliveryTimes(entries: readonly QueueEntry[]): Map<string, number> {
    const primary = entries[0];
    if (!primary) throw new Error('Queue admission requires at least one claimed row');
    const deliveryTimeByMessageId = new Map<string, number>();
    for (const entry of entries) {
      const claimedAt = entry.claimedAt;
      // The caller already fences status === claimed; keep this boundary fail-closed for future callers.
      if (entry.status !== 'claimed' || typeof claimedAt !== 'number' || !Number.isFinite(claimedAt)) {
        throw new Error(`Queue admission requires a durable dequeue clock: ${entry.id}`);
      }
      const deliveredAt = Math.max(claimedAt, entry.enqueuedAt);
      for (const messageId of queueEntryMessageIds(entry)) {
        deliveryTimeByMessageId.set(messageId, Math.max(deliveryTimeByMessageId.get(messageId) ?? 0, deliveredAt));
      }
    }
    return deliveryTimeByMessageId;
  }

  /** Admit durable sources without publishing a half-completed cutover. */
  private async admitQueueEntriesForProvider(deliveryTimeByMessageId: ReadonlyMap<string, number>): Promise<void> {
    const allMessageIds = [...deliveryTimeByMessageId.keys()];
    const failedIds: string[] = [];
    for (const [messageId, deliveredAt] of deliveryTimeByMessageId) {
      try {
        if (!(await this.deps.messageStore.markDelivered(messageId, deliveredAt))) {
          failedIds.push(messageId);
        }
      } catch {
        failedIds.push(messageId);
      }
    }
    if (failedIds.length > 0) {
      throw new Error(`Queue admission failed to publish History sources: ${failedIds.join(',')}`);
    }
    for (const messageId of allMessageIds) {
      const message = await this.deps.messageStore.getById(messageId);
      if (!message || !isTimelinePublished(message)) {
        throw new Error(`Queue admission source did not enter History: ${messageId}`);
      }
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

  /**
   * A crash can leave a queued/claimed target behind after its History receiver
   * was committed. Reconcile the whole exact claim before installing a provider
   * reservation: stale members retire, while unaffected siblings are restored.
   */
  private async reconcileClaimedGroupWithExistingReceiver(
    entries: readonly QueueEntry[],
    targetCatId: string,
  ): Promise<boolean> {
    let hasExistingReceiver: boolean;
    try {
      hasExistingReceiver = await this.claimGroupHasExistingReceiver(entries, targetCatId);
    } catch (error) {
      // No receiver/admission decision was made. Release only this already-owned
      // claim; every later admission must re-check canonical History evidence.
      await this.deps.queue.restoreClaimedEntries(
        entries[0]!.threadId,
        entries.map((entry) => entry.id),
      );
      throw error;
    }
    if (!hasExistingReceiver) return false;

    const entryIds = entries.map((entry) => entry.id);
    if (
      !(await this.deps.queue.reconcileClaimedLifecycleTargets(entries[0]!.threadId, entryIds, this.deps.messageStore))
    ) {
      throw new Error(`stale Queue lifecycle reconciliation did not converge: ${entryIds.join(',')}`);
    }
    return true;
  }

  private async claimGroupHasExistingReceiver(entries: readonly QueueEntry[], targetCatId: string): Promise<boolean> {
    for (const entry of entries) {
      for (const messageId of queueEntryMessageIds(entry)) {
        const source = await this.deps.messageStore.getById(messageId);
        if (source?.lifecycle?.kind !== 'input' && source?.lifecycle?.kind !== 'response') continue;
        if (source.lifecycle.dispatchRefs?.some((ref) => ref.targetId === targetCatId)) {
          return true;
        }
      }
    }
    return false;
  }

  private async firstTargetWithExistingReceiver(
    entries: readonly QueueEntry[],
    targetCatIds: readonly string[],
  ): Promise<string | undefined> {
    for (const targetCatId of targetCatIds) {
      if (await this.claimGroupHasExistingReceiver(entries, targetCatId)) return targetCatId;
    }
    return undefined;
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
      // A connector notice admitted as queued work reaches the timeline through this delivery, so
      // this is the only place the client can learn it is a connector at all.
      source?: StoredMessage['source'];
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
          ...(result.source ? { source: result.source } : {}),
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
    emitLifecycleMessageUpdated(this.deps.socketManager, userId, message);
  }

  /**
   * F117 KD-21: settle the responses a thrown execution left processing. An exposed failure fails
   * each R with its draft body; a fenced action whose failure stays hidden ends R the way a route
   * ends a rejected output. The fence's verdict is written to the turn first, so this pass and any
   * later one read it from there: a hidden failure's draft is never published, even when its R
   * commit fails. A settlement that throws leaves the ended turn in the response-pending ledger,
   * and the next startup settles it.
   */
  private async settleAbandonedResponses(
    userId: string,
    threadId: string,
    responseIds: ReadonlySet<string>,
    outcome: 'failed' | 'output_rejected',
  ): Promise<void> {
    for (const responseId of responseIds) {
      try {
        const response = await this.deps.messageStore.getById(responseId);
        if (response?.lifecycle?.kind !== 'response' || response.lifecycle.status !== 'processing') continue;
        const { invocationId } = response.lifecycle;
        await recordTurnOutputVerdict(
          this.deps.turnExecutionStore,
          invocationId,
          outcome === 'failed' ? 'allowed' : 'rejected',
          (err) =>
            this.deps.log.warn(
              { err, threadId, invocationId },
              '[QueueProcessor] failed to record the output fence verdict; the turn stays gated',
            ),
        );
        await settleResponseFromDraft(
          {
            messageStore: this.deps.messageStore,
            ...(this.deps.draftStore ? { draftStore: this.deps.draftStore } : {}),
            ...(this.deps.turnExecutionStore ? { turnStore: this.deps.turnExecutionStore } : {}),
            commitFailedResponse: (response, patch) =>
              commitRecoveredFailedResponse(
                {
                  socketManager: this.deps.socketManager,
                  queueProcessor: this,
                  messageStore: this.deps.messageStore,
                  invocationQueue: this.deps.queue,
                  log: this.deps.log,
                },
                response,
                patch,
              ),
            emit: (recipient, message) => this.emitLifecycleMessageUpdated(recipient, message),
          },
          {
            userId,
            threadId,
            invocationId,
            endedAt: Date.now(),
            ...(outcome === 'failed'
              ? { status: 'failed', reason: 'execution_error' }
              : { status: 'interrupted', reason: 'output_commit_rejected' }),
          },
        );
      } catch (err) {
        this.deps.log.warn(
          { err, threadId, responseId },
          '[QueueProcessor] failed to settle a response its failed execution left processing',
        );
      }
    }
  }

  /**
   * F117 KD-21: a response R confirmed terminal takes its ended turn out of the response-pending ledger.
   * KD-23: its draft goes first. Drafts no longer expire, so if deleting it fails the turn stays in the
   * ledger, and the next startup settles it again: R is already terminal, so that only deletes the draft.
   */
  private async releaseSettledResponseTurn(message: StoredMessage | null | undefined, log: LoggerLike): Promise<void> {
    const lifecycle = message?.lifecycle;
    if (!message || lifecycle?.kind !== 'response' || lifecycle.status === 'processing') return;
    try {
      await this.deps.draftStore?.delete(message.userId, message.threadId, lifecycle.invocationId);
      await this.deps.turnExecutionStore?.clearResponsePending(lifecycle.invocationId);
    } catch (err) {
      log.warn(
        { err, invocationId: lifecycle.invocationId },
        '[QueueProcessor] failed to release a settled response turn; the next startup settles it',
      );
    }
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
    completedCatIds: readonly string[] = [],
    options: {
      suppressAutomaticDrain?: boolean;
      attemptedQueueEntryIds?: readonly string[];
      suppressAutomaticFollowUp?: boolean;
      terminalInvocationIdByCatId?: Readonly<Record<string, string>>;
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
      // A backend attempt that failed before handoff leaves the exact source
      // queued with bounded backoff; other members continue draining.
      this.deferFailedAttempt(threadId, catId, status, attemptedQueueEntryIds);
    } else {
      for (const entryId of attemptedQueueEntryIds) this.retryDeferrals.forget(entryId);
    }
    if (this.hasDispatchableQueuedForThread(threadId)) {
      const bypassSuppressionEpoch = this.autoResumeSuppressionEpochForDifferentExecution(sk, invocationId);
      await this.requestDrain(
        threadId,
        bypassSuppressionEpoch === undefined ? undefined : { bypassSuppressionForCatId: catId, bypassSuppressionEpoch },
      );
    }
  }

  /**
   * Retry only entries left queued by an actual failed handoff, with the
   * existing bounded backend backoff. Availability advice cannot park them.
   */
  private deferFailedAttempt(threadId: string, catId: string, status: string, entryIds: readonly string[]): void {
    for (const entryId of entryIds) {
      const entry = this.deps.queue.getEntrySnapshotAcrossUsers(threadId, entryId);
      if (!entry) {
        // Every target of the entry was handed off: nothing is left to wait.
        this.retryDeferrals.forget(entryId);
        continue;
      }
      const retryAt = this.retryDeferrals.defer(threadId, entryId);
      this.deps.log.warn(
        { threadId, catId, status, entryId, retryAt, queued: entry.status === 'queued' },
        '[QueueProcessor] an attempt left its entry in the Queue; the entry waits for its retry time',
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
      epoch: ++this.nextAutoResumeSuppressionEpoch,
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

  private autoResumeSuppressionEpochForDifferentExecution(
    slotKey: string,
    invocationId: string | undefined,
  ): number | undefined {
    if (!invocationId || this.autoResumeSuppressionRemainingMs(slotKey) === 0) return undefined;
    const suppression = this.suppressedAutoResume.get(slotKey);
    return suppression && !suppression.hasAnonymousFence && !suppression.executionIds.has(invocationId)
      ? suppression.epoch
      : undefined;
  }

  /**
   * User-level entry: co-creator manually triggers processing their next entry.
   */
  async processNext(threadId: string, userId: string): Promise<{ started: boolean; entry?: QueueEntry }> {
    return this.tryExecuteNextForUser(threadId, userId);
  }

  /**
   * Progress a producer-owned durable carrier through existing Append admission
   * or the ordinary Queue comparator. Recovery is not authority to clear a
   * cancellation fence, or start a second invocation for an admitted row.
   */
  async progressOwnedCarrier(entry: QueueEntry, targetCatId: string): Promise<OwnedQueueProgress> {
    const userId = queueEntryOwnerId(entry);
    const current = this.deps.queue.getEntrySnapshot(entry.threadId, userId, entry.id);
    if (!current) {
      return this.deps.queue.findAdmittedEntriesForMessages(
        entry.threadId,
        queueEntryMessageIds(entry),
        userId,
        targetCatId,
      ).length > 0
        ? 'already_processing'
        : 'terminal_owned';
    }
    if (current.status === 'claimed' || current.status === 'processing') return 'already_processing';
    if (current.status === 'terminal') return 'terminal_owned';
    if (this.isAutoResumeSuppressed(entry.threadId, targetCatId)) return 'owned_deferred_suppressed';
    await this.requestDrain(entry.threadId);
    if (
      this.deps.queue.findAdmittedEntriesForMessages(entry.threadId, queueEntryMessageIds(entry), userId, targetCatId)
        .length > 0
    ) {
      return 'started';
    }
    const durable = await this.deps.queue.getDurableEntry(entry.threadId, entry.id);
    if (!durable || durable.status === 'terminal') return 'terminal_owned';
    if (durable.status === 'claimed' || durable.status === 'processing') return 'already_processing';
    return 'owned_deferred_busy';
  }

  /**
   * Signal the single per-thread admission coordinator. Repeated signals while
   * it is running only set dirty; the current owner must observe that bit before
   * it can retire, so enqueue/terminal/reorder races cannot lose the last wake.
   */
  requestDrain(
    threadId: string,
    options?: { bypassSuppressionForCatId?: string; bypassSuppressionEpoch?: number },
  ): Promise<void> {
    const state = this.threadDrains.get(threadId) ?? { dirty: false };
    this.threadDrains.set(threadId, state);
    state.dirty = true;
    if (options?.bypassSuppressionForCatId && options.bypassSuppressionEpoch !== undefined) {
      if (!state.bypassSuppressionEpochByCatId) state.bypassSuppressionEpochByCatId = new Map();
      state.bypassSuppressionEpochByCatId.set(options.bypassSuppressionForCatId, options.bypassSuppressionEpoch);
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
      const bypassSuppressionEpochByCatId = new Map(state.bypassSuppressionEpochByCatId);
      state.bypassSuppressionEpochByCatId?.clear();
      while (true) {
        const result = await this.tryExecuteNextAcrossUsers(threadId, bypassSuppressionEpochByCatId);
        // One drain owns one source entry. Its exact target set fans out as one
        // admission unit; the durable handoff callback signals the next drain.
        // This preserves source comparator order without waiting for providers
        // to finish their work.
        if (result.started || !result.progressed) break;
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
    if (await this.reconcileClaimedGroupWithExistingReceiver(entries, targetCatId)) {
      return { started: false };
    }
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
    let liveCall: import('../../../../concierge/live/LiveCompanionCall.js').LiveCompanionCall | undefined;
    if (entry.execution.liveSessionId) {
      try {
        if (!this.deps.liveCompanionSessions || claimedBatchMembers.length || entry.targets.length !== 1)
          throw new Error('Live admission unavailable');
        liveCall = await this.deps.liveCompanionSessions.claim(
          entry.execution.liveSessionId,
          queueEntryOwnerId(entry),
          entry.threadId,
          executionTargetCats ?? entry.targets,
        );
        // Verification awaited: neither an external invocation nor Stop may have taken this slot.
        if (this.deps.invocationTracker.has(entry.threadId, catId) || !liveCall.acceptsAdmission())
          throw new Error('Live admission lost its immediate slot');
      } catch (error) {
        // Only the call actually acquired here belongs to this execution.
        await liveCall?.stop();
        this.releaseProcessingSlot(slotKey, reservation);
        await this.terminalizeUnavailableConversationHead(entry, 'explicit', true);
        return true;
      }
    }

    void this.executeEntry(
      entry,
      reservation,
      executionTargetCats,
      [...claimedBatchMembers],
      conversationBatchResolution,
      liveCall,
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
          terminalInvocationIdByCatId: result.terminalInvocationIdByCatId,
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

  /**
   * F117 soak: one drain starts at most one source entry, the first in comparator order whose whole
   * pending target set can start now. An entry that waits (a target busy or suppressed, or its retry
   * deferred) no longer stops the entries behind it; it holds back only the later entries that share
   * one of its targets, so every target still receives its sources in comparator order. A targetless
   * input that waits for an idle thread holds back everything behind it: its target is not known yet.
   * The scan reads one snapshot and awaits target resolution, so the claim re-checks the order.
   */
  private async tryExecuteNextAcrossUsers(
    threadId: string,
    bypassSuppressionEpochByCatId: ReadonlyMap<string, number> = new Map(),
  ): Promise<QueueAdmissionAttempt> {
    const candidates = this.deps.queue.listQueuedAcrossUsers(threadId);
    if (candidates.length === 0) {
      this.emitContinuationDiagnostic(threadId, 'unknown', classifyContinuationOutcome(0), 0);
      return { started: false };
    }
    const heldTargets = new Set<string>();
    // The entries this scan passed over, each with the targets it asked for when it was passed over.
    const passedOver = new Map<string, string>();
    let waitingEntries = 0;
    let firstWaitingTarget: string | undefined;
    for (const [index, candidate] of candidates.entries()) {
      if (
        candidate.execution.liveSessionId &&
        candidate.targets.length === 1 &&
        (await this.claimGroupHasExistingReceiver([candidate], candidate.targets[0]!))
      ) {
        const claimed = await this.deps.queue.markProcessingByIdDurable(threadId, candidate.id, candidate.targets[0]!);
        if (claimed) await this.reconcileClaimedGroupWithExistingReceiver([claimed], candidate.targets[0]!);
        return { started: false, progressed: Boolean(claimed) };
      }
      if (
        candidate.execution.liveSessionId &&
        (candidate.targets.length !== 1 ||
          !candidate.targets.every(
            (catId) => !heldTargets.has(catId) && this.isSlotAdmissible(threadId, catId, new Map()),
          ))
      ) {
        const settled = await this.terminalizeUnavailableConversationHead(candidate, 'explicit');
        return QueueProcessor.terminalizedHeadAttempt(settled);
      }
      // Every ingress signals this one owner after durable admission. Append
      // and a fresh turn share Queue progress; the sender kind chooses neither.
      let appended = false;
      if (!this.retryDeferrals.isDeferred(candidate.id)) {
        for (const targetCatId of queueEntryTargetCats(candidate)) {
          if (
            heldTargets.has(targetCatId) ||
            this.automaticAppendSlots.has(QueueProcessor.slotKey(threadId, targetCatId)) ||
            this.isAutoResumeSuppressed(threadId, targetCatId)
          )
            continue;
          const result = await this.appendFromDrain({
            threadId,
            userId: queueEntryOwnerId(candidate),
            entryId: candidate.id,
            targetCatId,
          });
          if (!result || result.outcome === 'appended') appended = true;
          else if (
            result.reason !== 'active_run_pending' &&
            candidate.delivery.authorIntentByTarget?.[targetCatId]?.requested === 'continue_current'
          ) {
            await this.deps.queue.fallbackQueuedAuthorIntentDurable(
              threadId,
              queueEntryOwnerId(candidate),
              candidate.id,
              targetCatId,
              'parent_terminal_before_exposure',
            );
          }
        }
      }
      if (appended) return { started: false, progressed: true };
      const admission = await this.resolveAdmissionTargets(threadId, candidate, index === 0);
      if (admission.kind === 'settled') return admission.attempt;
      if (admission.kind === 'barrier') {
        this.emitContinuationDiagnostic(
          threadId,
          'targetless',
          'all_candidate_slots_busy',
          waitingEntries + 1,
          candidate.id,
        );
        return { started: false };
      }
      const targets = admission.kind === 'resolved' ? admission.targets : queueEntryTargetCats(candidate);
      const canStart =
        admission.kind === 'resolved' &&
        !this.retryDeferrals.isDeferred(candidate.id) &&
        targets.every(
          (catId) => !heldTargets.has(catId) && this.isSlotAdmissible(threadId, catId, bypassSuppressionEpochByCatId),
        );
      if (canStart) {
        const attempt = await this.startSelectedEntry(threadId, candidate, admission, passedOver);
        if (attempt) return attempt;
      }
      passedOver.set(candidate.id, requestedTargetsKey(candidate));
      for (const catId of [...queueEntryTargetCats(candidate), ...targets]) heldTargets.add(catId);
      waitingEntries += 1;
      firstWaitingTarget ??= targets[0];
    }
    this.emitContinuationDiagnostic(
      threadId,
      firstWaitingTarget ?? 'unknown',
      'all_candidate_slots_busy',
      waitingEntries,
      candidates[0]?.id,
    );
    return { started: false };
  }

  /** A public fallback cannot expand the persisted source's recipient visibility. */
  private async resolveQueuedConversationTargets(entry: QueueEntry): Promise<string[]> {
    const sources = await Promise.all(queueEntryMessageIds(entry).map((id) => this.deps.messageStore.getById(id)));
    const targets = await this.deps.router.resolveConversationTargetsAtAdmission(
      queueEntryTargetCats(entry),
      entry.threadId,
    );
    return targets.filter((catId) =>
      sources.every((source) => !source || canViewMessage(source, { type: 'cat', catId: catId as CatId })),
    );
  }

  /**
   * The targets a queued entry would start with now. Only the comparator head settles an entry that
   * resolves no target (it fails in place); a later one waits, holding its requested targets.
   */
  private async resolveAdmissionTargets(
    threadId: string,
    entry: QueueEntry,
    isHead: boolean,
  ): Promise<
    | {
        readonly kind: 'resolved';
        readonly targets: string[];
        readonly conversationBatchResolution?: ConversationBatchResolution;
      }
    | { readonly kind: 'unresolved' }
    | { readonly kind: 'barrier' }
    | { readonly kind: 'settled'; readonly attempt: QueueAdmissionAttempt }
  > {
    const requestedTargets = queueEntryTargetCats(entry);
    if (entry.kind === 'conversation_input') {
      const routingClass = requestedTargets.length === 0 ? 'targetless' : 'explicit';
      if (routingClass === 'targetless' && this.deps.invocationTracker.has(threadId)) return { kind: 'barrier' };
      const targets = await this.resolveQueuedConversationTargets(entry);
      if (targets.length > 0) {
        return {
          kind: 'resolved',
          targets,
          conversationBatchResolution: {
            routingClass,
            requestedTargets: [...requestedTargets],
            resolvedTargets: [...targets],
          },
        };
      }
      if (!isHead) return { kind: 'unresolved' };
      const terminalized = await this.terminalizeUnavailableConversationHead(entry, routingClass);
      return { kind: 'settled', attempt: QueueProcessor.terminalizedHeadAttempt(terminalized) };
    }
    const targets = await this.deps.router.resolveExplicitTargets(requestedTargets, threadId);
    if (targets.length > 0) return { kind: 'resolved', targets };
    if (!isHead) return { kind: 'unresolved' };
    const terminalized =
      entry.kind === 'private_input'
        ? await this.terminalizeUnavailablePrivateHead(entry)
        : await this.terminalizeUnavailableConversationHead(entry, 'explicit');
    return { kind: 'settled', attempt: QueueProcessor.terminalizedHeadAttempt(terminalized) };
  }

  private static terminalizedHeadAttempt(terminalized: QueueEntry | null): QueueAdmissionAttempt {
    return { started: false, progressed: terminalized !== null, ...(terminalized ? { entry: terminalized } : {}) };
  }

  /** A slot may take new work: no execution holds it and no cancel fence suppresses it. */
  private isSlotAdmissible(
    threadId: string,
    catId: string,
    bypassSuppressionEpochByCatId: ReadonlyMap<string, number>,
  ): boolean {
    const slotKey = QueueProcessor.slotKey(threadId, catId);
    const remainingMs = this.autoResumeSuppressionRemainingMs(slotKey);
    const suppression = remainingMs > 0 ? this.suppressedAutoResume.get(slotKey) : undefined;
    const bypassEpoch = bypassSuppressionEpochByCatId.get(catId);
    const bypassesExactSuppression = bypassEpoch !== undefined && suppression?.epoch === bypassEpoch;
    return (
      (bypassesExactSuppression || remainingMs === 0) &&
      !this.processingSlots.has(slotKey) &&
      !this.automaticAppendSlots.has(slotKey) &&
      !this.deps.invocationTracker.has(threadId, catId)
    );
  }

  /**
   * Whether every entry now ahead of the selected one in comparator order is one the scan passed
   * over while it still asked for the same targets. Only then does the selection keep each target's
   * sources in comparator order. An entry no longer queued is left for the claim to refuse.
   */
  private onlyPassedOverEntriesAhead(
    threadId: string,
    entryId: string,
    passedOver: ReadonlyMap<string, string>,
  ): boolean {
    const queued = this.deps.queue.listQueuedAcrossUsers(threadId);
    const index = queued.findIndex((entry) => entry.id === entryId);
    if (index < 0) return true;
    return queued.slice(0, index).every((entry) => passedOver.get(entry.id) === requestedTargetsKey(entry));
  }

  /**
   * Claims and starts the entry the drain selected. Returns null when the claim does not hold (the
   * entry changed, or a target became busy after the claim and the entry went back), so the drain
   * treats the entry as waiting and looks further. When the Queue order changed under the scan, it
   * claims nothing and reports progress, so the drain scans the current order again.
   */
  private async startSelectedEntry(
    threadId: string,
    candidate: QueueEntry,
    admission: { readonly targets: string[]; readonly conversationBatchResolution?: ConversationBatchResolution },
    passedOver: ReadonlyMap<string, string>,
  ): Promise<QueueAdmissionAttempt | null> {
    const staleReceiverTarget =
      admission.targets.length > 1
        ? await this.firstTargetWithExistingReceiver([candidate], admission.targets)
        : undefined;
    const selectedTargetCats = staleReceiverTarget ? [staleReceiverTarget] : admission.targets;

    // Checked with no await before the claim: an owner may have moved another entry ahead of this
    // one while the scan awaited, and that entry may share a target.
    if (!this.onlyPassedOverEntriesAhead(threadId, candidate.id, passedOver)) {
      this.deps.log.info(
        { threadId, entryId: candidate.id },
        '[QueueProcessor] the Queue order changed during the drain scan; scanning again',
      );
      return { started: false, progressed: true };
    }
    const claimedGroup = await this.deps.queue.markProcessingGroupAcrossUsersDurable(
      threadId,
      { entryId: candidate.id, targetCats: selectedTargetCats },
      [candidate.id],
    );
    const entry = claimedGroup?.entry;
    if (!entry) return null;

    for (const targetCatId of selectedTargetCats) {
      if (await this.reconcileClaimedGroupWithExistingReceiver([entry, ...claimedGroup.members], targetCatId)) {
        return { started: false, progressed: true, entry };
      }
    }

    const entryCat = selectedTargetCats[0]!;
    const entrySk = QueueProcessor.slotKey(threadId, entryCat);

    if (this.processingSlots.has(entrySk) || this.deps.invocationTracker.has(threadId, entryCat)) {
      if (entry.execution.liveSessionId) {
        const settled = await this.terminalizeUnavailableConversationHead(entry, 'explicit', true);
        return QueueProcessor.terminalizedHeadAttempt(settled);
      }
      await this.deps.queue.rollbackProcessingDurable(threadId, entry.id);
      return null;
    }

    if (
      !(await this.startReservedEntry(
        entry,
        entrySk,
        entryCat,
        selectedTargetCats,
        false,
        admission.conversationBatchResolution,
        [],
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
      resolvedTargetCats = await this.resolveQueuedConversationTargets(nextEntry);
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

    const idleTargetCats = resolvedTargetCats.filter(
      (catId) =>
        !this.processingSlots.has(QueueProcessor.slotKey(threadId, catId)) &&
        !this.deps.invocationTracker.has(threadId, catId),
    );
    if (idleTargetCats.length !== resolvedTargetCats.length) {
      this.deps.log.info(
        { event: 'queue_not_started', threadId, entryCat: resolvedTargetCats[0], reason: 'target_busy' },
        '[QueueProcessor] processNext skipped: target slot busy',
      );
      return { started: false };
    }
    const staleReceiverTarget =
      idleTargetCats.length > 1 ? await this.firstTargetWithExistingReceiver([nextEntry], idleTargetCats) : undefined;
    const selectedTargetCats = staleReceiverTarget ? [staleReceiverTarget] : idleTargetCats;

    const entryCat = selectedTargetCats[0]!;
    const sk = QueueProcessor.slotKey(threadId, entryCat);

    const claimedGroup = await this.deps.queue.markProcessingGroupDurable(
      threadId,
      userId,
      { entryId: nextEntry.id, targetCats: selectedTargetCats },
      [nextEntry.id],
    );
    const entry = claimedGroup?.entry;
    if (!entry) return { started: false };

    for (const targetCatId of selectedTargetCats) {
      if (await this.reconcileClaimedGroupWithExistingReceiver([entry, ...claimedGroup.members], targetCatId)) {
        return { started: false, progressed: true, entry };
      }
    }

    // Fire-and-forget execution — exact reservation cleanup owns completion side effects.
    if (
      !(await this.startReservedEntry(entry, sk, entryCat, selectedTargetCats, false, conversationBatchResolution, []))
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
    alreadyClaimed = false,
  ): Promise<QueueEntry | null> {
    const claimed = alreadyClaimed
      ? expected
      : expected.execution.liveSessionId
        ? await this.deps.queue.markProcessingByIdDurable(expected.threadId, expected.id, expected.targets[0] ?? '')
        : await this.deps.queue.claimPreAdmissionFailureAcrossUsersDurable(expected.threadId, expected.id);
    if (!claimed) return null;
    try {
      if (!claimed.payload.messageId) {
        throw new Error(`public Queue head has no durable source message: ${claimed.id}`);
      }
      const source = await this.deps.messageStore.getById(claimed.payload.messageId);
      if (!source) {
        throw new Error(`public Queue head source message is missing: ${claimed.id}`);
      }
      const reason = claimed.execution.liveSessionId
        ? 'control_carrier_missing'
        : routingClass === 'targetless'
          ? 'no_available_target'
          : 'invalid_explicit_target';
      const failedTargets = [...queueEntryTargetCats(claimed)];
      const wakeTargetLabel = failedTargets.length > 0 ? failedTargets.join('、') : '处理成员';
      const content = claimed.execution.liveSessionId
        ? '语音交流未投递：成员或语音窗口当前不可用。'
        : reason === 'no_available_target'
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
      if (claimed.execution.liveSessionId)
        await this.deps.liveCompanionSessions?.rejectUnclaimed(
          claimed.execution.liveSessionId,
          queueEntryOwnerId(claimed),
          claimed.threadId,
          failedTargets,
        );
      this.callerDispatchObservations.registerPersistedSource(result.inputMessage, failedTargets);
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
        'pre_admission_failed',
      );
      this.deps.log.warn(
        { threadId: claimed.threadId, entryId: claimed.id, routingClass, reason },
        '[QueueProcessor] public Queue head terminalized before admission',
      );
      return removed;
    } catch (error) {
      // A lost durable acknowledgement is unknown, not permission to re-admit Live.
      if (claimed.execution.liveSessionId) throw error;
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
    liveCall?: import('../../../../concierge/live/LiveCompanionCall.js').LiveCompanionCall,
  ): Promise<QueueExecutionResult> {
    const { queue, invocationTracker, invocationRecordStore, router, socketManager, messageStore, log } = this.deps;
    const threadId = entry.threadId;
    const userId = queueEntryOwnerId(entry);
    const intent = entry.execution.intent;
    const messageId = entry.payload.messageId;
    const targetCats = [...(executionTargetCats ?? queueEntryTargetCats(entry))];
    const primaryCat = targetCats[0] ?? 'unknown';
    const executionPreparationStartedAt = performance.now();
    let routePreparationStartedAt = executionPreparationStartedAt;
    log.debug?.(
      {
        threadId,
        entryId: entry.id,
        sourceMessageId: messageId,
        targetCats,
        queueAgeMs: Date.now() - entry.enqueuedAt,
      },
      'Delivery queue preparation started',
    );

    const batchedEntryIds: string[] = exactBatchEntries.map((candidate) => candidate.id);
    const batchedMessageIds: string[] = exactBatchEntries.flatMap(queueEntryMessageIds);
    let content = entry.payload.content;

    let controller: AbortController | undefined;
    let invocationId: string | undefined;
    let expectedInvocationStatus: InvocationStatus = 'queued';
    let finalStatus: InvocationFinalStatus = 'failed';
    let replayClaimLost = false;
    let processingReservationReplaced = false;
    let prestartClaimRestored = false;
    let lifecycleTransferStarted = false;
    let lifecycleReceiverPersisted = false;
    let lifecycleAdmissionUnknown = false;
    let lifecycleQueueTargetsRetired = false;
    let lifecycleClaimRestorePromise: Promise<boolean> | undefined;
    const terminalDispositions = new PerCatTerminalDispositionCollector({
      targetCatIds: targetCats,
      // A member stopped by its output timeout failed (F117 KD-22); its route reports the failure.
      isCanceled: (catId) =>
        invocationTracker.getSlotState?.(threadId, catId) === 'canceled' &&
        !invocationTracker.isTimedOut?.(threadId, catId),
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
    let actionFencePreflightRejected = false;
    let actionFenceAggregateSucceeded = false;
    const actionFenceCommittedHolderCatIds = new Set<string>();
    const actionFenceOutputValidatedHolderCatIds = new Set<string>();
    const lifecycleInputMessageIds = [
      ...(entry.payload.messageId ? [entry.payload.messageId] : []),
      ...batchedMessageIds,
    ];
    const lifecycleResponseMessageIds = new Set<string>();
    // The response each target is currently streaming into. Every event a target
    // streams names this message, so clients write by id instead of guessing.
    const lifecycleResponseMessageIdByCat = new Map<string, string>();
    const terminalInvocationIdByCatId: Record<string, string> = {};
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
        terminalInvocationIdByCatId,
      };
      returnedExecutionResult = result;
      return result;
    };
    const refuseDeploymentWaitStart = async (
      decision: Extract<DeploymentWaitStartDecision, { ok: false }>,
    ): Promise<QueueExecutionResult> => {
      finalStatus = decision.reason === 'evidence_stale' ? 'failed' : 'canceled';
      if (invocationId) await invocationRecordStore.update(invocationId, { status: finalStatus });
      if (decision.reason === 'evidence_stale') {
        // Nothing reached a response. Retain the exact pending owner when
        // runtime readiness is unknown, including if restoration itself fails.
        prestartClaimRestored = true;
        if (!(await queue.restoreClaimedEntries(threadId, [entry.id, ...batchedEntryIds]))) {
          throw new Error('deployment readiness refusal could not restore the exact Queue claim');
        }
      } else {
        await this.cancelMessageIds([messageId!], log, 'deployment_wait_authority_stale');
      }
      return executionResult(finalStatus);
    };
    const cancelPrestartTargetSetConflict = async (message: string): Promise<QueueExecutionResult> => {
      if (!invocationId) throw new Error('pre-start target-set conflict requires an invocation record');
      finalStatus = 'canceled';
      const stillOwnsPrimaryReservation = Boolean(
        processingReservation &&
          this.ownsProcessingSlotInvocation(
            QueueProcessor.slotKey(threadId, primaryCat),
            processingReservation,
            invocationId,
          ),
      );
      if (stillOwnsPrimaryReservation) {
        if (entry.execution.liveSessionId) {
          await this.terminalizeUnavailableConversationHead(entry, 'explicit', true);
          await invocationRecordStore.update(invocationId, {
            status: 'canceled',
            error: 'live_immediate_slot_unavailable',
          });
          return executionResult('canceled');
        }
        if (!(await queue.restoreClaimedEntries(threadId, [entry.id, ...batchedEntryIds]))) {
          throw new Error('pre-start target-set conflict could not restore the exact Queue claim');
        }
        prestartClaimRestored = true;
      } else {
        processingReservationReplaced = true;
      }
      log.info(
        {
          threadId,
          entryId: entry.id,
          invocationId,
          reason: stillOwnsPrimaryReservation ? 'target_became_busy' : 'reservation_replaced',
        },
        message,
      );
      await invocationRecordStore.update(invocationId, {
        status: 'canceled',
        error: stillOwnsPrimaryReservation ? 'queue_target_became_busy' : 'queue_processing_reservation_replaced',
      });
      const result = executionResult('canceled');
      if (stillOwnsPrimaryReservation) result.primarySettlementIncomplete = true;
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

      if (queueEntrySource(entry) === 'connector' && messageId) {
        let decision: DeploymentWaitStartDecision = { ok: false, reason: 'evidence_stale' };
        try {
          decision = await checkDeploymentWaitStart(
            {
              messageId,
              threadId,
              userId,
              catId: primaryCat,
              expectedWaitCarrier: !!entry.execution.waitContinuationCarrier,
            },
            { guard: this.deps.deploymentWaitStartGuard, messageStore: this.deps.messageStore },
          );
        } catch (error) {
          log.warn({ error, messageId }, '[F323] queued deployment wait start guard unavailable');
        }
        if (!decision.ok) return await refuseDeploymentWaitStart(decision);
      }

      // 1. Create InvocationRecord (before batching — avoid claiming entries on duplicate)
      // Invocation identity is source × target: one source row can dispatch its
      // pending targets independently without treating a sibling as a replay.
      const source = queueEntrySource(entry);
      const connectorReplayCarrier = source === 'connector' || entry.sourceCategory === 'scheduled';
      const actionSuccessorKey =
        entry.execution.actionSuccessorFence && entry.payload.sourceRecordId
          ? actionSuccessorInvocationKeyForTarget(entry.payload.sourceRecordId, primaryCat)
          : undefined;
      const idempotencyKey =
        connectorReplayCarrier && messageId
          ? `connector-${messageId}:${primaryCat}`
          : actionSuccessorKey
            ? actionSuccessorKey
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
        let existing: InvocationRecord | null;
        let pendingSource: StoredMessage | null;
        // A failed preparation can leave the same durable input pending. Source kind does not
        // decide its retry authority: canonical History must prove this target was never handed
        // off. Unknown History preserves the claim rather than creating another receiver.
        try {
          existing = invocationRecordStore.get ? await invocationRecordStore.get(invocationId) : null;
          pendingSource = messageId ? await messageStore.getById(messageId) : null;
        } catch (error) {
          lifecycleAdmissionUnknown = true;
          throw error;
        }
        const pendingInputReplay =
          pendingSource?.lifecycle?.kind === 'input' &&
          pendingSource.userId === userId &&
          pendingSource.threadId === threadId &&
          pendingSource.deliveryStatus === 'queued' &&
          existing?.userMessageId === messageId &&
          !pendingSource.lifecycle.dispatchRefs?.some((ref) => targetCats.includes(ref.targetId as CatId));
        const replayEligible =
          (connectorReplayCarrier && Boolean(messageId)) ||
          Boolean(entry.execution.actionSuccessorFence) ||
          pendingInputReplay;
        if (
          !replayEligible ||
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
        return cancelPrestartTargetSetConflict(
          '[QueueProcessor] canceled pre-start execution after processing reservation changed',
        );
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
        return cancelPrestartTargetSetConflict(
          '[QueueProcessor] canceled pre-start execution after its target-set fence changed',
        );
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
          return cancelPrestartTargetSetConflict(
            '[QueueProcessor] canceled parked execution after its target-set fence changed',
          );
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

      try {
        for (const queueEntryId of [entry.id, ...batchedEntryIds]) {
          const queueEntry =
            queue.getEntrySnapshot(threadId, userId, queueEntryId) ?? (queueEntryId === entry.id ? entry : null);
          if (queueEntry) {
            for (const sourceId of queueEntryMessageIds(queueEntry)) {
              const source = await messageStore.getById(sourceId);
              if (
                source &&
                targetCats.some((catId) => !canViewMessage(source, { type: 'cat', catId: catId as CatId }))
              ) {
                throw new Error('Queue execution target cannot view its source');
              }
            }
            await this.ensureAttemptMessageCustody(queueEntry);
          }
        }
      } catch (error) {
        // Provider admission did not happen. Unknown/missing source evidence
        // cannot consume the pending work as a failed delivery or business result.
        prestartClaimRestored = await queue.restoreClaimedEntries(threadId, [entry.id, ...batchedEntryIds]);
        if (!prestartClaimRestored)
          throw new Error('source admission claim restoration did not converge', { cause: error });
        throw error;
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
      // #845 fix: per-cat token usage from done events (same pattern as messages.ts).
      // Without this, queued/connector invocations succeed without writing usageByCat, leaving 159+ orphans
      // in the daily usage report.
      const collectedUsage = new Map<string, TokenUsage>();
      // F070 parity with messages.ts: governance gate reports terminal retryability via done.errorCode.
      // QueueProcessor must honor that terminal signal instead of falling through to succeeded.
      let governanceErrorCode: string | undefined;

      // F088 fix: Track per-turn content for outbound delivery (same pattern as the connector delivery path)
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
      if (this.deps.streamingHook && !entry.execution.actionSuccessorFence) {
        streamStartPromise = this.deps.streamingHook
          .onStreamStart(threadId, primaryCat, invocationId, queueEntrySenderMeta(entry))
          .catch((err) => {
            log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamStart failed');
          });
      }

      // F151: Mid-loop delivery to preserve ordering (same fix as the connector delivery path)
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

      const callerDispatchProjectionByCat = new Map<string, CallerDispatchObservationProjection>();
      const callerDispatchProcessStartPromptCats = new Set<string>();
      const callerDispatchPromptByCat: Record<string, string> = {};
      for (const catId of targetCats) {
        const scope = {
          ownerId: userId,
          threadId,
          callerCatId: catId,
        };
        const processStart = this.callerDispatchProcessStart
          ? this.callerDispatchObservations.projectProcessStartNotice(
              scope,
              this.callerDispatchProcessStart.processGenerationId,
            )
          : undefined;
        const projection = await this.callerDispatchObservations.project(messageStore, scope);
        callerDispatchProjectionByCat.set(catId, projection);
        if (processStart?.prompt) callerDispatchProcessStartPromptCats.add(catId);
        const prompt = [processStart?.prompt, projection.prompt].filter(Boolean).join('\n\n');
        if (prompt) callerDispatchPromptByCat[catId] = prompt;
      }

      if (queueEntrySource(entry) === 'connector' && messageId) {
        let decision: DeploymentWaitStartDecision = { ok: false, reason: 'evidence_stale' };
        try {
          decision = await checkDeploymentWaitStart(
            {
              messageId,
              threadId,
              userId,
              catId: primaryCat,
              expectedWaitCarrier: !!entry.execution.waitContinuationCarrier,
            },
            { guard: this.deps.deploymentWaitStartGuard, messageStore: this.deps.messageStore },
          );
        } catch (error) {
          log.warn({ error, messageId }, '[F323] queued deployment wait execution guard unavailable');
        }
        if (!decision.ok) return await refuseDeploymentWaitStart(decision);
      }
      const admissionEntries = [entry.id, ...batchedEntryIds].map((entryId) => {
        const current = queue.getEntrySnapshot(threadId, userId, entryId);
        if (!current || current.status !== 'claimed') {
          throw new Error(`Queue admission requires one exact claimed owner: ${entryId}`);
        }
        return current;
      });
      const deliveryTimeByMessageId = this.queueAdmissionDeliveryTimes(admissionEntries);
      // From here failures restore the exact claimed targets. History publication
      // remains deferred until the provider accepts and the receiver exists.
      lifecycleTransferStarted = true;
      const HEARTBEAT_INTERVAL_MS = 30_000;
      heartbeatInterval = setInterval(() => {
        socketManager.broadcastToRoom(`thread:${threadId}`, 'heartbeat', {
          threadId,
          timestamp: Date.now(),
        });
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatInterval.unref();

      routePreparationStartedAt = performance.now();
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
          ...(liveCall ? { liveCompanion: liveCall } : {}),
          ownerAuthProvenance: entry.execution.ownerAuthProvenance,
          humanDispositionInvocationOrigin: 'queue_replay',
          routingQueueSource: source,
          ...(entry.execution.executionScope ? { executionScope: entry.execution.executionScope } : {}),
          ...(memoryCueOpportunitySeeds.length > 0 ? { memoryCueOpportunitySeeds } : {}),
          ...(asrPersonMemoryScenes.length > 0 ? { asrPersonMemoryScenes } : {}),
          ...(Object.keys(callerDispatchPromptByCat).length > 0
            ? { modeSystemPromptByCat: callerDispatchPromptByCat }
            : {}),
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
          // F117 KD-22 (J4): a member's own invocation owns its output timeout; when it fires, the
          // Queue stops only that member, and only while its slot still runs this execution.
          ...(invocationTracker.getExecutionId && invocationTracker.cancel
            ? {
                stopMember: createMemberTimeoutStop({
                  invocationTracker: {
                    getExecutionId: (tid, catId) => invocationTracker.getExecutionId?.(tid, catId),
                    cancel: (tid, catId, requestUserId, abortReason) =>
                      invocationTracker.cancel?.(tid, catId, requestUserId, abortReason) ?? { cancelled: false },
                  },
                  threadId,
                  ownerUserId: userId,
                  log,
                }),
              }
            : {}),
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
          targetDispatchMode: targetCats.length > 1 ? 'parallel' : 'serial',
          onLifecycleInvocationStarted: async (
            input: Parameters<NonNullable<RouteOptions['onLifecycleInvocationStarted']>>[0],
          ) => {
            const responseAdmissionStartedAt = performance.now();
            let interruptLifecycleResponse: ((reason: string) => Promise<void>) | undefined;
            let lifecycleResponseInterrupted = false;
            let lifecycleTargetRetired = false;
            try {
              const lifecycleInputMessages = (
                await Promise.all(messageIds.map((inputMessageId) => messageStore.getById(inputMessageId)))
              ).filter((message): message is StoredMessage =>
                Boolean(
                  message &&
                    (isTimelinePublished(message) || message.deliveryStatus === 'queued') &&
                    message.visibility !== 'whisper' &&
                    !message.recall &&
                    !message._tombstone,
                ),
              );
              const lifecycleReplyToCandidate = entry.execution.a2aTriggerMessageId ?? messageId;
              const lifecycleReplyTo = lifecycleInputMessages.some(
                (message) => message.id === lifecycleReplyToCandidate,
              )
                ? lifecycleReplyToCandidate
                : undefined;
              const latestInputTimelineOrderAt = Math.max(
                input.startedAt,
                ...lifecycleInputMessages.map((message) => {
                  if (message.deliveryStatus !== 'queued') return getTimelineOrderTime(message);
                  const deliveredAt = deliveryTimeByMessageId.get(message.id);
                  if (deliveredAt === undefined) {
                    throw new Error(`Queue admission missing source delivery clock: ${message.id}`);
                  }
                  return resolveDeliveryTimelineScore(message, deliveredAt);
                }),
              );
              const observed = await appendLifecycleResponseWithReadBack(messageStore, {
                from: { kind: 'agent', catId: input.catId },
                userId: input.userId,
                content: '',
                mentions: [],
                origin: 'stream',
                timestamp: input.startedAt,
                threadId: input.threadId,
                ...(lifecycleReplyTo ? { replyTo: lifecycleReplyTo } : {}),
                idempotencyKey: lifecycleResponseIdempotencyKey(input.invocationId),
                extra: {
                  ...(lifecycleReplyTo && queueEntryCallerCatId(entry)
                    ? {
                        a2aFailureReturn: {
                          triggerMessageId: lifecycleReplyTo,
                          callerCatId: queueEntryCallerCatId(entry)!,
                          ownerAuthProvenance: entry.execution.ownerAuthProvenance,
                          parentInvocationId: input.parentInvocationId,
                          isFailureReport: entry.sourceCategory === 'a2a_failure',
                        },
                      }
                    : {}),
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
                  latestInputTimelineOrderAt,
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
              lifecycleResponseMessageIdByCat.set(input.catId, observed.message.id);
              terminalInvocationIdByCatId[input.catId] = input.invocationId;
              lifecycleReceiverPersisted = true;
              interruptLifecycleResponse = async (reason: string): Promise<void> => {
                const terminal = await messageStore.commitLifecycleResponseTerminal(observed.message.id, {
                  invocationId: input.invocationId,
                  status: 'interrupted',
                  completedAt: Date.now(),
                  reason,
                  content: '',
                  extra: observed.message.extra,
                  mentions: [],
                  origin: 'stream',
                });
                if (terminal.kind !== 'applied' && terminal.kind !== 'replayed') {
                  throw new Error(
                    `Lifecycle response interruption conflict: ${input.invocationId}:${terminal.kind}:${'reason' in terminal ? terminal.reason : 'missing'}`,
                  );
                }
                await settleLifecycleResponseInputs(messageStore, terminal.message, observed.message.id);
                lifecycleResponseInterrupted = true;
              };
              await this.admitQueueEntriesForProvider(deliveryTimeByMessageId);
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
                  await interruptLifecycleResponse('input_dispatch_projection_conflict');
                  throw new Error(
                    `Lifecycle input dispatch conflict: ${inputMessage.id}:${transition.kind}:${'reason' in transition ? transition.reason : 'missing'}`,
                  );
                }
                lifecycleInputSnapshots.push(transition.message);
                this.callerDispatchObservations.registerPersistedSource(transition.message, [input.catId]);
              }
              // ADR-043 D4: the durable response + dispatchRef is this target's
              // cutover boundary. Retire only this target while the source claim
              // continues to protect siblings that have not reached admission.
              const retirements = [];
              for (const admissionEntry of admissionEntries) {
                const retirement = await queue.retireClaimedLifecycleTarget(
                  input.threadId,
                  admissionEntry.id,
                  input.catId,
                  Date.now(),
                );
                if (retirement.outcome !== 'retired') {
                  throw new Error(
                    `Lifecycle receiver persisted but Queue target retirement changed: ${input.invocationId}`,
                  );
                }
                retirements.push(retirement);
              }
              lifecycleTargetRetired = true;
              log.info(
                {
                  threadId: input.threadId,
                  entryId: entry.id,
                  catId: input.catId,
                  invocationId: input.invocationId,
                  responseMessageId: observed.message.id,
                  queueAgeMs: Date.now() - entry.enqueuedAt,
                  queuePreparationMs: routePreparationStartedAt - executionPreparationStartedAt,
                  routePreparationMs: responseAdmissionStartedAt - routePreparationStartedAt,
                  responseAdmissionMs: performance.now() - responseAdmissionStartedAt,
                },
                'Delivery admission timing',
              );
              if (retirements.every((retirement) => retirement.rowStatus === 'absent')) {
                lifecycleQueueTargetsRetired = true;
              }
              if (retirements.some((retirement) => retirement.rowStatus !== 'claimed')) {
                // A closed or restored claim makes the next source eligible for
                // a normal try-drain. The coordinator coalesces concurrent calls.
                void this.requestDrain(threadId);
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
                await interruptLifecycleResponse('active_run_owner_mismatch');
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
              const delivery = await this.markDeliveredAndEmit(
                input.userId,
                input.threadId,
                messageIds,
                input.startedAt,
                new Set(messageIds),
              );
              if (delivery.failedIds.length > 0) {
                throw new Error(`Lifecycle cutover failed to publish History sources: ${delivery.failedIds.join(',')}`);
              }
              for (const inputSnapshot of lifecycleInputSnapshots) {
                this.emitLifecycleMessageUpdated(input.userId, inputSnapshot);
              }
              this.emitLifecycleMessageUpdated(input.userId, observed.message);
              try {
                await emitQueueUpdated(
                  socketManager,
                  input.userId,
                  input.threadId,
                  queue.list(input.threadId, input.userId),
                  'processing',
                );
              } catch (err) {
                log.warn(
                  { err, threadId: input.threadId, invocationId: input.invocationId },
                  '[QueueProcessor] lifecycle handoff committed but Queue projection emit failed',
                );
              }
              return {
                responseMessageId: observed.message.id,
                priorFrontierMessageId: observed.priorFrontierMessageId,
                activeRun,
              };
            } catch (error) {
              if (error instanceof LifecycleResponseAdmissionUnknownError) {
                lifecycleAdmissionUnknown = true;
                throw error;
              }
              if (!lifecycleTargetRetired) {
                lifecycleClaimRestorePromise ??= (async () => {
                  const entryIds = admissionEntries.map((candidate) => candidate.id);
                  if (await queue.restoreClaimedEntries(input.threadId, entryIds)) return true;
                  const durableRows = await Promise.all(
                    entryIds.map((entryId) => queue.getDurableEntry(input.threadId, entryId)),
                  );
                  return durableRows.every((row) => !row || row.status === 'queued');
                })();
                if (await lifecycleClaimRestorePromise) {
                  void this.requestDrain(input.threadId);
                } else {
                  log.error(
                    { threadId: input.threadId, invocationId: input.invocationId },
                    '[QueueProcessor] target admission failed and Queue claim did not restore',
                  );
                }
              }
              if (interruptLifecycleResponse && !lifecycleResponseInterrupted) {
                try {
                  await interruptLifecycleResponse('queue_target_retirement_pending');
                } catch (interruptError) {
                  log.warn(
                    { interruptError, threadId: input.threadId, invocationId: input.invocationId },
                    '[QueueProcessor] failed to interrupt lifecycle response after target admission failure',
                  );
                }
              }
              throw error;
            }
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
            // A queued guidance request can predate provider turn acceptance.
            // Publish readiness to the same owner that handles every ingress.
            void this.requestDrain(threadId).catch((err) =>
              log.error(
                { err, threadId, catId },
                '[QueueProcessor] Agent Client readiness failed to signal Queue progress',
              ),
            );
            return release;
          },
          onPromptMessagesExposed: (input: PromptMessagesExposedInput) => this.markPromptMessagesSeen(input),
          ...(entry.execution.a2aTriggerMessageId ? { a2aTriggerMessageId: entry.execution.a2aTriggerMessageId } : {}),
          ...(entry.execution.a2aTriggerMessageId && queueEntryCallerCatId(entry)
            ? { a2aCallerCatId: queueEntryCallerCatId(entry) }
            : {}),
          ...(entry.execution.callerTraceContext ? { callerTraceContext: entry.execution.callerTraceContext } : {}),
          ...(entry.execution.cloudDispatchProvenance
            ? { cloudDispatchProvenance: entry.execution.cloudDispatchProvenance }
            : {}),
          ...(entry.execution.requiresExactCloudDispatchProvenance
            ? { requiresExactCloudDispatchProvenance: true }
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
        if (!intentModeBroadcast) {
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
        // and the connector delivery path. Without this, queue-* and connector-* invocations
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
          // F151: Deliver completed cat's turns immediately (same fix as the connector delivery path)
          if (this.deps.outboundHook && !entry.execution.actionSuccessorFence) {
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
          if (this.deps.streamingHook && !entry.execution.actionSuccessorFence) {
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
        // An event that already names its own stored message (a persisted system
        // row, the done of a committed turn) keeps it; every other event of an
        // admitted target belongs to that target's response.
        const responseMessageId =
          typeof msg.catId === 'string' && !msg.messageId ? lifecycleResponseMessageIdByCat.get(msg.catId) : undefined;
        const visibleMessage = {
          ...msg,
          ...(invocationId ? stampVisibleTurn(invocationId, msgInvocationId) : {}),
          ...(responseMessageId ? { messageId: responseMessageId } : {}),
        };
        // History owns one response lifecycle for every admitted dispatch.
        // Action-successor custody may still accept/reject the terminal commit,
        // but it must not create a second, terminal-only presentation protocol.
        socketManager.broadcastAgentMessage(visibleMessage, threadId);
        // A target's done follows its response commit: publish that committed truth
        // now instead of when the whole entry (every sibling target) settles.
        const doneResponseMessageId =
          msg.type === 'done' && typeof msg.catId === 'string'
            ? lifecycleResponseMessageIdByCat.get(msg.catId)
            : undefined;
        if (doneResponseMessageId) {
          try {
            const committed = await messageStore.getById(doneResponseMessageId);
            if (committed?.lifecycle?.kind === 'response' && committed.lifecycle.status !== 'processing') {
              this.emitLifecycleMessageUpdated(userId, committed);
            }
          } catch (err) {
            log.warn(
              { err, threadId, responseMessageId: doneResponseMessageId },
              '[QueueProcessor] failed to publish a committed response at its done',
            );
          }
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
      }

      // 9. Ack cursors + mark succeeded
      await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
      await requireInvocationRecordUpdate({
        store: invocationRecordStore,
        invocationId,
        update: {
          status: 'succeeded',
          successfulCatIds: terminalDispositions.getSuccessfulCatIds() as CatId[],
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
          const assistantText = (
            outboundTurns.length > 0 ? flattenTurnTextParts(outboundTurns) : flattenTextParts(collectedTextParts)
          ).trim();
          {
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

      const successfulCatIds = new Set(terminalDispositions.getSuccessfulCatIds());
      for (const [catId, projection] of callerDispatchProjectionByCat) {
        if (successfulCatIds.has(catId as CatId)) {
          this.callerDispatchObservations.acknowledge(projection.included);
          if (callerDispatchProcessStartPromptCats.has(catId) && this.callerDispatchProcessStart) {
            this.callerDispatchObservations.acknowledgeProcessStartNotice(
              { ownerId: userId, threadId, callerCatId: catId },
              this.callerDispatchProcessStart.processGenerationId,
            );
          }
        }
      }

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
      const errMsg = isPermanentCollectiveQueueRefusal(err)
        ? collectiveQueueRefusalError(err)
        : err instanceof Error
          ? err.message
          : String(err);
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
        if (exposeFailure) {
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
      // F117 KD-21: the route threw before committing its responses. Each R it left processing ends
      // now rather than waiting for the next restart; a fenced action whose failure stays hidden
      // keeps its output uncommitted.
      await this.settleAbandonedResponses(
        userId,
        threadId,
        lifecycleResponseMessageIds,
        exposeFailure ? 'failed' : 'output_rejected',
      );

      // R4 fix (#873): correct failure cleanup sequence per messages.ts
      // cleanupStreamingOnFailure — onStreamEnd moves sessions from active →
      // pendingCleanup; cleanupPlaceholders only acts on pendingCleanup, so
      // calling it alone is a no-op when sessions are still active.
      await this.cleanupStreamingOnFailure(threadId, invocationId, streamStartPromise, log);

      // R3 P2 fix (#873): Deliver error message to external IM so user sees
      // a reply instead of silence (mirrors the connector delivery error path).
      // R6 fix: timeout prevents adapter hang from pinning queue slot (Cloud P1).
      if (this.deps.outboundHook && exposeFailure) {
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
      await liveCall?.stop();
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
          await this.releaseSettledResponseTurn(lifecycleMessage, log);
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
      if (!processingReservationReplaced && !prestartClaimRestored) {
        try {
          const preReceiverUserCancel =
            lifecycleTransferStarted && !lifecycleReceiverPersisted && finalStatus === 'canceled_by_user';
          if (isPermanentCollectiveQueueRefusal(executionError) && !lifecycleReceiverPersisted && invocationId) {
            const refusal = executionError;
            const refusalInvocationId = invocationId;
            if (batchedEntryIds.length !== 0) throw new Error('Collective refusal cannot retire a batched claim');
            const current = queue.getEntrySnapshot(threadId, userId, entry.id);
            if (
              !current ||
              !(await retireRefusedCollectiveQueueCarrier({
                entry: current,
                queue,
                messages: messageStore,
                refusal,
                persistRefusal: () =>
                  persistCollectiveRefusalRecord({
                    store: invocationRecordStore,
                    invocationId: refusalInvocationId,
                    entry: current,
                    refusal,
                  }),
              }))
            )
              throw new Error('Collective refusal claim retirement did not commit');
          } else if (lifecycleAdmissionUnknown) {
            // The original short claim fences an uncertain durable commit until canonical recovery.
            if (returnedExecutionResult) returnedExecutionResult.primarySettlementIncomplete = true;
          } else if (lifecycleTransferStarted && !lifecycleReceiverPersisted && !preReceiverUserCancel) {
            if (!(await queue.restoreClaimedEntries(threadId, [entry.id, ...batchedEntryIds]))) {
              throw new Error('pre-receiver Queue claim restoration did not converge');
            }
            // The body remains pending by design. Do not immediately hot-loop
            // the same failed pre-receiver transfer from onInvocationComplete.
            if (returnedExecutionResult) returnedExecutionResult.primarySettlementIncomplete = true;
          } else if (lifecycleReceiverPersisted && !lifecycleQueueTargetsRetired) {
            if (
              !(await queue.reconcileClaimedLifecycleTargets(threadId, [entry.id, ...batchedEntryIds], messageStore))
            ) {
              throw new Error('post-receiver Queue target reconciliation did not converge');
            }
            // Accepted siblings are retired; only a source still queued without
            // its receiver needs the existing failed-handoff backoff.
            if (returnedExecutionResult) {
              returnedExecutionResult.primarySettlementIncomplete = [entry.id, ...batchedEntryIds].some(
                (id) => queue.getEntrySnapshotAcrossUsers(threadId, id)?.status === 'queued',
              );
            }
          } else {
            await this.settleAttemptQueueEntry(entry, finalStatus);
          }
        } catch (err) {
          log.error(
            { err, threadId, queueEntryId: entry.id, finalStatus },
            '[QueueProcessor] Queue attempt settlement failed closed; durable nonterminal row needs recovery',
          );
          if (returnedExecutionResult) returnedExecutionResult.primarySettlementIncomplete = true;
        }
      } else if (processingReservationReplaced) {
        log.info(
          { threadId, queueEntryId: entry.id, invocationId },
          '[QueueProcessor] skipped stale Queue settlement after durable retirement barrier replaced the attempt',
        );
      } else {
        if (returnedExecutionResult) returnedExecutionResult.primarySettlementIncomplete = true;
        log.info(
          { threadId, queueEntryId: entry.id, invocationId },
          '[QueueProcessor] kept the exact Queue entry pending after pre-start admission was refused',
        );
      }
      // F175 batch members settle through the same per-entry decision as the primary.
      const restorePreReceiverBatch =
        lifecycleTransferStarted && !lifecycleQueueTargetsRetired && finalStatus !== 'canceled_by_user';
      for (const bid of processingReservationReplaced || prestartClaimRestored || restorePreReceiverBatch
        ? []
        : batchedEntryIds) {
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
      await emitQueueUpdated(socketManager, userId, threadId, queue.list(threadId, userId), 'completed');
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
   * Mirrors the connector delivery ⑥ logic: per-turn delivery, streaming cleanup, late-success fallback.
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
    const deliverableTurnEntries = outboundTurns.map((turn, originalIndex) => ({ turn, originalIndex }));
    const finalContent =
      outboundTurns.length > 0 ? flattenTurnTextParts(outboundTurns) : flattenTextParts(collectedTextParts);

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
    } else {
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
