/**
 * Queue Management API Routes (F39)
 *
 * GET    /api/threads/:threadId/queue               → 列出队列条目
 * DELETE /api/threads/:threadId/queue/:entryId       → 撤回条目
 * POST   /api/threads/:threadId/queue/next          → 手动触发处理下一条
 * POST   /api/threads/:threadId/queue/steer-batch   → #1291 exact ordinary-user Batch Steer
 * POST   /api/threads/:threadId/queue/:entryId/steer → Steer queued entry（取消当前轮并以同一消息立即启动）
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
  isOrdinaryQueueTargetEligible,
  isSystemPinnedQueueEntry,
  type QueueEntry,
} from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueuedMessageCustodyCoordinator } from '../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import type { DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import { buildCancelMessages, type SocketManager } from '../infrastructure/websocket/index.js';
import type { CliExecutionOwnerService, LiveCliExecutionOwner } from '../utils/cli-process-ownership.js';
import { emitQueueUpdated, enrichQueueEntries, projectPublicQueueEntry } from '../utils/queue-enrichment.js';
import { resolveUserId } from '../utils/request-identity.js';
import { type LiveExecutionCandidate, registerActiveExecutionRoutes } from './active-execution-routes.js';
import { getMultiMentionOrchestrator } from './callback-multi-mention-routes.js';

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
  /** Shared owner-aware session lock released by explicit terminal actions. */
  agentSessionMutex?: AgentSessionMutexLike;
  socketManager: SocketManager;
  /** MessageStore supplies receipt hydration; Queue withdrawal never deletes author history. */
  messageStore?: IMessageStore;
  /** F254: persist reorder/promote mutations before acknowledging them. */
  queueCustodyCoordinator?: QueuedMessageCustodyCoordinator;
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

function projectCanonicalLiveCandidate(
  threadId: string,
  fallbackUserId: string,
  candidate: ActiveInvocationProjection,
  tracker: InvocationTrackerLike,
): LiveExecutionCandidate {
  const ownerUserId = tracker.getUserId(threadId, candidate.catId) ?? fallbackUserId;
  const trackerExecutionId = tracker.getExecutionId?.(threadId, candidate.catId);
  return {
    ...candidate,
    ownerUserId,
    controlSource: candidate.executionId && trackerExecutionId === candidate.executionId ? 'tracker' : 'unavailable',
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

function queueEntryMessageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
  return [entry.messageId, ...entry.mergedMessageIds].filter((messageId): messageId is string => !!messageId);
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
  })
  .strict();

const steerBatchBodySchema = z
  .object({
    entryIds: z.array(z.string().min(1)).min(2).max(5),
  })
  .strict()
  .superRefine(({ entryIds }, ctx) => {
    if (new Set(entryIds).size !== entryIds.length) {
      ctx.addIssue({ code: 'custom', path: ['entryIds'], message: 'entryIds must be distinct' });
    }
  });

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
      coordinator: QueuedMessageCustodyCoordinator;
    }
  | { ok: false; status: 404 | 409 | 503; error: string; code: string };

function projectQueueStartResult(result: { started: boolean; entry?: QueueEntry }) {
  return result.entry ? { ...result, entry: projectPublicQueueEntry(result.entry) } : result;
}

function resolveReminderRequest(input: {
  entry: QueueEntry | undefined;
  targetCatId: string;
  threadId: string;
  userId: string;
  invocationTracker: InvocationTrackerLike;
  coordinator: QueuedMessageCustodyCoordinator | undefined;
  carrierCapability: FreshnessCarrierCapability | undefined;
}): ReminderRequestResolution {
  if (!input.entry) return { ok: false, status: 404, error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
  if (!input.entry.targetCats.includes(input.targetCatId)) {
    return { ok: false, status: 409, error: '该猫已不再等待处理此消息', code: 'TARGET_NOT_PENDING' };
  }
  if (input.entry.status === 'processing') {
    return { ok: false, status: 409, error: '该消息已经进入处理，无需提醒', code: 'ENTRY_PROCESSING' };
  }
  if (!input.coordinator) {
    return { ok: false, status: 503, error: '持久回执暂不可用', code: 'RECEIPT_STORE_UNAVAILABLE' };
  }
  if (!input.carrierCapability || input.carrierCapability.deliverySemantics === 'undeclared') {
    return {
      ok: false,
      status: 409,
      error: '当前猫的本轮提醒能力未声明，已按下一件工作处理',
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
  return { ok: true, entry: input.entry, invocationId, coordinator: input.coordinator };
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
): Promise<{ userId: string } | null> {
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

  return { userId };
}

export const queueRoutes: FastifyPluginAsync<QueueRoutesOptions> = async (app, opts) => {
  const { threadStore, invocationQueue, queueProcessor, invocationTracker, socketManager, messageStore } = opts;
  const sessionLocks = opts.agentSessionMutex ?? agentSessionMutex;
  const persistQueueEntries = async (threadId: string, userId: string, entryIds: readonly string[]) => {
    if (!opts.queueCustodyCoordinator) return;
    for (const entryId of new Set(entryIds)) {
      const entry = invocationQueue.getEntrySnapshot(threadId, userId, entryId);
      if (entry) await opts.queueCustodyCoordinator.persistEntry(entry);
    }
  };

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

  const preemptSteerTarget = async (
    threadId: string,
    userId: string,
    steerCatId: string,
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
      queueProcessor.clearPause(threadId, steerCatId);
      queueProcessor.releaseSlot(threadId, steerCatId);
      return { ok: true, deferred: false };
    }

    releaseAgentSessionLocks({ threadId, userId, catId: steerCatId }, request, 'steer');
    const inflight = invocationQueue.findProcessingByCat(threadId, steerCatId);
    if (inflight && inflight.userId !== userId) {
      return { ok: false, status: 409, error: '当前有其他用户的调用在执行，无法立即执行', code: 'INVOCATION_ACTIVE' };
    }
    if (!inflight) {
      queueProcessor.clearPause(threadId, steerCatId);
      return { ok: true, deferred: false };
    }

    // A tracker-less processing entry is in the create→startAll window. Install
    // a retirement barrier before awaiting durable terminalization; the old
    // coroutine loses its reservation immediately, while the complete group
    // remains visible and recoverable until every durable projection closes.
    queueProcessor.clearPause(threadId, steerCatId);
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

  const cancelProcessOwnedInvocation = async (input: {
    threadId: string;
    userId: string;
    catId: string;
    executionId: string;
    invocationId: string;
    ownerUserId?: string;
    request: FastifyRequest;
  }): Promise<{ cancelled: boolean; controlPlaneUnavailable?: boolean }> => {
    const processResult = await opts.cliExecutionOwnerService?.terminateExact({
      executionId: input.executionId,
      invocationId: input.invocationId,
      threadId: input.threadId,
      catId: input.catId,
      userId: input.ownerUserId ?? input.userId,
    });
    if (!processResult?.complete) return { cancelled: false, controlPlaneUnavailable: true };
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
    queueProcessor.clearPause(input.threadId, input.catId);
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
      queueProcessor.clearPause(input.threadId, input.catId);
      queueProcessor.releaseSlot(input.threadId, input.catId);
    }
    return { cancelled: cancelResult.cancelled };
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
    resolveLiveExecutions: (threadId, userId, request) =>
      resolveLiveExecutionCandidates(threadId, userId, request, opts),
    isLiveExecutionControlPlaneComplete: async (request) =>
      (await processOwnerSnapshotForRequest(request, opts.cliExecutionOwnerService)).complete,
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
      return cancelTrackedInvocation({ threadId, userId, catId, request });
    },
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
    const enrichedQueue = await enrichQueueEntries(invocationQueue.list(threadId, guard.userId), messageStore);
    return {
      queue: enrichedQueue,
      paused: queueProcessor.isPaused(threadId),
      pauseReason: queueProcessor.getPauseReason(threadId),
      activeInvocations,
    };
  });

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
      if (!entry) {
        reply.status(404);
        return { error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
      }
      if (entry.status === 'processing') {
        reply.status(409);
        return { error: '条目正在处理中，无法撤回', code: 'ENTRY_PROCESSING' };
      }
      if (invocationQueue.hasUnsettledExactSteerReservation(threadId, guard.userId, entryId)) {
        reply.status(409);
        return { error: 'Steer 正在抢占，暂无法撤回', code: 'ENTRY_STEERING' };
      }

      // Remove entry from queue FIRST (sync) to close the TOCTOU window —
      // prevents queue processor from promoting to 'processing' during the
      // async contentBlocks snapshot below.
      const nextEntryId = entries[entries.findIndex((candidate) => candidate.id === entryId) + 1]?.id;
      const removed = invocationQueue.remove(threadId, guard.userId, entryId);
      if (removed && opts.queueCustodyCoordinator) {
        try {
          await opts.queueCustodyCoordinator.withdrawEntry(removed);
        } catch (err) {
          invocationQueue.restoreDurableEntry(removed, { beforeEntryId: nextEntryId });
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
        { receiptMessageIds: removed ? queueEntryMessageIds(removed) : [] },
      );

      return { removed: removed ? projectPublicQueueEntry(removed) : removed };
    },
  );

  // POST /api/threads/:threadId/queue/next
  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/queue/next', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    const result = await queueProcessor.processNext(threadId, guard.userId);
    return projectQueueStartResult(result);
  });

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
        entry: invocationQueue.list(threadId, guard.userId).find((candidate) => candidate.id === entryId),
        targetCatId,
        threadId,
        userId: guard.userId,
        invocationTracker,
        coordinator: opts.queueCustodyCoordinator,
        carrierCapability: opts.resolveCarrierCapability?.(targetCatId as CatId),
      });
      if (!resolution.ok) {
        reply.status(resolution.status);
        return { error: resolution.error, code: resolution.code };
      }

      const existingAttempt = await resolution.coordinator.findReminderAttempt(
        resolution.entry,
        targetCatId,
        resolution.invocationId,
      );
      if (existingAttempt) {
        return {
          ok: true,
          reminderId: existingAttempt.id,
          targetCatId,
          invocationId: resolution.invocationId,
          state: existingAttempt.state,
          idempotent: true,
        };
      }

      const reminderId = randomUUID();
      const persisted = await resolution.coordinator.requestReminder(
        resolution.entry,
        targetCatId,
        resolution.invocationId,
        reminderId,
      );
      if (!persisted) {
        const racedAttempt = await resolution.coordinator.findReminderAttempt(
          resolution.entry,
          targetCatId,
          resolution.invocationId,
        );
        if (racedAttempt) {
          return {
            ok: true,
            reminderId: racedAttempt.id,
            targetCatId,
            invocationId: resolution.invocationId,
            state: racedAttempt.state,
            idempotent: true,
          };
        }
        reply.status(409);
        return { error: '消息尚未建立可持久回执', code: 'RECEIPT_NOT_PERSISTED' };
      }
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'reminder_requested',
      );
      return { ok: true, reminderId, targetCatId, invocationId: resolution.invocationId, state: 'requested' as const };
    },
  );

  // POST /api/threads/:threadId/queue/steer-batch
  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/queue/steer-batch', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    const parseResult = steerBatchBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parseResult.error.issues };
    }

    const reserved = invocationQueue.reserveExactUserBatch(threadId, guard.userId, parseResult.data.entryIds);
    if (reserved.outcome === 'rejected') {
      const rejection = {
        invalid_entry_ids: { status: 400 as const, code: 'INVALID_BATCH_ENTRY_IDS', error: 'entryIds 无效' },
        entry_not_found: { status: 404 as const, code: 'BATCH_ENTRY_NOT_FOUND', error: '批量 Steer 条目不存在' },
        entry_ineligible: {
          status: 409 as const,
          code: 'BATCH_ENTRY_INELIGIBLE',
          error: '批量 Steer 仅支持普通用户消息',
        },
        entries_incompatible: {
          status: 409 as const,
          code: 'BATCH_ENTRIES_INCOMPATIBLE',
          error: '批量 Steer 条目必须属于同一猫、意图和授权来源',
        },
      }[reserved.reason];
      reply.status(rejection.status);
      return { error: rejection.error, code: rejection.code };
    }

    const releaseReservation = async () => {
      const restored = invocationQueue.releaseExactUserBatch(threadId, guard.userId, reserved.reservationId);
      try {
        await persistQueueEntries(
          threadId,
          guard.userId,
          restored.map((entry) => entry.id),
        );
      } catch (err) {
        request.log.error(
          { err, threadId, reservationId: reserved.reservationId },
          'Failed to persist exact Batch Steer reservation rollback',
        );
      }
      return restored;
    };

    try {
      await persistQueueEntries(threadId, guard.userId, reserved.entryIds);
    } catch (err) {
      await releaseReservation();
      request.log.error(
        { err, threadId, reservationId: reserved.reservationId },
        'Failed to persist exact Batch Steer reservation before preemption',
      );
      reply.status(503);
      return { error: '批量 Steer 预留暂不可用', code: 'BATCH_RESERVATION_PERSIST_FAILED' };
    }

    if (!invocationQueue.beginExactSteerPreemption(threadId, guard.userId, reserved.reservationId)) {
      await releaseReservation();
      reply.status(409);
      return { error: '批量 Steer 预留已变化', code: 'BATCH_RESERVATION_LOST' };
    }

    const preemption = await preemptSteerTarget(threadId, guard.userId, reserved.targetCatId, request);
    if (!preemption.ok) {
      await releaseReservation();
      reply.status(preemption.status);
      return { error: preemption.error, code: preemption.code };
    }

    if (!invocationQueue.activateExactSteerReservation(threadId, guard.userId, reserved.reservationId)) {
      await releaseReservation();
      reply.status(409);
      return { error: '批量 Steer 预留已变化', code: 'BATCH_RESERVATION_LOST' };
    }

    if (preemption.deferred) {
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'steer_batch_reserved',
      );
      reply.status(202);
      return {
        ok: true,
        deferred: true,
        code: 'PREEMPT_PENDING_PRESTART',
        batchId: reserved.reservationId,
        entryIds: reserved.entryIds,
      };
    }

    const result = await queueProcessor.processExactSteerReservation(
      threadId,
      guard.userId,
      reserved.primaryEntryId,
      reserved.reservationId,
    );
    if (!result.started) {
      await releaseReservation();
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'steer_batch_failed',
      );
      reply.status(409);
      return { error: '队列繁忙，暂无法立即执行', code: 'QUEUE_BUSY' };
    }

    await emitQueueUpdated(
      socketManager,
      guard.userId,
      threadId,
      invocationQueue.list(threadId, guard.userId),
      messageStore,
      'steer_batch_reserved',
    );

    return {
      ok: true,
      batchId: reserved.reservationId,
      entryIds: reserved.entryIds,
      ...projectQueueStartResult(result),
    };
  });

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
      if (!entry) {
        reply.status(404);
        return { error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
      }
      if (entry.status === 'processing') {
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
      const steerCatId = entry.targetCats.find((catId) => isOrdinaryQueueTargetEligible(entry, catId));
      if (!steerCatId) {
        reply.status(409);
        return { error: 'Steer 状态已变化，请重试', code: 'STEER_STATE_CHANGED' };
      }
      // Reserve the entry BEFORE preempting. Preemption cancels a running turn;
      // doing it first meant a losing CAS returned STEER_STATE_CHANGED *after*
      // the user's turn was already killed — they lost the work and did not get
      // the steer, while the message told them to retry.
      const reserved = invocationQueue.reserveExactUserEntry(threadId, guard.userId, entryId, steerCatId);
      if (reserved.outcome === 'rejected') {
        reply.status(409);
        return { error: 'Steer 状态已变化，请重试', code: 'STEER_STATE_CHANGED' };
      }
      // The reservation must be durable BEFORE anything is cancelled, mirroring
      // steer-batch. Reserving only in memory just moved the split: a rejected
      // persistence would still have landed after the running turn was killed.
      const releaseSteerReservation = async (): Promise<void> => {
        const restored = invocationQueue.releaseExactUserBatch(threadId, guard.userId, reserved.reservationId);
        try {
          await persistQueueEntries(
            threadId,
            guard.userId,
            restored.map((candidate) => candidate.id),
          );
        } catch (releaseErr) {
          request.log.error(
            { err: releaseErr, threadId, entryId },
            'Failed to persist Steer reservation release; in-memory marker cleared',
          );
        }
      };
      try {
        await persistQueueEntries(threadId, guard.userId, [entryId]);
      } catch (err) {
        await releaseSteerReservation();
        request.log.error({ err, threadId, entryId }, 'Failed to persist exact Steer reservation before preemption');
        reply.status(503);
        return { error: 'Steer 预留暂不可用', code: 'STEER_RESERVATION_PERSIST_FAILED' };
      }

      if (!invocationQueue.beginExactSteerPreemption(threadId, guard.userId, reserved.reservationId)) {
        await releaseSteerReservation();
        reply.status(409);
        return { error: 'Steer 预留已变化，请重试', code: 'STEER_RESERVATION_LOST' };
      }

      const preemption = await preemptSteerTarget(threadId, guard.userId, steerCatId, request);
      if (!preemption.ok) {
        // The replacement reservation must not survive a rejected or partially
        // terminalized preemption — locally or durably.
        await releaseSteerReservation();
        reply.status(preemption.status);
        return { error: preemption.error, code: preemption.code };
      }
      if (!invocationQueue.activateExactSteerReservation(threadId, guard.userId, reserved.reservationId)) {
        await releaseSteerReservation();
        reply.status(409);
        return { error: 'Steer 预留已变化，请重试', code: 'STEER_RESERVATION_LOST' };
      }
      if (preemption.deferred) {
        await emitQueueUpdated(
          socketManager,
          guard.userId,
          threadId,
          invocationQueue.list(threadId, guard.userId),
          messageStore,
          'steer_immediate',
        );
        reply.status(202);
        return {
          ok: true,
          deferred: true,
          code: 'PREEMPT_PENDING_PRESTART',
          message: '目标正在启动中，已请求中断，插队消息将在当前调用退出后立即执行',
        };
      }

      const result = await queueProcessor.processExactSteerReservation(
        threadId,
        guard.userId,
        entryId,
        reserved.reservationId,
      );
      if (!result.started) {
        await releaseSteerReservation();
        await emitQueueUpdated(
          socketManager,
          guard.userId,
          threadId,
          invocationQueue.list(threadId, guard.userId),
          messageStore,
          'steer_failed',
        );
        reply.status(409);
        return { error: '队列繁忙，暂无法立即执行', code: 'QUEUE_BUSY' };
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
      if (!entry) {
        reply.status(404);
        return { error: '队列条目不存在', code: 'ENTRY_NOT_FOUND' };
      }
      if (entry.status === 'processing') {
        reply.status(409);
        return { error: '正在处理中的条目不可移动', code: 'ENTRY_PROCESSING' };
      }
      if (entry.exactSteerBatch) {
        reply.status(409);
        return { error: '批量 Steer 已预留，暂不可重排', code: 'ENTRY_STEERING' };
      }
      if (isSystemPinnedQueueEntry(entry)) {
        reply.status(409);
        return { error: '系统续接条目不可手动调整位置', code: 'ENTRY_POSITION_LOCKED' };
      }

      invocationQueue.move(threadId, guard.userId, entryId, parseResult.data.direction);
      await persistQueueEntries(
        threadId,
        guard.userId,
        invocationQueue.list(threadId, guard.userId).map((candidate) => candidate.id),
      );
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
      if (!entry) {
        reply.status(400);
        return { error: `Cannot reorder entry ${entryId} (not found)` };
      }
      if (entry.status === 'processing') {
        reply.status(400);
        return { error: `Cannot reorder entry ${entryId} (processing)` };
      }
      if (entry.exactSteerBatch) {
        reply.status(409);
        return { error: '批量 Steer 已预留，暂不可重排', code: 'ENTRY_STEERING' };
      }
      if (isSystemPinnedQueueEntry(entry)) {
        reply.status(409);
        return { error: '系统续接条目不可手动调整位置', code: 'ENTRY_POSITION_LOCKED' };
      }
    }

    for (const { entryId, position } of parseResult.data.positions) {
      invocationQueue.setPosition(threadId, guard.userId, entryId, position);
    }
    await persistQueueEntries(
      threadId,
      guard.userId,
      parseResult.data.positions.map(({ entryId }) => entryId),
    );

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

    if (invocationQueue.hasUnsettledExactSteerReservation(threadId, guard.userId)) {
      reply.status(409);
      return { error: 'Steer 正在抢占，暂无法清空队列', code: 'ENTRY_STEERING' };
    }

    // Explicit clear supersedes a deferred Batch Steer. Restore its original
    // snapshots first so the existing per-entry withdrawal CAS remains valid.
    invocationQueue.releaseAllExactUserBatches(threadId, guard.userId);

    // Withdraw one exact snapshot at a time. This preserves processing entries and lets a
    // durable-store failure stop before any later entry is removed from actionable custody.
    const cleared: QueueEntry[] = [];
    const candidates = invocationQueue.list(threadId, guard.userId);
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const current = invocationQueue.getEntrySnapshot(threadId, guard.userId, candidate.id);
      if (!current || current.status === 'processing') continue;
      if (!invocationQueue.removeEntrySnapshotIfUnchanged(current)) continue;

      try {
        await opts.queueCustodyCoordinator?.withdrawEntry(current);
      } catch (err) {
        invocationQueue.restoreDurableEntry(current, { beforeEntryId: candidates[candidateIndex + 1]?.id });
        request.log.error(
          { err, entryId: current.id, threadId, clearedCount: cleared.length },
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
        await retireWithdrawnManagedWake(opts, current);
      } catch (err) {
        request.log.error(
          { err, entryId: current.id, threadId },
          'managed wake producer retirement deferred to recovery sweep',
        );
      }

      queueProcessor.unregisterEntryCompleteHook?.(current.id);
      await queueProcessor.finalizeRemovedEntry?.(current, 'user_cancel');
      cleared.push(current);
    }
    await emitQueueUpdated(
      socketManager,
      guard.userId,
      threadId,
      invocationQueue.list(threadId, guard.userId),
      messageStore,
      'cleared',
      { receiptMessageIds: cleared.flatMap(queueEntryMessageIds) },
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
            // done + clear pause + release slot for EVERY targetCat — not just the requested one.
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
              queueProcessor.clearPause(threadId, c);
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
          queueProcessor.clearPause(threadId, catId);
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
        queueProcessor.clearPause(threadId, catId);
        queueProcessor.releaseSlot(threadId, catId);
      }

      return { ok: true, cancelled: cancelResult.cancelled };
    },
  );

  // POST /api/threads/:threadId/force-reset — escape hatch for stuck threads
  // Bug: both Thread 1 (cancel 404 short-circuit) and Thread 2 (empty-result session stale)
  // could leave the thread in a permanently stuck state that users could not recover from.
  // This endpoint provides a last-resort manual reset:
  //   1. invocationTracker.cancelAll — aborts all active controllers + clears tracker slots
  //   2. queueProcessor.releaseThread — clears all in-memory processingSlots
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
        const current = invocationQueue.getEntrySnapshot(threadId, guard.userId, carrier.id);
        if (!current || !invocationQueue.removeEntrySnapshotIfUnchanged(current)) continue;
        try {
          await opts.queueCustodyCoordinator?.withdrawEntry(current);
        } catch (err) {
          invocationQueue.restoreDurableEntry(current);
          request.log.error(
            { err, entryId: current.id, threadId },
            'force-reset could not terminalize managed wake carrier; producer remains retired',
          );
          continue;
        }
        queueProcessor.unregisterEntryCompleteHook?.(current.id);
        await queueProcessor.finalizeRemovedEntry?.(current, 'user_cancel');
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

    // Broadcast cancel + clear pause + release processingSlot for EVERY still-owned cat in
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
      queueProcessor.clearPause(threadId, cid);
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
