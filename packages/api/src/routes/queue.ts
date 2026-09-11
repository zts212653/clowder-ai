/**
 * Queue Management API Routes (F39)
 *
 * GET    /api/threads/:threadId/queue               → 列出队列条目
 * DELETE /api/threads/:threadId/queue/:entryId       → 撤回条目
 * GET    /api/threads/:threadId/queue/:entryId/targets → 读取同源逐目标终局/待处理真相
 * POST   /api/threads/:threadId/queue/:entryId/targets → 原子绑定/扩展同源逐目标 Steer 工单
 * POST   /api/threads/:threadId/queue/:entryId/steer → Steer queued entry（取消当前轮并以同一消息立即启动）
 * POST   /api/threads/:threadId/queue/:entryId/continue → 立即引导当前回复，或保留为排队等待
 * POST   /api/threads/:threadId/queue/:entryId/append → Append queued entry into exact existing Active Run(s)
 * PATCH  /api/threads/:threadId/queue/:entryId/move → 重排序（上移/下移）
 * PATCH  /api/threads/:threadId/queue/reorder       → F175: 批量设置 position（拖拽重排）
 * DELETE /api/threads/:threadId/queue               → 清空队列
 * POST   /api/threads/:threadId/cancel/:catId       → F122B AC-B9: Per-cat cancel
 */

import { randomUUID } from 'node:crypto';
import type { CatId, FreshnessCarrierCapability } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type AgentSessionMutexLike,
  agentSessionMutex,
} from '../domains/cats/services/agents/invocation/AgentSessionMutex.js';
import {
  type ActiveInvocationProjection,
  type InvocationRegistryPort,
  type InvocationTrackerLike,
  resolveActiveInvocations,
} from '../domains/cats/services/agents/invocation/active-execution-service.js';
import {
  type InvocationQueue,
  isSystemPinnedQueueEntry,
  type QueueEntry,
  queueEntryMessageIds,
  queueEntryOwnerId,
  queueEntryTargetCats,
} from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import { DEFAULT_PRESTART_RESERVATION_TTL_MS } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  projectLifecycleAppendAction,
  projectLifecycleAppendCapability,
} from '../domains/cats/services/agents/invocation/lifecycle-append-projection.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { queueEntryId } from '../domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  type IMessageStore,
  type StoredMessage,
  settleLifecycleResponseInputs,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import type { DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import { buildCancelMessages, type SocketManager } from '../infrastructure/websocket/index.js';
import type { CliExecutionOwnerService, LiveCliExecutionOwner } from '../utils/cli-process-ownership.js';
import {
  emitQueueUpdated,
  enrichQueueEntries,
  isPublicQueueEntry,
  projectPublicQueueEntry,
} from '../utils/queue-enrichment.js';
import { resolveUserId } from '../utils/request-identity.js';
import { type LiveExecutionCandidate, registerActiveExecutionRoutes } from './active-execution-routes.js';
import { getMultiMentionOrchestrator } from './callback-multi-mention-routes.js';
import { resolveQueueAuthorIntentByCatId } from './message-disposition-admission.js';
import { admitThreadParticipants } from './thread-participant-admission.js';

interface ManagedCommandWakeRecoveryLike {
  retireCarrier(messageIds: readonly string[], reason: 'withdrawn'): Promise<number>;
  retireThread(
    threadId: string,
    userId: string,
    reason: 'force_reset',
  ): Promise<{ retired: number; messageIds: string[] }>;
}

export interface QueueRoutesOptions {
  threadStore: IThreadStore;
  invocationQueue: InvocationQueue;
  queueProcessor: QueueProcessor;
  invocationTracker: InvocationTrackerLike;
  /** Exact concrete provider carrier used by active-turn composer/reminder surfaces. */
  resolveCarrierCapability?: (catId: CatId) => FreshnessCarrierCapability | undefined;
  /** Current roster availability, rechecked when a Steer plan is committed. */
  isCatAvailable?: (catId: CatId) => boolean;
  /** Shared owner-aware session lock released by explicit terminal actions. */
  agentSessionMutex?: AgentSessionMutexLike;
  socketManager: SocketManager;
  /** MessageStore supplies History preview/lifecycle truth; Queue withdrawal never deletes author history. */
  messageStore?: IMessageStore;
  /** F194 Phase B: canonical liveness read sources (record + draft). When omitted,
   *  GET /queue's activeInvocations falls back to legacy tracker-only enumeration
   *  for backward compat in tests. */
  invocationRecordStore?: IInvocationRecordStore;
  draftStore?: IDraftStore;
  /** Durable per-child lifecycle truth used to bridge tracker/draft handoff gaps. */
  turnExecutionStore?: Pick<ITurnExecutionStore, 'listByParent' | 'transitionTerminal'>;
  /** F194 Phase Z (KD-22): InvocationRegistry — provides namespace bridge between
   *  parent recordStore invocation and per-cat-turn child registry invocation.
   *  When wired, helper uses parentInvocationId / latestId to detect parent+child
   *  chain liveness and cat-slot reuse zombies. Optional for backward compat;
   *  fall-back to single-namespace classification when absent. */
  invocationRegistry?: InvocationRegistryPort;
  /** Existing managed-wake receipt owner; late-bound after ConnectorInvokeTrigger composition. */
  getManagedCommandWakeRecovery?: () => ManagedCommandWakeRecoveryLike | undefined;
  /** F295: existing durable task truth used only to project active managed commands. */
  dynamicTaskStore?: Pick<DynamicTaskStore, 'getAll'>;
  /**
   * F297 AC-D3: the one composition service. Supplying it lets the 4s project scan reuse the
   * same sparse candidate algorithm as Sidebar without rereading managed-command truth twice.
   */
  activeExecutionService?: {
    buildLiveCandidateSnapshot(userId: string): Promise<{ threadIds: readonly string[]; complete: boolean }>;
  };
  /** Durable OS owner truth used when the in-memory tracker handle is gone. */
  cliExecutionOwnerService?: CliExecutionOwnerService;
}

function liveExecutionCandidateKey(candidate: Pick<LiveExecutionCandidate, 'catId' | 'executionId'>): string {
  return `${candidate.catId}\u0000${candidate.executionId ?? ''}`;
}

interface ProcessOwnerSnapshot {
  readonly owners: readonly LiveCliExecutionOwner[];
  readonly complete: boolean;
}

const processOwnerSnapshotByRequest = new WeakMap<FastifyRequest, Promise<ProcessOwnerSnapshot>>();
const CONTROL_PLANE_RETRY_ATTEMPTS = 3;
const CONTROL_PLANE_RETRY_DELAY_MS = 50;

type ExecutionFailureReason = 'control_plane_unavailable' | 'execution_owner_lost';

function executionFailureExplanation(reason: ExecutionFailureReason): string {
  return reason === 'control_plane_unavailable' ? '执行控制面不可用' : '执行进程归属已丢失';
}

function completeExecutionFailureContent(response: StoredMessage, reason: ExecutionFailureReason): string {
  const existing = response.content.trim();
  const failureMessage = executionFailureExplanation(reason);
  return [existing, ...(!existing.includes(failureMessage) ? [failureMessage] : [])].filter(Boolean).join('\n\n');
}

async function waitForControlPlaneRetry(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, CONTROL_PLANE_RETRY_DELAY_MS));
}

async function processOwnerSnapshotForRequest(
  request: FastifyRequest,
  service: CliExecutionOwnerService | undefined,
): Promise<ProcessOwnerSnapshot> {
  if (!service) return { owners: [], complete: true };
  const cached = processOwnerSnapshotByRequest.get(request);
  if (cached) return cached;
  const pending = service
    .listLive()
    .then((snapshot) => ({ owners: snapshot.owners, complete: snapshot.complete }))
    .catch((err) => {
      request.log.warn({ err }, 'CLI execution owner snapshot unavailable; active execution scan will fail open');
      return { owners: [], complete: false };
    });
  processOwnerSnapshotByRequest.set(request, pending);
  return pending;
}

async function retryProcessOwnerSnapshot(
  request: FastifyRequest,
  service: CliExecutionOwnerService | undefined,
): Promise<ProcessOwnerSnapshot> {
  if (!service) return { owners: [], complete: true };
  let latest = await processOwnerSnapshotForRequest(request, service);
  for (let attempt = 1; !latest.complete && attempt < CONTROL_PLANE_RETRY_ATTEMPTS; attempt += 1) {
    await waitForControlPlaneRetry();
    try {
      const snapshot = await service.listLive();
      latest = { owners: snapshot.owners, complete: snapshot.complete };
    } catch (err) {
      request.log.warn({ err, attempt }, 'CLI execution owner retry failed');
      latest = { owners: [], complete: false };
    }
  }
  processOwnerSnapshotByRequest.set(request, Promise.resolve(latest));
  return latest;
}

function emitLifecycleMessageUpdated(socketManager: SocketManager, userId: string, message: StoredMessage): void {
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
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    },
  });
}

function projectCanonicalLiveCandidate(
  threadId: string,
  fallbackUserId: string,
  candidate: ActiveInvocationProjection,
  tracker: InvocationTrackerLike,
): LiveExecutionCandidate {
  const ownerUserId = tracker.getUserId(threadId, candidate.catId) ?? fallbackUserId;
  const trackerExecutionId = tracker.getExecutionId?.(threadId, candidate.catId);
  const append = projectLifecycleAppendCapability({
    threadId,
    userId: fallbackUserId,
    targetId: candidate.catId,
    activeRun: candidate.activeRun,
    invocationTracker: tracker,
  });
  return {
    ...candidate,
    ownerUserId,
    controlSource: candidate.executionId && trackerExecutionId === candidate.executionId ? 'tracker' : 'unavailable',
    ...(append.available ? { inputCapabilities: { append: append.capability } } : {}),
  };
}

async function resolveLiveExecutionCandidates(
  threadId: string,
  userId: string,
  request: FastifyRequest,
  opts: QueueRoutesOptions,
): Promise<LiveExecutionCandidate[]> {
  const canonical = await resolveActiveInvocations(
    threadId,
    userId,
    opts.invocationTracker,
    opts.invocationRecordStore,
    opts.draftStore,
    opts.turnExecutionStore,
    request.log,
    opts.invocationRegistry,
  );
  const byExecution = new Map<string, LiveExecutionCandidate>();
  for (const candidate of canonical) {
    const projected = projectCanonicalLiveCandidate(threadId, userId, candidate, opts.invocationTracker);
    byExecution.set(liveExecutionCandidateKey(projected), projected);
  }
  const processOwnerSnapshot = await processOwnerSnapshotForRequest(request, opts.cliExecutionOwnerService);
  for (const owner of processOwnerSnapshot.owners) {
    if (owner.threadId !== threadId) continue;
    const candidate: LiveExecutionCandidate = {
      catId: owner.catId,
      startedAt: owner.startedAt,
      executionId: owner.executionId,
      invocationId: owner.invocationId,
      ownerUserId: owner.userId,
      controlSource: processOwnerSnapshot.complete ? 'process_owner' : 'unavailable',
    };
    const key = liveExecutionCandidateKey(candidate);
    byExecution.delete(liveExecutionCandidateKey({ catId: owner.catId }));
    const existing = byExecution.get(key);
    byExecution.set(
      key,
      existing?.controlSource === 'tracker'
        ? { ...candidate, ...existing, invocationId: owner.invocationId }
        : { ...existing, ...candidate },
    );
  }
  return [...byExecution.values()];
}

async function terminalizeTrackerlessTurn(input: {
  turnExecutionStore: Pick<ITurnExecutionStore, 'transitionTerminal'> | undefined;
  invocationId: string;
  threadId: string;
  catId: string;
  executionId: string;
  request: FastifyRequest;
}): Promise<void> {
  try {
    await input.turnExecutionStore?.transitionTerminal(input.invocationId, {
      status: 'canceled',
      endedAt: Date.now(),
      terminalReason: 'user_cancel',
    });
  } catch (err) {
    // The provider iterator normally performs the same idempotent transition
    // when SIGTERM unwinds it. Keep the process cancellation successful, but
    // retain a loud recovery signal if durable terminalization is unavailable.
    input.request.log.error(
      {
        err,
        threadId: input.threadId,
        catId: input.catId,
        executionId: input.executionId,
        invocationId: input.invocationId,
      },
      'tracker-less process canceled but child terminalization failed',
    );
  }
}

async function retireWithdrawnManagedWake(opts: QueueRoutesOptions, entry: QueueEntry): Promise<void> {
  const recovery = opts.getManagedCommandWakeRecovery?.();
  if (!recovery) return;
  await recovery.retireCarrier(queueEntryMessageIds(entry), 'withdrawn');
}

const moveBodySchema = z.object({
  direction: z.enum(['up', 'down']),
});

const steerBodySchema = z
  .object({
    mode: z.literal('immediate').optional(),
    targetCatId: z.string().min(1).optional(),
  })
  .strict();

const continueBodySchema = z.object({ targetCatId: z.string().min(1) }).strict();

const steerTargetsBodySchema = z
  .object({
    sourceRecordId: z.string().min(1),
    observedPendingTargetIds: z.array(z.string().min(1)),
    targets: z
      .array(
        z
          .object({
            targetCatId: z.string().min(1),
            strategy: z.enum(['guide_reply', 'interrupt_reply']),
            membershipAtOpen: z.enum(['member', 'admit']),
          })
          .strict(),
      )
      .min(1)
      .superRefine((targets, context) => {
        const seen = new Set<string>();
        for (const target of targets) {
          if (seen.has(target.targetCatId)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate target: ${target.targetCatId}` });
          }
          seen.add(target.targetCatId);
        }
      }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.observedPendingTargetIds).size !== value.observedPendingTargetIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate observed pending target' });
    }
  });

const appendBodySchema = z
  .object({
    expectedQueueRevision: z.string().min(1),
    expectedRuns: z
      .array(
        z
          .object({
            targetId: z.string().min(1),
            invocationId: z.string().min(1),
            responseMessageId: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const remindBodySchema = z
  .object({
    targetCatId: z.string().min(1),
  })
  .strict();

type ReminderRequestResolution =
  | {
      ok: true;
      entry: QueueEntry;
      invocationId: string;
    }
  | { ok: false; status: 404 | 409 | 503; error: string; code: string };

function projectQueueStartResult(result: { started: boolean; entry?: QueueEntry }) {
  return result.entry && isPublicQueueEntry(result.entry)
    ? { ...result, entry: projectPublicQueueEntry(result.entry) }
    : { started: result.started };
}

function resolveReminderRequest(input: {
  entry: QueueEntry | undefined;
  targetCatId: string;
  threadId: string;
  userId: string;
  invocationTracker: InvocationTrackerLike;
  carrierCapability: FreshnessCarrierCapability | undefined;
}): ReminderRequestResolution {
  if (!input.entry) return { ok: false, status: 404, error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
  if (!queueEntryTargetCats(input.entry).includes(input.targetCatId)) {
    return { ok: false, status: 409, error: '该猫已不再等待处理此消息', code: 'TARGET_NOT_PENDING' };
  }
  if (input.entry.status === 'processing') {
    return { ok: false, status: 409, error: '该消息已经进入处理，无需提醒', code: 'ENTRY_PROCESSING' };
  }
  if (!input.carrierCapability || input.carrierCapability.deliverySemantics === 'undeclared') {
    return {
      ok: false,
      status: 409,
      error: '当前猫的本轮提醒能力未声明，已按排队等待处理',
      code: 'REMINDER_CAPABILITY_UNDECLARED',
    };
  }
  if (input.carrierCapability.deliverySemantics !== 'exact_active_turn') {
    return {
      ok: false,
      status: 409,
      error: '当前接入不支持本轮提醒',
      code: 'REMINDER_UNSUPPORTED_CARRIER',
    };
  }
  const activeUserId = input.invocationTracker.getUserId(input.threadId, input.targetCatId);
  const invocationId = input.invocationTracker.getExecutionId?.(input.threadId, input.targetCatId);
  const active = input.invocationTracker.has(input.threadId, input.targetCatId);
  if (!active || activeUserId !== input.userId || !invocationId) {
    return { ok: false, status: 409, error: '当前没有可接收提醒的工作轮次', code: 'NO_ACTIVE_INVOCATION' };
  }
  return { ok: true, entry: input.entry, invocationId };
}

/**
 * Auth + ownership guard.
 * Returns { userId, thread } or sends error reply and returns null.
 */
async function guardThreadOwnership(
  request: FastifyRequest,
  reply: FastifyReply,
  threadStore: IThreadStore,
  threadId: string,
): Promise<{ userId: string; thread: Thread } | null> {
  const userId = resolveUserId(request, {});
  if (!userId) {
    reply.status(401);
    reply.send({ error: 'Identity required', code: 'AUTH_REQUIRED' });
    return null;
  }

  const thread = await threadStore.get(threadId);
  if (!thread) {
    reply.status(404);
    reply.send({ error: '对话不存在', code: 'THREAD_NOT_FOUND' });
    return null;
  }

  // Default thread (createdBy='system') is public — any authenticated user can access
  if (thread.createdBy !== 'system' && thread.createdBy !== userId) {
    reply.status(403);
    reply.send({ error: '无权访问此对话的队列', code: 'FORBIDDEN' });
    return null;
  }

  return { userId, thread };
}

export const queueRoutes: FastifyPluginAsync<QueueRoutesOptions> = async (app, opts) => {
  const { threadStore, invocationQueue, queueProcessor, invocationTracker, socketManager, messageStore } = opts;
  const sessionLocks = opts.agentSessionMutex ?? agentSessionMutex;
  const releaseAgentSessionLocks = (
    scope: { threadId: string; userId: string; catId?: string },
    request: FastifyRequest,
    reason: 'steer' | 'cancel' | 'force-reset',
    preserveHolderExecutionIds: readonly string[] = [],
  ) => {
    const result = sessionLocks.forceReleaseByScope(scope, { preserveHolderExecutionIds });
    if (result.releasedHolders > 0 || result.rejectedWaiters > 0) {
      request.log.warn(
        { event: 'agent_session_mutex_force_release', reason, scope, ...result },
        'Released stuck agent session locks after terminal action',
      );
    }
    return result;
  };
  const releaseSlotUnlessExecutionOwnsRetirement = (threadId: string, catId: string): void => {
    // A QueueProcessor execute promise must retain its reservation until its
    // finally path records the cancellation and drains the next row. Releasing
    // it here makes that completion stale and strands following Queue work.
    if (!queueProcessor.hasProcessingSlotReservation(threadId, catId)) {
      queueProcessor.releaseSlot(threadId, catId);
    }
  };

  const preemptSteerTarget = async (
    threadId: string,
    userId: string,
    steerCatId: string,
    reservedEntryId: string,
    request: FastifyRequest,
  ): Promise<{ ok: true; deferred: boolean } | { ok: false; status: 409 | 503; error: string; code: string }> => {
    if (invocationTracker.has(threadId, steerCatId)) {
      const activeUserId = invocationTracker.getUserId(threadId, steerCatId);
      if (activeUserId && activeUserId !== userId) {
        return { ok: false, status: 409, error: '当前有其他用户的调用在执行，无法立即执行', code: 'INVOCATION_ACTIVE' };
      }
      const cancelResult = invocationTracker.cancel(threadId, steerCatId, userId, 'preempted');
      releaseAgentSessionLocks(
        { threadId, userId, catId: steerCatId },
        request,
        'steer',
        cancelResult.executionIds ?? [],
      );
      if (cancelResult.cancelled) {
        const scopedResult = { ...cancelResult, catIds: [steerCatId] };
        for (const message of buildCancelMessages(scopedResult)) {
          socketManager.broadcastAgentMessage(message, threadId);
        }
      }
      getMultiMentionOrchestrator().abortBySlot(threadId, steerCatId as CatId);
      if (!cancelResult.cancelled && invocationTracker.has(threadId, steerCatId)) {
        return { ok: false, status: 409, error: '当前调用无法取消，无法立即执行', code: 'INVOCATION_CANCEL_FAILED' };
      }
      queueProcessor.releaseSlot(threadId, steerCatId);
      return { ok: true, deferred: false };
    }

    releaseAgentSessionLocks({ threadId, userId, catId: steerCatId }, request, 'steer');
    const inflight = invocationQueue.findProcessingByCat(threadId, steerCatId, reservedEntryId);
    if (inflight && queueEntryOwnerId(inflight) !== userId) {
      return { ok: false, status: 409, error: '当前有其他用户的调用在执行，无法立即执行', code: 'INVOCATION_ACTIVE' };
    }
    if (!inflight) {
      return { ok: true, deferred: false };
    }

    // A tracker-less processing entry is in the create→startAll window. Install
    // a retirement barrier before awaiting durable terminalization; the old
    // coroutine loses its reservation immediately, while the complete group
    // remains visible and recoverable until every durable projection closes.
    const retirement = await queueProcessor.retirePrestartProcessingGroup(threadId, steerCatId, userId);
    if (retirement === 'state_changed') {
      return { ok: false, status: 409, error: '启动中的队列状态已变化，请重试', code: 'PRESTART_STATE_CHANGED' };
    }
    if (retirement === 'terminalization_failed') {
      return {
        ok: false,
        status: 503,
        error: '旧队列条目的持久终态未完全写入，请重试',
        code: 'PRESTART_TERMINALIZATION_FAILED',
      };
    }
    // Durable retirement committed and released the old barrier. The route can
    // now atomically claim its already-persisted exact reservation in this turn.
    return { ok: true, deferred: false };
  };

  const failUncontrollableInvocation = async (input: {
    threadId: string;
    userId: string;
    catId: string;
    executionId: string;
    invocationId?: string;
    request: FastifyRequest;
    reason?: ExecutionFailureReason;
  }): Promise<{ reconciled: boolean }> => {
    if (!messageStore || !opts.invocationRecordStore) {
      throw new Error('durable execution failure stores are unavailable');
    }
    const failedAt = Date.now();
    const failureReason = input.reason ?? 'control_plane_unavailable';
    const childExecutions = opts.turnExecutionStore
      ? (await opts.turnExecutionStore.listByParent(input.executionId)).filter(
          (child) => child.threadId === input.threadId && child.userId === input.userId && child.catId === input.catId,
        )
      : [];
    const childInvocationIds = [
      ...new Set([
        ...(input.invocationId ? [input.invocationId] : []),
        ...childExecutions.map((child) => child.invocationId),
      ]),
    ];
    let responseTerminalized = false;
    for (const invocationId of childInvocationIds) {
      const response = await messageStore.getByIdempotencyKey(
        input.userId,
        input.threadId,
        `message-lifecycle-response:${invocationId}`,
      );
      if (!response?.lifecycle || response.lifecycle.kind !== 'response') continue;
      const result = await messageStore.commitLifecycleResponseTerminal(response.id, {
        invocationId,
        status: 'failed',
        completedAt: Math.max(failedAt, response.lifecycle.startedAt),
        reason: failureReason,
        content: completeExecutionFailureContent(response, failureReason),
        ...(response.contentBlocks ? { contentBlocks: response.contentBlocks } : {}),
        ...(response.toolEvents ? { toolEvents: response.toolEvents } : {}),
        ...(response.metadata ? { metadata: response.metadata } : {}),
        ...(response.extra ? { extra: response.extra } : {}),
        ...(response.thinking ? { thinking: response.thinking } : {}),
        ...(response.origin ? { origin: response.origin } : {}),
        mentions: response.mentions,
        ...(response.mentionsUser ? { mentionsUser: true } : {}),
        ...(response.replyTo ? { replyTo: response.replyTo } : {}),
      });
      if (result.kind !== 'applied' && result.kind !== 'replayed') {
        const resultLifecycle = result.kind === 'conflict' ? result.message.lifecycle : undefined;
        if (
          result.kind !== 'conflict' ||
          resultLifecycle?.kind !== 'response' ||
          resultLifecycle.status === 'processing'
        ) {
          throw new Error(`control-plane failure response terminalization rejected: ${result.kind}`);
        }
      }
      const terminalMessage = result.message;
      await settleLifecycleResponseInputs(messageStore, terminalMessage, terminalMessage.id);
      emitLifecycleMessageUpdated(socketManager, input.userId, terminalMessage);
      responseTerminalized = true;
    }

    const inflight = invocationQueue.findProcessingByCat(input.threadId, input.catId);
    if (!responseTerminalized && inflight) {
      if (queueEntryOwnerId(inflight) !== input.userId) throw new Error('pre-start execution owner changed');
      const outcome = await queueProcessor.failPrestartProcessingGroup(
        input.threadId,
        input.catId,
        input.userId,
        failureReason,
      );
      if (outcome !== 'retired') throw new Error(`pre-start failure terminalization ${outcome}`);
    }

    for (const invocationId of childInvocationIds) {
      await opts.turnExecutionStore?.transitionTerminal(invocationId, {
        status: 'failed',
        endedAt: failedAt,
        terminalReason: failureReason,
      });
    }
    const record = await opts.invocationRecordStore.get(input.executionId);
    const siblingCatIds = (record?.targetCats ?? []).filter((catId) => catId !== input.catId);
    const ownerSnapshot = await processOwnerSnapshotForRequest(input.request, opts.cliExecutionOwnerService);
    const siblingStillActive = siblingCatIds.some(
      (catId) =>
        invocationTracker.has(input.threadId, catId) ||
        ownerSnapshot.owners.some(
          (owner) =>
            owner.executionId === input.executionId &&
            owner.threadId === input.threadId &&
            owner.userId === input.userId &&
            owner.catId === catId,
        ),
    );
    if (record?.status === 'running' && !siblingStillActive) {
      const updated = await opts.invocationRecordStore.update(input.executionId, {
        status: 'failed',
        error: failureReason,
        expectedStatus: 'running',
      });
      if (!updated) throw new Error('control-plane failure parent terminalization lost its running fence');
    }

    releaseAgentSessionLocks(
      { threadId: input.threadId, userId: input.userId, catId: input.catId },
      input.request,
      'cancel',
    );
    if (queueProcessor.canReleaseSlotForUser(input.threadId, input.catId, input.userId)) {
      queueProcessor.releaseSlot(input.threadId, input.catId);
    }
    for (const message of buildCancelMessages({
      cancelled: true,
      catIds: [input.catId],
      executionIds: [input.executionId],
    })) {
      socketManager.broadcastAgentMessage(message, input.threadId);
    }
    return { reconciled: true };
  };

  const cancelProcessOwnedInvocation = async (input: {
    threadId: string;
    userId: string;
    catId: string;
    executionId: string;
    invocationId: string;
    ownerUserId?: string;
    request: FastifyRequest;
  }): Promise<{ cancelled: boolean; reconciled?: boolean; controlPlaneUnavailable?: boolean }> => {
    const executionOwner = {
      executionId: input.executionId,
      invocationId: input.invocationId,
      threadId: input.threadId,
      catId: input.catId,
      userId: input.ownerUserId ?? input.userId,
    };
    let processResult = await opts.cliExecutionOwnerService?.terminateExact(executionOwner);
    for (
      let attempt = 1;
      processResult && !processResult.complete && attempt < CONTROL_PLANE_RETRY_ATTEMPTS;
      attempt += 1
    ) {
      await waitForControlPlaneRetry();
      processResult = await opts.cliExecutionOwnerService?.terminateExact(executionOwner);
    }
    if (!processResult?.complete) {
      try {
        await failUncontrollableInvocation({ ...input, invocationId: input.invocationId });
        return { cancelled: false, reconciled: true };
      } catch (err) {
        input.request.log.error({ err, ...executionOwner }, 'failed to persist control-plane failure terminal');
        return { cancelled: false, controlPlaneUnavailable: true };
      }
    }
    // The request already resolved this exact live owner. A zero-signal result
    // means it exited in the snapshot-to-signal race; cancellation is
    // idempotently complete and its durable child truth still needs closing.
    await terminalizeTrackerlessTurn({
      turnExecutionStore: opts.turnExecutionStore,
      invocationId: input.invocationId,
      threadId: input.threadId,
      catId: input.catId,
      executionId: input.executionId,
      request: input.request,
    });
    releaseAgentSessionLocks(
      { threadId: input.threadId, userId: input.ownerUserId ?? input.userId, catId: input.catId },
      input.request,
      'cancel',
      [input.executionId],
    );
    for (const message of buildCancelMessages({
      cancelled: true,
      catIds: [input.catId],
      executionIds: [input.executionId],
    })) {
      socketManager.broadcastAgentMessage(message, input.threadId);
    }
    return { cancelled: true };
  };

  const cancelTrackedInvocation = (input: {
    threadId: string;
    userId: string;
    catId: string;
    request: FastifyRequest;
  }): { cancelled: boolean } => {
    const cancelResult = invocationTracker.cancel(input.threadId, input.catId, input.userId, 'user_cancel');
    releaseAgentSessionLocks(
      { threadId: input.threadId, userId: input.userId, catId: input.catId },
      input.request,
      'cancel',
      cancelResult.executionIds ?? [],
    );
    if (cancelResult.cancelled) {
      for (const message of buildCancelMessages({ ...cancelResult, catIds: [input.catId] })) {
        socketManager.broadcastAgentMessage(message, input.threadId);
      }
      releaseSlotUnlessExecutionOwnsRetirement(input.threadId, input.catId);
    }
    return { cancelled: cancelResult.cancelled };
  };

  const reconcileInactiveLiveInvocation = async (input: {
    threadId: string;
    userId: string;
    catId: string;
    executionId: string;
    request: FastifyRequest;
  }): Promise<{
    reconciled: boolean;
    replacement?: boolean;
    controlPlaneUnavailable?: boolean;
    error?: string;
    code?: string;
  }> => {
    const trackerExecutionId = invocationTracker.getExecutionId?.(input.threadId, input.catId);
    if (invocationTracker.has(input.threadId, input.catId)) {
      const result = cancelTrackedInvocation(input);
      return {
        reconciled: result.cancelled,
        ...(trackerExecutionId !== input.executionId ? { replacement: true } : {}),
      };
    }

    const processSnapshot = await retryProcessOwnerSnapshot(input.request, opts.cliExecutionOwnerService);
    if (!processSnapshot.complete) {
      try {
        return await failUncontrollableInvocation(input);
      } catch (err) {
        input.request.log.error(
          { err, threadId: input.threadId, catId: input.catId, executionId: input.executionId },
          'failed to persist control-plane failure terminal',
        );
        return {
          reconciled: false,
          controlPlaneUnavailable: true,
          error: '执行失败终态未能持久化，请重试',
          code: 'EXECUTION_TERMINAL_PERSISTENCE_UNAVAILABLE',
        };
      }
    }
    const processOwner = processSnapshot.owners.find(
      (owner) => owner.threadId === input.threadId && owner.catId === input.catId && owner.userId === input.userId,
    );
    if (processOwner) {
      const result = await cancelProcessOwnedInvocation({
        ...input,
        executionId: processOwner.executionId,
        invocationId: processOwner.invocationId,
        ownerUserId: processOwner.userId,
      });
      return {
        reconciled: result.cancelled || result.reconciled === true,
        ...(processOwner.executionId !== input.executionId ? { replacement: true } : {}),
        ...(result.controlPlaneUnavailable ? { controlPlaneUnavailable: true } : {}),
      };
    }

    const inflight = invocationQueue.findProcessingByCat(input.threadId, input.catId);
    if (inflight && queueEntryOwnerId(inflight) !== input.userId) {
      return {
        reconciled: false,
        controlPlaneUnavailable: true,
        error: '当前执行归属已变化，请重试',
        code: 'EXECUTION_OWNER_CHANGED',
      };
    }
    if (inflight) {
      const retirement = await queueProcessor.retirePrestartProcessingGroup(input.threadId, input.catId, input.userId);
      if (retirement === 'terminalization_failed') {
        return {
          reconciled: false,
          controlPlaneUnavailable: true,
          error: '启动中的执行未能写入持久终态，请重试',
          code: 'PRESTART_TERMINALIZATION_FAILED',
        };
      }
      if (retirement === 'state_changed') {
        return {
          reconciled: false,
          controlPlaneUnavailable: true,
          error: '启动中的执行状态已变化，请重试',
          code: 'PRESTART_STATE_CHANGED',
        };
      }
    }

    // Re-check after durable retirement: a newer run may have claimed the cat
    // while the request awaited Redis. Never release that run's lock or slot.
    if (invocationTracker.has(input.threadId, input.catId)) {
      const replacementExecutionId = invocationTracker.getExecutionId?.(input.threadId, input.catId);
      const result = cancelTrackedInvocation(input);
      return {
        reconciled: result.cancelled,
        ...(replacementExecutionId !== input.executionId ? { replacement: true } : {}),
      };
    }

    let canceledRecord = false;
    if (opts.invocationRecordStore) {
      const runningRecords = await opts.invocationRecordStore.listRunningByThread(input.threadId, input.userId);
      const exactRecord = runningRecords.find(
        (record) => record.id === input.executionId && (record.targetCats as string[]).includes(input.catId),
      );
      if (exactRecord) {
        const siblingStillActive = (exactRecord.targetCats as string[])
          .filter((catId) => catId !== input.catId)
          .some((catId) => invocationTracker.has(input.threadId, catId));
        if (!siblingStillActive) {
          await opts.invocationRecordStore.update(exactRecord.id, { status: 'canceled' });
          canceledRecord = true;
        }
      }
    }

    if (invocationTracker.has(input.threadId, input.catId)) {
      const replacementExecutionId = invocationTracker.getExecutionId?.(input.threadId, input.catId);
      const result = cancelTrackedInvocation(input);
      return {
        reconciled: result.cancelled,
        ...(replacementExecutionId !== input.executionId ? { replacement: true } : {}),
      };
    }
    const lockRelease = releaseAgentSessionLocks(
      { threadId: input.threadId, userId: input.userId, catId: input.catId },
      input.request,
      'cancel',
    );
    const canReleaseSlot = queueProcessor.canReleaseSlotForUser(input.threadId, input.catId, input.userId);
    if (canReleaseSlot && !invocationTracker.has(input.threadId, input.catId)) {
      queueProcessor.releaseSlot(input.threadId, input.catId);
    }
    // The socket projection is only a legacy witness. Once every authoritative
    // source says the exact run is gone, publish convergence even when there was
    // no remaining local artifact to remove.
    for (const message of buildCancelMessages({
      cancelled: true,
      catIds: [input.catId],
      executionIds: [input.executionId],
    })) {
      socketManager.broadcastAgentMessage(message, input.threadId);
    }
    return {
      reconciled: Boolean(
        inflight ||
          canceledRecord ||
          lockRelease.releasedHolders > 0 ||
          lockRelease.rejectedWaiters > 0 ||
          canReleaseSlot,
      ),
    };
  };

  const resolveAndRepairLiveExecutions = async (
    threadId: string,
    userId: string,
    request: FastifyRequest,
  ): Promise<LiveExecutionCandidate[]> => {
    const candidates = await resolveLiveExecutionCandidates(threadId, userId, request, opts);
    if (!opts.invocationRecordStore) return candidates;
    const processSnapshot = await processOwnerSnapshotForRequest(request, opts.cliExecutionOwnerService);
    if (!processSnapshot.complete) return candidates;
    const ownerExecutionTargets = new Set(
      processSnapshot.owners
        .filter((owner) => owner.threadId === threadId && owner.userId === userId)
        .map((owner) => `${owner.executionId}\u0000${owner.catId}`),
    );
    const repairedExecutionIds = new Set<string>();
    const runningRecords = await opts.invocationRecordStore.listRunningByThread(threadId, userId);
    for (const record of runningRecords) {
      if (Date.now() - record.updatedAt <= DEFAULT_PRESTART_RESERVATION_TTL_MS) continue;
      const repairTargets = (record.targetCats as string[]).filter(
        (catId) =>
          invocationTracker.getSlotState(threadId, catId) !== 'canceled' &&
          !invocationTracker.has(threadId, catId) &&
          !ownerExecutionTargets.has(`${record.id}\u0000${catId}`),
      );
      if (repairTargets.length === 0) continue;
      try {
        for (const catId of repairTargets) {
          await failUncontrollableInvocation({
            threadId,
            userId,
            catId,
            executionId: record.id,
            request,
            reason: 'execution_owner_lost',
          });
        }
        const repairedRecord = await opts.invocationRecordStore.get(record.id);
        if (repairedRecord?.status !== 'running') repairedExecutionIds.add(record.id);
      } catch (err) {
        request.log.error(
          { err, threadId, userId, executionId: record.id, targetCats: repairTargets },
          'active execution read-repair failed closed',
        );
      }
    }
    return candidates.filter((candidate) => !candidate.executionId || !repairedExecutionIds.has(candidate.executionId));
  };

  registerActiveExecutionRoutes(app, {
    threadStore,
    invocationTracker,
    dynamicTaskStore: opts.dynamicTaskStore,
    // F297 AC-D3：与 Sidebar 共用同一个 composition service；project scan 只取
    // live/child 候选，managed-command 表留给随后完整投影读取一次。
    ...(opts.activeExecutionService
      ? {
          buildLiveCandidateSnapshot: async (userId: string, request: FastifyRequest) => {
            const live = await opts.activeExecutionService!.buildLiveCandidateSnapshot(userId);
            const processOwners = await processOwnerSnapshotForRequest(request, opts.cliExecutionOwnerService);
            return {
              threadIds: [...new Set([...live.threadIds, ...processOwners.owners.map((owner) => owner.threadId)])],
              complete: live.complete && processOwners.complete,
            };
          },
        }
      : {}),
    resolveLiveExecutions: resolveAndRepairLiveExecutions,
    cancelExactLiveInvocation: async ({ threadId, userId, catId, executionId, candidate, request }) => {
      if (candidate.controlSource === 'process_owner' && opts.cliExecutionOwnerService && candidate.invocationId) {
        return cancelProcessOwnedInvocation({
          threadId,
          userId,
          catId,
          executionId,
          invocationId: candidate.invocationId,
          ownerUserId: candidate.ownerUserId,
          request,
        });
      }
      if (candidate.controlSource === 'tracker' && invocationTracker.has(threadId, catId)) {
        return cancelTrackedInvocation({ threadId, userId, catId, request });
      }
      const snapshot = await retryProcessOwnerSnapshot(request, opts.cliExecutionOwnerService);
      if (!snapshot.complete) {
        try {
          await failUncontrollableInvocation({
            threadId,
            userId,
            catId,
            executionId,
            ...(candidate.invocationId ? { invocationId: candidate.invocationId } : {}),
            request,
          });
          return { cancelled: false, reconciled: true };
        } catch (err) {
          request.log.error({ err, threadId, catId, executionId }, 'failed to persist control-plane failure terminal');
          return { cancelled: false, controlPlaneUnavailable: true };
        }
      }
      const owner = snapshot.owners.find(
        (item) => item.threadId === threadId && item.catId === catId && item.userId === userId,
      );
      if (owner) {
        return cancelProcessOwnedInvocation({
          threadId,
          userId,
          catId,
          executionId: owner.executionId,
          invocationId: owner.invocationId,
          ownerUserId: owner.userId,
          request,
        });
      }
      const reconciled = await reconcileInactiveLiveInvocation({ threadId, userId, catId, executionId, request });
      return {
        cancelled: false,
        reconciled: reconciled.reconciled,
        ...(reconciled.controlPlaneUnavailable ? { controlPlaneUnavailable: true } : {}),
      };
    },
    reconcileInactiveLiveInvocation,
  });

  // GET /api/threads/:threadId/queue
  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/queue', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    const activeInvocations = (
      await resolveActiveInvocations(
        threadId,
        guard.userId,
        invocationTracker,
        opts.invocationRecordStore,
        opts.draftStore,
        opts.turnExecutionStore,
        request.log,
        opts.invocationRegistry,
      )
    ).map((invocation) => ({
      ...invocation,
      freshnessCarrierCapability: opts.resolveCarrierCapability?.(invocation.catId as CatId) ?? {
        provider: 'other' as const,
        carrier: 'other' as const,
        deliverySemantics: 'undeclared' as const,
      },
    }));
    const queueEntries = invocationQueue.list(threadId, guard.userId);
    const queueRevision = invocationQueue.snapshotRevision(threadId, guard.userId);
    const enrichedQueue = await enrichQueueEntries(queueEntries, messageStore);
    return {
      queue: enrichedQueue.map((entry) => {
        const internal = queueEntries.find((candidate) => candidate.id === entry.id);
        if (!internal) return entry;
        const projection = projectLifecycleAppendAction({
          threadId,
          userId: guard.userId,
          queueRevision,
          entry: internal,
          invocationTracker,
        });
        return projection.available ? { ...entry, lifecycleActions: { append: projection.action } } : entry;
      }),
      queueRevision,
      activeInvocations,
    };
  });

  app.post<{ Params: { threadId: string; entryId: string } }>(
    '/api/threads/:threadId/queue/:entryId/append',
    async (request, reply) => {
      const { threadId, entryId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;
      const parsed = appendBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Append 请求格式无效', code: 'INVALID_APPEND_REQUEST' };
      }
      const result = await queueProcessor.appendExactEntry({
        threadId,
        userId: guard.userId,
        entryId,
        ...parsed.data,
      });
      if (result.outcome === 'appended') return result;
      const status = result.reason === 'custody_unavailable' ? 503 : result.reason === 'provider_rejected' ? 502 : 409;
      reply.status(status);
      return {
        error:
          result.reason === 'append_unavailable'
            ? '当前 Agent Client 已不再接受 Append'
            : result.reason === 'state_changed'
              ? 'Queue 或 Active Run 已变化，请刷新后重试'
              : result.reason === 'provider_rejected'
                ? '部分或全部 Agent Client 拒绝了 Append；失败回执已保留'
                : 'Append 持久化暂不可用',
        code: result.reason.toUpperCase(),
        ...(result.rejectedTargetIds ? { rejectedTargetIds: result.rejectedTargetIds } : {}),
      };
    },
  );

  // DELETE /api/threads/:threadId/queue/:entryId
  app.delete<{ Params: { threadId: string; entryId: string }; Querystring: { deleteMessage?: string } }>(
    '/api/threads/:threadId/queue/:entryId',
    async (request, reply) => {
      const { threadId, entryId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;

      // Check if entry exists and is not processing
      const entries = invocationQueue.list(threadId, guard.userId);
      const entry = entries.find((e) => e.id === entryId);
      if (!entry || !isPublicQueueEntry(entry)) {
        reply.status(404);
        return { error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
      }
      if (entry.status !== 'queued') {
        reply.status(409);
        return { error: '条目正在处理中，无法撤回', code: 'ENTRY_PROCESSING' };
      }
      const claimed = await invocationQueue.claimQueuedEntryForWithdrawal(threadId, guard.userId, entryId);
      if (!claimed) {
        reply.status(409);
        return { error: '条目正在处理中，无法撤回', code: 'ENTRY_PROCESSING' };
      }
      let removed: QueueEntry | null = null;
      try {
        const messageIds = queueEntryMessageIds(claimed);
        const remaining = invocationQueue.list(threadId, guard.userId).filter((candidate) => candidate.id !== entryId);
        for (const messageId of messageIds) {
          const hasSibling = remaining.some((candidate) => queueEntryMessageIds(candidate).includes(messageId));
          if (!hasSibling) await messageStore?.markCanceled(messageId);
        }
        removed = await invocationQueue.commitClaimedWithdrawal(threadId, entryId);
        if (!removed) throw new Error('Queue withdrawal claim changed before commit');
      } catch (err) {
        await invocationQueue.restoreClaimedEntries(threadId, [entryId]);
        request.log.error({ err, entryId, threadId }, 'durable Queue withdrawal failed; entry restored');
        await emitQueueUpdated(
          socketManager,
          guard.userId,
          threadId,
          invocationQueue.list(threadId, guard.userId),
          messageStore,
          'withdraw_failed',
        );
        reply.status(503);
        return {
          error: '撤出未完成，消息仍保留在待处理队列中',
          code: 'QUEUE_WITHDRAWAL_FAILED',
          queue: await enrichQueueEntries(invocationQueue.list(threadId, guard.userId), messageStore),
        };
      }
      if (removed) {
        try {
          await retireWithdrawnManagedWake(opts, removed);
        } catch (err) {
          request.log.error({ err, entryId, threadId }, 'managed wake producer retirement deferred to recovery sweep');
        }
      }
      // F122B B6 P2: Clean up completion hook to prevent leak when entry removed before execution
      queueProcessor.unregisterEntryCompleteHook?.(entryId);
      await queueProcessor.finalizeRemovedEntry?.(removed, 'user_cancel');

      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'removed',
      );

      return { removed: removed ? projectPublicQueueEntry(removed) : removed };
    },
  );

  // POST /api/threads/:threadId/queue/:entryId/remind
  // Non-interrupting: records one exact attempt for the current invocation and waits
  // for the existing safe-boundary freshness notice path to deliver it.
  app.post<{ Params: { threadId: string; entryId: string } }>(
    '/api/threads/:threadId/queue/:entryId/remind',
    async (request, reply) => {
      const { threadId, entryId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;
      const parsed = remindBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid body', details: parsed.error.issues };
      }

      const { targetCatId } = parsed.data;
      const resolution = resolveReminderRequest({
        entry: invocationQueue
          .list(threadId, guard.userId)
          .find((candidate) => candidate.id === entryId && isPublicQueueEntry(candidate)),
        targetCatId,
        threadId,
        userId: guard.userId,
        invocationTracker,
        carrierCapability: opts.resolveCarrierCapability?.(targetCatId as CatId),
      });
      if (!resolution.ok) {
        reply.status(resolution.status);
        return { error: resolution.error, code: resolution.code };
      }

      const reminderId = randomUUID();
      const persisted = await invocationQueue.requestReminderDurable(
        threadId,
        guard.userId,
        resolution.entry.id,
        targetCatId,
        resolution.invocationId,
        reminderId,
      );
      if (!persisted) {
        reply.status(409);
        return { error: '提醒状态已变化，请重试', code: 'REMINDER_STATE_CHANGED' };
      }
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'reminder_requested',
      );
      return {
        ok: true,
        reminderId: persisted.attempt.id,
        targetCatId,
        invocationId: resolution.invocationId,
        state: persisted.attempt.state,
        idempotent: persisted.idempotent,
      };
    },
  );

  // GET /api/threads/:threadId/queue/:entryId/targets
  // Join the one pending Queue target set with actual History dispatch refs.
  // Queue never manufactures delivered or terminal target state.
  app.get<{ Params: { threadId: string; entryId: string } }>(
    '/api/threads/:threadId/queue/:entryId/targets',
    async (request, reply) => {
      const { threadId, entryId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;

      const anchor = invocationQueue
        .list(threadId, guard.userId)
        .find((candidate) => candidate.id === entryId && isPublicQueueEntry(candidate));
      if (
        !anchor ||
        anchor.status !== 'queued' ||
        anchor.kind !== 'conversation_input' ||
        !anchor.payload.messageId ||
        isSystemPinnedQueueEntry(anchor)
      ) {
        reply.status(409);
        return { error: '该消息当前不可 Steer', code: 'STEER_ENTRY_UNAVAILABLE' };
      }

      const source = await messageStore?.getById(anchor.payload.messageId);
      if (!source || source.threadId !== threadId || source.userId !== guard.userId) {
        reply.status(409);
        return { error: '该消息当前不可 Steer', code: 'STEER_SOURCE_UNAVAILABLE' };
      }
      const pending = new Set(anchor.targets);
      const dispatchRefs = source.lifecycle?.dispatchRefs ?? [];
      const dispatched = new Map(dispatchRefs.map((ref) => [ref.targetId, ref]));
      const targetIds = [...new Set([...pending, ...dispatched.keys()])];
      return {
        sourceRecordId: source.id,
        targets: targetIds.map((targetCatId) => ({
          targetCatId,
          state: dispatched.get(targetCatId)?.phase ?? 'pending',
          actionable: pending.has(targetCatId) && !dispatched.has(targetCatId),
          ...(dispatched.get(targetCatId)?.dispatchedAt !== undefined
            ? { dispatchedAt: dispatched.get(targetCatId)!.dispatchedAt }
            : {}),
          ...(dispatched.get(targetCatId)?.statusMessageId
            ? { statusMessageId: dispatched.get(targetCatId)!.statusMessageId }
            : {}),
        })),
      };
    },
  );

  // POST /api/threads/:threadId/queue/:entryId/targets
  // Merge explicit modal edits into current Queue + History truth. Delivery
  // that wins while the modal is open is an idempotent no-op, not a conflict.
  app.post<{ Params: { threadId: string; entryId: string } }>(
    '/api/threads/:threadId/queue/:entryId/targets',
    async (request, reply) => {
      const { threadId, entryId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;
      const parsed = steerTargetsBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.status(400);
        return { error: '请选择至少一位当前对话成员', code: 'STEER_TARGETS_REQUIRED' };
      }
      if (!messageStore) {
        reply.status(503);
        return { error: 'Steer 目标映射暂不可用', code: 'STEER_TARGET_MAPPING_UNAVAILABLE' };
      }

      const { sourceRecordId, observedPendingTargetIds } = parsed.data;
      if (queueEntryId(sourceRecordId) !== entryId) {
        reply.status(400);
        return { error: 'Steer 来源身份不匹配', code: 'STEER_SOURCE_IDENTITY_MISMATCH' };
      }
      const source = await messageStore.getById(sourceRecordId);
      if (
        !source ||
        source.threadId !== threadId ||
        source.userId !== guard.userId ||
        !source.from ||
        source.recall ||
        source.deliveryStatus === 'canceled'
      ) {
        reply.status(409);
        return { error: '该消息当前不可 Steer', code: 'STEER_ENTRY_UNAVAILABLE' };
      }

      const currentEntries = invocationQueue.list(threadId, guard.userId);
      const anchor = currentEntries.find((candidate) => candidate.id === entryId);
      if (
        anchor &&
        (!isPublicQueueEntry(anchor) ||
          anchor.status !== 'queued' ||
          anchor.kind !== 'conversation_input' ||
          anchor.payload.messageId !== sourceRecordId ||
          isSystemPinnedQueueEntry(anchor))
      ) {
        reply.status(409);
        return { error: '该消息当前不可 Steer', code: 'STEER_ENTRY_UNAVAILABLE' };
      }

      const normalizedTargets = parsed.data.targets.map((target) => {
        const capability = opts.resolveCarrierCapability?.(target.targetCatId as CatId);
        return {
          targetCatId: target.targetCatId,
          membershipAtOpen: target.membershipAtOpen,
          strategy:
            target.strategy === 'guide_reply' && capability?.deliverySemantics !== 'exact_active_turn'
              ? ('interrupt_reply' as const)
              : target.strategy,
        };
      });
      const alreadyDispatched = new Set((source.lifecycle?.dispatchRefs ?? []).map((ref) => ref.targetId));
      const eligibleTargets = normalizedTargets.filter((target) => {
        if (alreadyDispatched.has(target.targetCatId)) return false;
        const currentMember = guard.thread.participants.includes(target.targetCatId as CatId);
        return !(
          opts.isCatAvailable?.(target.targetCatId as CatId) === false ||
          (target.membershipAtOpen === 'member' && !currentMember)
        );
      });
      const selectedIds = new Set(eligibleTargets.map((target) => target.targetCatId));
      const observedPending = new Set(observedPendingTargetIds);
      const addTargetIds = [...selectedIds].filter((targetId) => !observedPending.has(targetId));
      const removeTargetIds = [
        ...new Set([
          ...observedPendingTargetIds.filter((targetId) => !selectedIds.has(targetId)),
          ...alreadyDispatched,
        ]),
      ].filter((targetId) => !addTargetIds.includes(targetId));
      const tracker = invocationTracker.getExecutionId
        ? {
            has: (candidateThreadId: string, catId: CatId) => invocationTracker.has(candidateThreadId, catId),
            getUserId: (candidateThreadId: string, catId: CatId) =>
              invocationTracker.getUserId(candidateThreadId, catId),
            getExecutionId: (candidateThreadId: string, catId: CatId) =>
              invocationTracker.getExecutionId?.(candidateThreadId, catId),
          }
        : undefined;
      const authorIntentByCatId = Object.fromEntries(
        eligibleTargets.flatMap((target) => {
          const intent = resolveQueueAuthorIntentByCatId({
            targetCats: [target.targetCatId as CatId],
            requested: target.strategy === 'guide_reply' ? 'continue_current' : 'next_work',
            threadId,
            userId: guard.userId,
            invocationTracker: tracker,
            resolveCarrierCapability: opts.resolveCarrierCapability,
          })[target.targetCatId];
          return intent ? [[target.targetCatId, intent] as const] : [];
        }),
      );
      const buildQueueInput = (targetCats: string[]) => ({
        threadId,
        userId: guard.userId,
        owner: { kind: 'user' as const, userId: guard.userId },
        sourceId: source.id,
        kind: 'conversation_input' as const,
        ownerAuthProvenance: 'strict' as const,
        content: source.content,
        messageId: source.id,
        from: source.from!,
        targetCats,
        ...(source.extra?.routingWarnings ? { routingWarnings: [...source.extra.routingWarnings] } : {}),
        authorIntentByCatId,
        intent: anchor?.execution.intent ?? 'execute',
        autoExecute: anchor?.execution.autoExecute ?? true,
        priority: anchor?.priority ?? 'normal',
        ...(anchor?.sourceCategory
          ? { sourceCategory: anchor.sourceCategory }
          : source.from?.kind === 'agent'
            ? { sourceCategory: 'a2a' as const }
            : {}),
      });

      let reconciled = await invocationQueue.reconcileQueuedMessageTargetsDurable(
        threadId,
        guard.userId,
        entryId,
        addTargetIds,
        removeTargetIds,
        authorIntentByCatId,
      );
      if (reconciled.outcome === 'not_found' && addTargetIds.length > 0) {
        try {
          const admitted = await invocationQueue.enqueueDurable(buildQueueInput(addTargetIds));
          if (admitted.outcome === 'full') {
            reply.status(429);
            return { error: '消息队列已满', code: 'QUEUE_FULL' };
          }
          reconciled = { outcome: 'updated' as const, entry: admitted.entry ?? null };
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('Queue admission identity conflict')) throw error;
          reconciled = await invocationQueue.reconcileQueuedMessageTargetsDurable(
            threadId,
            guard.userId,
            entryId,
            addTargetIds,
            removeTargetIds,
            authorIntentByCatId,
          );
        }
      }
      if (reconciled.outcome === 'state_changed') {
        // Claims are short reversible reservations. Yield once so the winning
        // delivery removes its exact target, then merge against current truth.
        await new Promise((resolve) => setTimeout(resolve, 0));
        reconciled = await invocationQueue.reconcileQueuedMessageTargetsDurable(
          threadId,
          guard.userId,
          entryId,
          addTargetIds,
          removeTargetIds,
          authorIntentByCatId,
        );
      }
      if (reconciled.outcome === 'state_changed') {
        reply.status(409);
        return { error: 'Steer 正在与投递收敛，请重试', code: 'STEER_DELIVERY_IN_FLIGHT' };
      }
      const pendingAfter = new Set('entry' in reconciled ? (reconciled.entry?.targets ?? []) : []);
      const targets = eligibleTargets
        .filter((target) => pendingAfter.has(target.targetCatId))
        .map((target) => ({ targetCatId: target.targetCatId, strategy: target.strategy, entryId }));
      try {
        await admitThreadParticipants({
          userId: guard.userId,
          threadId,
          targetCats: eligibleTargets
            .filter((target) => target.membershipAtOpen === 'admit')
            .map((target) => target.targetCatId as CatId),
          threadStore,
          socketManager,
          emitPolicy: 'membership-changed',
        });
      } catch (error) {
        request.log.error(
          { error, threadId, entryId, targets },
          'Steer target changes committed; participant admission remains retryable',
        );
        reply.status(503);
        return {
          error: '目标工单已保存，成员加入尚未完成；请重试同一操作',
          code: 'STEER_PARTICIPANT_ADMISSION_PENDING',
          mappingCommitted: true,
          targets,
        };
      }
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'steer_targets_resolved',
      );
      // Mapping is a durable Queue mutation in its own right. If the browser
      // disappears before issuing the per-target follow-up commands, ordinary
      // Queue liveness must still converge every newly added row.
      void queueProcessor.requestDrain(threadId);
      return {
        targets,
        skippedAlreadyDispatched: normalizedTargets
          .filter((target) => alreadyDispatched.has(target.targetCatId))
          .map((target) => target.targetCatId),
      };
    },
  );

  // POST /api/threads/:threadId/queue/:entryId/continue
  app.post<{ Params: { threadId: string; entryId: string } }>(
    '/api/threads/:threadId/queue/:entryId/continue',
    async (request, reply) => {
      const { threadId, entryId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;
      const parsed = continueBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.status(400);
        return { error: '请选择当前对话中的成员', code: 'CONTINUE_TARGET_REQUIRED' };
      }

      const entry = invocationQueue.list(threadId, guard.userId).find((candidate) => candidate.id === entryId);
      if (!entry || !isPublicQueueEntry(entry)) {
        reply.status(404);
        return { error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
      }
      if (entry.status !== 'queued') {
        reply.status(409);
        return { error: '条目正在处理中，无法改派', code: 'ENTRY_PROCESSING' };
      }
      if (isSystemPinnedQueueEntry(entry) || entry.kind !== 'conversation_input' || entry.from.kind !== 'user') {
        reply.status(409);
        return { error: '该条目不支持不中断发送', code: 'ENTRY_CONTINUE_UNAVAILABLE' };
      }

      const targetCatId = parsed.data.targetCatId as CatId;
      const currentTargets = queueEntryTargetCats(entry);
      if (
        !guard.thread.participants.includes(targetCatId) ||
        (currentTargets.length > 0 && !currentTargets.includes(targetCatId))
      ) {
        reply.status(400);
        return { error: '所选成员不属于此消息的当前对话目标', code: 'INVALID_CONTINUE_TARGET' };
      }

      const authorIntent = resolveQueueAuthorIntentByCatId({
        targetCats: [targetCatId],
        requested: 'continue_current',
        threadId,
        userId: guard.userId,
        invocationTracker: invocationTracker.getExecutionId
          ? {
              has: (candidateThreadId, catId) => invocationTracker.has(candidateThreadId, catId),
              getUserId: (candidateThreadId, catId) => invocationTracker.getUserId(candidateThreadId, catId),
              getExecutionId: (candidateThreadId, catId) =>
                invocationTracker.getExecutionId?.(candidateThreadId, catId),
            }
          : undefined,
        resolveCarrierCapability: opts.resolveCarrierCapability,
      })[targetCatId];
      if (!authorIntent) {
        reply.status(409);
        return { error: '无法保存发送意图', code: 'CONTINUE_STATE_CHANGED' };
      }
      const bound = await invocationQueue.bindContinueCurrentIntentDurable(
        threadId,
        guard.userId,
        entryId,
        targetCatId,
        authorIntent,
      );
      if (!bound) {
        reply.status(409);
        return { error: '队列状态已变化，请刷新后重试', code: 'CONTINUE_STATE_CHANGED' };
      }

      if (authorIntent.fallbackAt === undefined) {
        const append = await queueProcessor.tryAutoAppendExactEntry({ threadId, userId: guard.userId, entryId });
        if (append.outcome === 'appended') return append;
        if (append.reason === 'provider_rejected') {
          reply.status(502);
          return { error: '当前 Agent Client 拒绝了 Append；失败回执已保留', code: 'PROVIDER_REJECTED' };
        }
        await invocationQueue.fallbackQueuedAuthorIntentDurable(
          threadId,
          guard.userId,
          entryId,
          targetCatId,
          'parent_terminal_before_exposure',
        );
      }

      void queueProcessor.requestDrain(threadId);
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'continue_current_fallback',
      );
      return {
        outcome: 'queued',
        targetCatId,
        effective: 'next_work',
        reason: authorIntent.fallbackReason ?? 'parent_terminal_before_exposure',
      };
    },
  );

  // POST /api/threads/:threadId/queue/:entryId/steer
  app.post<{ Params: { threadId: string; entryId: string } }>(
    '/api/threads/:threadId/queue/:entryId/steer',
    async (request, reply) => {
      const { threadId, entryId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;

      const parseResult = steerBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        reply.status(400);
        return { error: 'Invalid body', details: parseResult.error.issues };
      }

      const entries = invocationQueue.list(threadId, guard.userId);
      const entry = entries.find((e) => e.id === entryId);
      if (!entry || !isPublicQueueEntry(entry)) {
        reply.status(404);
        return { error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
      }
      if (entry.status !== 'queued') {
        reply.status(409);
        return { error: '条目正在处理中，无法 steer', code: 'ENTRY_PROCESSING' };
      }
      if (isSystemPinnedQueueEntry(entry)) {
        reply.status(409);
        return { error: '系统续接条目不可手动调整位置', code: 'ENTRY_POSITION_LOCKED' };
      }

      // Steer has exactly one meaning: cancel the current target invocation and
      // immediately start this same durable queue entry. Reordering remains a
      // separate drag/move interaction and is never accepted as a Steer mode.
      const requestedTargetCatId = parseResult.data.targetCatId;
      const targetCats = queueEntryTargetCats(entry);
      const steerCatId = requestedTargetCatId ?? targetCats[0];
      if (!steerCatId) {
        reply.status(400);
        return { error: '请选择当前对话中的成员', code: 'STEER_TARGET_REQUIRED' };
      }
      const targetInThread = guard.thread.participants.includes(steerCatId as CatId);
      const targetMatchesEntry = targetCats.length === 0 || targetCats.includes(steerCatId);
      if (!targetInThread || !targetMatchesEntry) {
        reply.status(400);
        return { error: '所选成员不属于此消息的当前对话目标', code: 'INVALID_STEER_TARGET' };
      }
      // The ledger claim is the one durable dequeue fence. It happens before
      // cancellation so a losing claim cannot kill the active turn, and it can
      // be restored in place if cancellation fails.
      let claimed;
      try {
        claimed = await invocationQueue.claimExactSteerEntryDurable(threadId, guard.userId, entryId, steerCatId);
      } catch (err) {
        request.log.error({ err, threadId, entryId }, 'Failed to claim durable Queue row before Steer preemption');
        reply.status(503);
        return { error: 'Steer 暂不可用', code: 'STEER_CLAIM_FAILED' };
      }
      if (claimed.outcome === 'rejected') {
        const status = claimed.reason === 'entry_not_found' ? 404 : 409;
        reply.status(status);
        return claimed.reason === 'entry_processing'
          ? { error: '条目正在处理中，无法 steer', code: 'ENTRY_PROCESSING' }
          : { error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
      }

      const preemption = await preemptSteerTarget(threadId, guard.userId, steerCatId, entryId, request);
      if (!preemption.ok) {
        await invocationQueue.restoreClaimedEntries(threadId, [entryId]);
        reply.status(preemption.status);
        return { error: preemption.error, code: preemption.code };
      }

      const result = await queueProcessor.processClaimedSteerEntries(threadId, guard.userId, [entryId], steerCatId);
      if (!result.started) {
        await invocationQueue.restoreClaimedEntries(threadId, [entryId]);
        await emitQueueUpdated(
          socketManager,
          guard.userId,
          threadId,
          invocationQueue.list(threadId, guard.userId),
          messageStore,
          'steer_failed',
        );
        reply.status(503);
        return { error: 'Steer 启动失败，请重试', code: 'STEER_START_FAILED' };
      }

      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'steer_immediate',
      );

      return projectQueueStartResult(result);
    },
  );

  // PATCH /api/threads/:threadId/queue/:entryId/move
  app.patch<{ Params: { threadId: string; entryId: string } }>(
    '/api/threads/:threadId/queue/:entryId/move',
    async (request, reply) => {
      const { threadId, entryId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;

      const parseResult = moveBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        reply.status(400);
        return { error: 'Invalid body', details: parseResult.error.issues };
      }

      // Check if entry is processing
      const entries = invocationQueue.list(threadId, guard.userId);
      const entry = entries.find((e) => e.id === entryId);
      if (!entry || !isPublicQueueEntry(entry)) {
        reply.status(404);
        return { error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
      }
      if (entry.status !== 'queued') {
        reply.status(409);
        return { error: '正在处理中的条目不可移动', code: 'ENTRY_PROCESSING' };
      }
      if (isSystemPinnedQueueEntry(entry)) {
        reply.status(409);
        return { error: '系统续接条目不可手动调整位置', code: 'ENTRY_POSITION_LOCKED' };
      }

      const queued = entries.filter((candidate) => candidate.status === 'queued');
      const index = queued.findIndex((candidate) => candidate.id === entryId);
      const neighborIndex = parseResult.data.direction === 'up' ? index - 1 : index + 1;
      if (neighborIndex >= 0 && neighborIndex < queued.length) {
        const neighbor = queued[neighborIndex]!;
        if (!(await invocationQueue.setPositionDurable(threadId, guard.userId, entryId, neighborIndex))) {
          reply.status(409);
          return { error: '队列状态已变化，请重试', code: 'ENTRY_PROCESSING' };
        }
        if (!(await invocationQueue.setPositionDurable(threadId, guard.userId, neighbor.id, index))) {
          reply.status(409);
          return { error: '队列状态已变化，请重试', code: 'ENTRY_PROCESSING' };
        }
      }
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'reordered',
      );

      return { ok: true };
    },
  );

  // PATCH /api/threads/:threadId/queue/reorder (F175)
  app.patch<{ Params: { threadId: string } }>('/api/threads/:threadId/queue/reorder', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    const reorderSchema = z.object({
      positions: z
        .array(z.object({ entryId: z.string(), position: z.number().int().nonnegative().finite() }))
        .superRefine((items, ctx) => {
          const ids = new Set<string>();
          for (const { entryId } of items) {
            if (ids.has(entryId)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate entryId: ${entryId}` });
            }
            ids.add(entryId);
          }
        }),
    });
    const parseResult = reorderSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parseResult.error.issues };
    }

    const entries = invocationQueue.list(threadId, guard.userId);
    for (const { entryId } of parseResult.data.positions) {
      const entry = entries.find((e) => e.id === entryId);
      if (!entry || !isPublicQueueEntry(entry)) {
        reply.status(400);
        return { error: `Cannot reorder entry ${entryId} (not found)` };
      }
      if (entry.status !== 'queued') {
        reply.status(409);
        return { error: `Cannot reorder entry ${entryId} (processing)` };
      }
      if (isSystemPinnedQueueEntry(entry)) {
        reply.status(409);
        return { error: '系统续接条目不可手动调整位置', code: 'ENTRY_POSITION_LOCKED' };
      }
    }

    for (const { entryId, position } of parseResult.data.positions) {
      if (!(await invocationQueue.setPositionDurable(threadId, guard.userId, entryId, position))) {
        reply.status(409);
        return { error: `Cannot reorder entry ${entryId} (state changed)`, code: 'ENTRY_PROCESSING' };
      }
    }

    await emitQueueUpdated(
      socketManager,
      guard.userId,
      threadId,
      invocationQueue.list(threadId, guard.userId),
      messageStore,
      'reordered',
    );
    return { ok: true };
  });

  // DELETE /api/threads/:threadId/queue
  app.delete<{ Params: { threadId: string } }>('/api/threads/:threadId/queue', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    // Claim one exact ledger row at a time. Processing rows are the only business-level block.
    const cleared: QueueEntry[] = [];
    const candidates = invocationQueue.list(threadId, guard.userId);
    for (const candidate of candidates) {
      if (!isPublicQueueEntry(candidate)) continue;
      const current = invocationQueue.getEntrySnapshot(threadId, guard.userId, candidate.id);
      if (!current || current.status === 'processing') continue;
      const claimed = await invocationQueue.claimQueuedEntryForWithdrawal(threadId, guard.userId, current.id);
      if (!claimed) continue;

      try {
        const messageIds = queueEntryMessageIds(claimed);
        const remaining = invocationQueue.list(threadId, guard.userId).filter((entry) => entry.id !== claimed.id);
        for (const messageId of messageIds) {
          const hasSibling = remaining.some((entry) => queueEntryMessageIds(entry).includes(messageId));
          if (!hasSibling) await messageStore?.markCanceled(messageId);
        }
        const removed = await invocationQueue.commitClaimedWithdrawal(threadId, claimed.id);
        if (!removed) throw new Error('Queue clear claim changed before commit');
      } catch (err) {
        await invocationQueue.restoreClaimedEntries(threadId, [claimed.id]);
        request.log.error(
          { err, entryId: claimed.id, threadId, clearedCount: cleared.length },
          'durable Queue clear stopped; unsettled entries retained',
        );
        const remaining = invocationQueue.list(threadId, guard.userId);
        await emitQueueUpdated(socketManager, guard.userId, threadId, remaining, messageStore, 'withdraw_failed');
        reply.status(503);
        return {
          error:
            cleared.length > 0
              ? '只撤出了部分消息；其余消息仍保留在待处理队列中'
              : '撤出未完成，消息仍保留在待处理队列中',
          code: cleared.length > 0 ? 'QUEUE_WITHDRAWAL_PARTIAL' : 'QUEUE_WITHDRAWAL_FAILED',
          cleared: cleared.map(projectPublicQueueEntry),
          queue: await enrichQueueEntries(remaining, messageStore),
        };
      }

      try {
        await retireWithdrawnManagedWake(opts, claimed);
      } catch (err) {
        request.log.error(
          { err, entryId: claimed.id, threadId },
          'managed wake producer retirement deferred to recovery sweep',
        );
      }

      queueProcessor.unregisterEntryCompleteHook?.(claimed.id);
      await queueProcessor.finalizeRemovedEntry?.(claimed, 'user_cancel');
      cleared.push(claimed);
    }
    await emitQueueUpdated(
      socketManager,
      guard.userId,
      threadId,
      invocationQueue.list(threadId, guard.userId),
      messageStore,
      'cleared',
    );

    return { cleared: cleared.map(projectPublicQueueEntry) };
  });

  // POST /api/threads/:threadId/cancel/:catId — F122B AC-B9: Per-cat cancel
  app.post<{ Params: { threadId: string; catId: string } }>(
    '/api/threads/:threadId/cancel/:catId',
    async (request, reply) => {
      const { threadId, catId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;

      if (!invocationTracker.has(threadId, catId)) {
        // F-invocation-stale-recovery: 404 short-circuit blocked orphan cleanup (Thread 1 bug).
        // When the in-memory tracker has no slot, the invocation may still have a persistent
        // running InvocationRecord (e.g., CLI exited before record was marked done, or process
        // restarted mid-invocation). Check the record store and mark any found record canceled
        // so F194 liveness won't classify it as a zombie forever.
        if (opts.invocationRecordStore) {
          const runningRecords = await opts.invocationRecordStore.listRunningByThread(threadId, guard.userId);
          const orphanRecord = runningRecords.find((r) => (r.targetCats as string[]).includes(catId));
          if (orphanRecord) {
            // P2 guard: only cancel the record when it's safe — i.e., when no sibling cat
            // of this multi-cat invocation still has an active tracker slot.
            // Marking a record canceled while siblings are still running would remove it from
            // liveness tracking prematurely, causing state inconsistency for the sibling.
            const siblingCats = (orphanRecord.targetCats as string[]).filter((c) => c !== catId);
            const siblingStillActive = siblingCats.some((c) => invocationTracker.has(threadId, c));
            if (siblingStillActive) {
              releaseAgentSessionLocks({ threadId, userId: guard.userId, catId }, request, 'cancel');
              // Orphan cancel skipped — a sibling cat is still active; let normal lifecycle handle it
              reply.status(404);
              return { error: '该猫当前未在执行', code: 'CAT_NOT_ACTIVE' };
            }

            await opts.invocationRecordStore.update(orphanRecord.id, { status: 'canceled' });
            // P2-1 + P2 (codex 第4轮 a5e8eea2): the WHOLE record is being canceled, so broadcast
            // done + release slot for EVERY targetCat — not just the requested one.
            // Otherwise sibling cats in a multi-cat orphan record stay stuck in the client's active
            // state and their processingSlots leak; and since the record is no longer running,
            // force-reset can't rediscover those siblings via listRunningByThread.
            const orphanCats = orphanRecord.targetCats as string[];
            for (const orphanCat of orphanCats) {
              releaseAgentSessionLocks({ threadId, userId: guard.userId, catId: orphanCat }, request, 'cancel');
            }
            const terminalOrphanCats = orphanCats.filter((orphanCat) =>
              queueProcessor.canReleaseSlotForUser(threadId, orphanCat, guard.userId),
            );
            if (terminalOrphanCats.length > 0) {
              for (const m of buildCancelMessages({ cancelled: true, catIds: terminalOrphanCats })) {
                socketManager.broadcastAgentMessage(m, threadId);
              }
            }
            for (const c of terminalOrphanCats) {
              queueProcessor.releaseSlot(threadId, c);
            }
            return { ok: true, cancelled: true };
          }
        }
        const lockRelease = releaseAgentSessionLocks({ threadId, userId: guard.userId, catId }, request, 'cancel');
        if (
          (lockRelease.releasedHolders > 0 || lockRelease.rejectedWaiters > 0) &&
          queueProcessor.canReleaseSlotForUser(threadId, catId, guard.userId)
        ) {
          for (const m of buildCancelMessages({ cancelled: true, catIds: [catId] })) {
            socketManager.broadcastAgentMessage(m, threadId);
          }
          queueProcessor.releaseSlot(threadId, catId);
          return { ok: true, cancelled: true };
        }
        if (lockRelease.releasedHolders > 0 || lockRelease.rejectedWaiters > 0) {
          return { ok: true, cancelled: false };
        }
        reply.status(404);
        return { error: '该猫当前未在执行', code: 'CAT_NOT_ACTIVE' };
      }

      const cancelResult = invocationTracker.cancel(threadId, catId, guard.userId, 'user_cancel');
      releaseAgentSessionLocks(
        { threadId, userId: guard.userId, catId },
        request,
        'cancel',
        cancelResult.executionIds ?? [],
      );
      if (cancelResult.cancelled) {
        const scopedResult = { ...cancelResult, catIds: [catId] };
        for (const m of buildCancelMessages(scopedResult)) {
          socketManager.broadcastAgentMessage(m, threadId);
        }
        releaseSlotUnlessExecutionOwnsRetirement(threadId, catId);
      }

      return { ok: true, cancelled: cancelResult.cancelled };
    },
  );

  // POST /api/threads/:threadId/force-reset — escape hatch for stuck threads
  // Bug: both Thread 1 (cancel 404 short-circuit) and Thread 2 (empty-result session stale)
  // could leave the thread in a permanently stuck state that users could not recover from.
  // This endpoint provides a last-resort manual reset:
  //   1. invocationTracker.cancelAll — aborts all active controllers + clears tracker slots
  //   2. queueProcessor.releaseSlot — clears only the canceled cats' in-memory slots
  //   3. listRunningByThread + update canceled — marks all persistent running records done
  // Returns { ok: true, canceledRecords: N }
  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/force-reset', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    // 1. Abort all active InvocationTracker slots (controllers + slot deletion).
    //    This clears the primary busy source (invocationTracker.has) that hasActiveExecution checks.
    //    cancelAll aborts in-flight requests and removes active slots atomically.
    //    P2 (codex 第5轮 34e07c79): use the 'cancel_all' abort reason (NOT a bespoke 'force_reset').
    //    QueueProcessor.executeEntry only routes 'user_cancel'/'cancel_all' to canceled_by_user, and
    //    only 'cancel_all' suppresses auto-resume. A custom reason falls into the plain 'canceled'
    //    branch → pause + 10s auto-recover → queued work restarts, re-busying the thread right after
    //    reset. 'cancel_all' matches force-reset's "stop everything" intent and suppresses auto-resume.
    const cancelAllResult = invocationTracker.cancelAll?.(threadId, guard.userId, 'cancel_all') ?? {
      catIds: [],
      executionIds: [],
      executionIdByCatId: {},
    };
    // The Queue reservation is canonical pre-start ownership. Tracker, record,
    // and session-lock rows are only secondary witnesses and may all still be
    // absent in the create→startAll window. Install exact retirement barriers
    // before this route performs another await, then close the durable group.
    const prestartRetirement = await queueProcessor.retireThreadPrestartProcessingGroups(threadId, guard.userId);
    if (prestartRetirement.outcome === 'terminalization_failed') {
      reply.status(503);
      return {
        error: '启动中的队列条目未能写入持久终态，请重试',
        code: 'PRESTART_TERMINALIZATION_FAILED',
      };
    }
    if (prestartRetirement.outcome === 'state_changed') {
      reply.status(409);
      return { error: '启动中的队列状态已变化，请重试', code: 'PRESTART_STATE_CHANGED' };
    }
    if (prestartRetirement.retiredCatIds.length > 0) {
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'force_reset',
      );
    }
    const managedWakeRetirement = await opts
      .getManagedCommandWakeRecovery?.()
      ?.retireThread(threadId, guard.userId, 'force_reset');
    if (managedWakeRetirement && managedWakeRetirement.messageIds.length > 0) {
      const managedMessageIds = new Set(managedWakeRetirement.messageIds);
      const managedCarriers = invocationQueue
        .list(threadId, guard.userId)
        .filter((entry) => queueEntryMessageIds(entry).some((messageId) => managedMessageIds.has(messageId)));
      for (const carrier of managedCarriers) {
        const claimed = await invocationQueue.claimQueuedEntryForWithdrawal(threadId, guard.userId, carrier.id);
        if (!claimed) continue;
        try {
          const withdrawn = await invocationQueue.commitClaimedWithdrawal(threadId, carrier.id);
          if (!withdrawn) {
            await invocationQueue.restoreClaimedEntries(threadId, [carrier.id]);
            continue;
          }
        } catch (err) {
          await invocationQueue.restoreClaimedEntries(threadId, [carrier.id]);
          request.log.error(
            { err, entryId: carrier.id, threadId },
            'force-reset could not terminalize managed wake carrier; producer remains retired',
          );
          continue;
        }
        queueProcessor.unregisterEntryCompleteHook?.(claimed.id);
        await queueProcessor.finalizeRemovedEntry?.(claimed, 'user_cancel');
      }
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'force_reset',
      );
    }
    const cancelledCatIds = cancelAllResult.catIds;
    const canceledExecutionIdsByCatId = new Map<string, Set<string>>();
    const addCanceledExecution = (catId: string, executionId: string): void => {
      const executionIds = canceledExecutionIdsByCatId.get(catId) ?? new Set<string>();
      executionIds.add(executionId);
      canceledExecutionIdsByCatId.set(catId, executionIds);
    };
    for (const [catId, executionId] of Object.entries(cancelAllResult.executionIdByCatId ?? {})) {
      addCanceledExecution(catId, executionId);
    }

    // 2+3. Collect EVERY user-owned cat whose processingSlot may still pin hasActiveExecution:
    //    cancelledCatIds (tracker slots just aborted) ∪ pre-start reservation owners ∪ running
    //    records' targetCats. The latter two cover both recordless and recorded stale slots after
    //    the tracker slot is gone, so force-reset does not leave hasActiveExecution pinned until TTL.
    //    Sources are guard.userId-scoped, but QueueProcessor slots are not; the final owner check
    //    below prevents a stale source from colliding with a newer foreign tracker slot.
    const slotsToRelease = new Set<string>([...cancelledCatIds, ...prestartRetirement.retiredCatIds]);
    let canceledRecords = 0;
    if (opts.invocationRecordStore) {
      const runningRecords = await opts.invocationRecordStore.listRunningByThread(threadId, guard.userId);
      for (const record of runningRecords) {
        for (const c of record.targetCats as string[]) {
          slotsToRelease.add(c);
          addCanceledExecution(c, record.id);
        }
        await opts.invocationRecordStore.update(record.id, { status: 'canceled' });
        canceledRecords++;
      }
    }
    const lockRelease = releaseAgentSessionLocks(
      { threadId, userId: guard.userId },
      request,
      'force-reset',
      cancelAllResult.executionIds,
    );
    for (const catId of lockRelease.catIds ?? []) slotsToRelease.add(catId);

    // QueueProcessor slots are not user-scoped. Re-check ownership at the final cleanup boundary,
    // after all awaited record writes, so a foreign invocation that started during force-reset is
    // never terminal-broadcast or released by this user's stale record/lock cleanup.
    const terminalCatIds = [...slotsToRelease].filter((catId) =>
      queueProcessor.canReleaseSlotForUser(threadId, catId, guard.userId),
    );

    // Broadcast cancel + release processingSlot for EVERY still-owned cat in
    // terminalCatIds. P2 (opus-4.6 cross-cat
    // review): broadcasting only cancelledCatIds left stale records' cats without a done broadcast,
    // so the frontend "正在回复中" never cleared after force-reset (user had to F5). Doing all three
    // over the owner-filtered set keeps force-reset aligned with the orphan/normal cancel paths and
    // covers the stale case cancelAll missed without touching a foreign live slot.
    if (terminalCatIds.length > 0) {
      for (const m of buildCancelMessages({ cancelled: true, catIds: terminalCatIds })) {
        socketManager.broadcastAgentMessage(m, threadId);
      }
    }
    for (const cid of terminalCatIds) {
      // Force-reset means stop, not "retry in ten seconds". Fence both Queue
      // cleanup and a late connector wake before releasing the slot. Terminal
      // consumption is restricted to executions this reset actually canceled.
      queueProcessor.suppressAutoResume(threadId, cid, [...(canceledExecutionIdsByCatId.get(cid) ?? [])]);
      queueProcessor.releaseSlot(threadId, cid);
    }

    return { ok: true, canceledRecords };
  });
};

/**
 * Re-export：`resolveActiveInvocations` 的实现已迁到 domain
 * (`active-execution-service.ts`，R3 P2-1)，此处仅为既有 import 路径保持兼容。
 */
export {
  type ActiveInvocationProjection,
  type InvocationRegistryPort,
  type InvocationTrackerLike,
  resolveActiveInvocations,
};
