/**
 * Queue Management API Routes (F39)
 *
 * GET    /api/threads/:threadId/queue               → 列出队列条目
 * DELETE /api/threads/:threadId/queue/:entryId       → 撤回条目
 * POST   /api/threads/:threadId/queue/next          → 手动触发处理下一条
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
import type { IBallCustodyIngest } from '../domains/ball-custody/BallCustodyIngest.js';
import {
  type AgentSessionMutexLike,
  agentSessionMutex,
} from '../domains/cats/services/agents/invocation/AgentSessionMutex.js';
import { getThreadLiveInvocations } from '../domains/cats/services/agents/invocation/getThreadLiveInvocations.js';
import {
  type InvocationQueue,
  isSystemPinnedQueueEntry,
  type QueueEntry,
} from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueuedMessageCustodyCoordinator } from '../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import {
  type ReconcileZombieDeps,
  reconcileZombies,
} from '../domains/cats/services/agents/invocation/reconcileZombies.js';
import type { TaskProgressStore } from '../domains/cats/services/agents/invocation/TaskProgressStore.js';
import type { CodexAppServerLifecycleSnapshot } from '../domains/cats/services/agents/providers/CodexAppServerLifecycle.js';
import { getCodexAppServerLifecycle } from '../domains/cats/services/agents/providers/CodexAppServerLifecycleRegistry.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import { buildCancelMessages, type SocketManager } from '../infrastructure/websocket/index.js';
import { emitQueueUpdated, enrichQueueEntries, projectPublicQueueEntry } from '../utils/queue-enrichment.js';
import { resolveUserId } from '../utils/request-identity.js';
import { getMultiMentionOrchestrator } from './callback-multi-mention-routes.js';

interface InvocationTrackerLike {
  has(threadId: string, catId?: string): boolean;
  getUserId(threadId: string, catId: string): string | null;
  getExecutionId?(threadId: string, catId: string): string | undefined;
  cancel(
    threadId: string,
    catId: string,
    requestUserId?: string,
    abortReason?: string,
  ): { cancelled: boolean; catIds: string[]; executionIds?: string[] };
  /** Issue #83: Get all active slots for a thread (F5 refresh recovery) */
  getActiveSlots(threadId: string): Array<{ catId: string; startedAt: number }>;
  /** F-invocation-stale-recovery: Cancel ALL active slots for a thread (abort controllers + delete slots). */
  cancelAll?(
    threadId: string,
    requestUserId?: string,
    abortReason?: string,
  ): { catIds: string[]; executionIds: string[]; executionIdByCatId?: Readonly<Record<string, string>> };
}

interface ActiveInvocationProjection {
  catId: string;
  startedAt: number;
  /** Parent/control-plane identity. Frontend keeps this as the active slot key for Cancel. */
  executionId?: string;
  /** Exact child/turn identity carried by F264 body-exposure receipts. */
  turnInvocationId?: string;
  appServerLifecycle?: CodexAppServerLifecycleSnapshot;
  freshnessCarrierCapability?: FreshnessCarrierCapability;
}

interface LifecycleProjectionCandidate {
  catId: string;
  startedAt: number;
  lifecycleOwnerId?: string;
  turnInvocationId?: string;
}

function resolveLifecycleOwnerId(
  threadId: string,
  userId: string,
  catId: string,
  canonicalExecutionId: string,
  invocationTracker: InvocationTrackerLike,
): string {
  // The tracker is the current control-plane owner during replacement windows. When it has
  // no same-user bound execution yet, the canonical read model still carries the exact parent
  // owner. Never borrow a tracker owner from another user on a shared/default thread.
  return getRequestOwnedTrackerExecutionId(threadId, userId, catId, invocationTracker) ?? canonicalExecutionId;
}

function getRequestOwnedTrackerExecutionId(
  threadId: string,
  userId: string,
  catId: string,
  invocationTracker: InvocationTrackerLike,
): string | undefined {
  if (invocationTracker.getUserId(threadId, catId) !== userId) return undefined;
  return invocationTracker.getExecutionId?.(threadId, catId);
}

function projectActiveInvocations(
  threadId: string,
  slots: LifecycleProjectionCandidate[],
): ActiveInvocationProjection[] {
  return slots.map(({ lifecycleOwnerId, ...slot }) => {
    const appServerLifecycle = lifecycleOwnerId
      ? getCodexAppServerLifecycle(threadId, slot.catId, lifecycleOwnerId)
      : undefined;
    const projection = {
      ...slot,
      ...(lifecycleOwnerId ? { executionId: lifecycleOwnerId } : {}),
    };
    return appServerLifecycle ? { ...projection, appServerLifecycle } : projection;
  });
}

function trackerProjectionCandidates(
  threadId: string,
  userId: string,
  invocationTracker: InvocationTrackerLike,
): LifecycleProjectionCandidate[] {
  return invocationTracker.getActiveSlots(threadId).map((slot) => {
    const lifecycleOwnerId = getRequestOwnedTrackerExecutionId(threadId, userId, slot.catId, invocationTracker);
    return { ...slot, ...(lifecycleOwnerId ? { lifecycleOwnerId } : {}) };
  });
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
  turnExecutionStore?: Pick<ITurnExecutionStore, 'listByParent'>;
  /** F233 PR3: ball-custody event sink for zombie reconciliation side effects. */
  ballCustody?: IBallCustodyIngest;
  /** F194 AC-B7: when helper detects zombies, reconcileZombies clears their
   *  TaskProgress snapshot so the frontend doesn't show phantom progress. Optional —
   *  cleanup still marks records `failed` even without this. */
  taskProgressStore?: TaskProgressStore;
  /** F194 Phase Z (KD-22): InvocationRegistry — provides namespace bridge between
   *  parent recordStore invocation and per-cat-turn child registry invocation.
   *  When wired, helper uses parentInvocationId / latestId to detect parent+child
   *  chain liveness and cat-slot reuse zombies. Optional for backward compat;
   *  fall-back to single-namespace classification when absent. */
  invocationRegistry?: {
    getRecord(invocationId: string): Promise<{
      parentInvocationId?: string | undefined;
      threadId: string;
      userId: string;
      catId: string;
      createdAt: number;
    } | null>;
    getLatestId(threadId: string, catId: string): Promise<string | undefined>;
  };
  /** Exact-owner terminal recovery wired by the composition root. */
  onReconciledZombie?: ReconcileZombieDeps['onReconciledZombie'];
}

const moveBodySchema = z.object({
  direction: z.enum(['up', 'down']),
});

const steerBodySchema = z
  .object({
    mode: z.literal('immediate').optional(),
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

/**
 * F194 Phase B: produce canonical activeInvocations using getThreadLiveInvocations helper
 * (record + tracker + draft 收口为单一 read model). Falls back to tracker-only when the
 * record/draft stores aren't wired (legacy unit tests, embedded modes), preserving the
 * pre-F194 contract. Helper exceptions degrade to fallback + warn log; the endpoint never
 * 500s on a liveness lookup error.
 */
async function resolveActiveInvocations(
  threadId: string,
  userId: string,
  invocationTracker: InvocationTrackerLike,
  recordStore: IInvocationRecordStore | undefined,
  draftStore: IDraftStore | undefined,
  turnExecutionStore: Pick<ITurnExecutionStore, 'listByParent'> | undefined,
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void },
  taskProgressStore?: TaskProgressStore,
  ballCustody?: IBallCustodyIngest,
  invocationRegistry?: QueueRoutesOptions['invocationRegistry'],
  onReconciledZombie?: ReconcileZombieDeps['onReconciledZombie'],
  /** F220 Phase 2a (#972): lets the zombie sweep also converge the dead invocation's
   *  stale `processing` queue entry, so later user work stops queuing behind a corpse. */
  invocationQueue?: InvocationQueue,
  /** F220 Phase 2a (#972): fired only when the sweep actually removed queue entries →
   *  caller re-broadcasts `queue_updated` so the UI unblocks without a refresh. */
  onQueueConverged?: (info: { threadId: string; userId: string; removedEntryIds: string[] }) => void,
): Promise<ActiveInvocationProjection[]> {
  if (!recordStore || !draftStore) {
    return projectActiveInvocations(threadId, trackerProjectionCandidates(threadId, userId, invocationTracker));
  }
  try {
    const result = await getThreadLiveInvocations(threadId, userId, {
      listRunningRecords: (tid, uid) => recordStore.listRunningByThread(tid, uid),
      getActiveSlots: (tid) => invocationTracker.getActiveSlots(tid),
      getTrackerUserId: (tid, cid) => invocationTracker.getUserId(tid, cid),
      getDrafts: (uid, tid) => draftStore.getByThread(uid, tid),
      ...(turnExecutionStore
        ? { listTurnExecutionsByParent: (parentId: string) => turnExecutionStore.listByParent(parentId) }
        : {}),
      // F194 Phase Z (KD-22): namespace bridge — parent recordStore invocation ↔ per-cat-turn
      // child registry invocation. Wraps InvocationRegistry.getRecord (parentInvocationId field)
      // + getLatestId. Optional — when absent, helper falls back to legacy single-namespace path.
      ...(invocationRegistry
        ? {
            getTurnInvocation: async (id: string) => {
              const rec = await invocationRegistry.getRecord(id);
              if (!rec) return null;
              return {
                parentInvocationId: rec.parentInvocationId,
                threadId: rec.threadId,
                userId: rec.userId,
                catId: rec.catId,
                createdAt: rec.createdAt,
              };
            },
            getLatestTurnInvocationId: (tid: string, cat: string) => invocationRegistry.getLatestId(tid, cat),
          }
        : {}),
      // F194 AC-B12: route diagnostic events into request log. NB: do NOT spread `source: 'F194'`
      // — that would clobber LivenessEvent.source (record+draft / record-only / tracker+draft / null),
      // losing the most diagnostic field. Use `feature` for the F194 marker instead.
      onLog: (event) => log.info({ ...event, feature: 'F194' }, 'F194 liveness event'),
    });
    // F194 AC-B7~B10: fire-and-forget zombie cleanup so /queue read isn't blocked. Lifecycle
    // converges to `failed(error='zombie_record_detected')` + TaskProgress cleared, audit log
    // written. Idempotent (state machine guard rejects double-write).
    if (result.zombies.length > 0) {
      void reconcileZombies(result.zombies, {
        invocationRecordStore: recordStore,
        taskProgressStore,
        ballCustody,
        log,
        onReconciledZombie,
        // F220 Phase 2a (#972): converge the stale `processing` entry too — marking the
        // record failed while leaving its queue entry `processing` pins the queue head
        // forever, which is exactly how a later user @codex never runs.
        ...(invocationQueue ? { invocationQueue } : {}),
        ...(onQueueConverged ? { onQueueConverged } : {}),
      }).catch((err) => log.warn({ err, feature: 'F194' }, 'reconcileZombies failed'));
    }
    // 砚砚 R5 P2: filter null catId — frontend turns queue.activeInvocations[].catId into a
    // real target cat slot identifier (replaceThreadTargetCats / hydrated-{threadId}-{catId}).
    // null catId can only happen for the corner case where a record has no targetCats AND no
    // draft — those entries can't surface as actionable queue slots, so drop them here.
    //
    // Cloud R15 P2: dedup by catId. Helper can yield multiple LiveInvocations for the same cat
    // during recovery windows (e.g., two concurrent `running` records). Frontend
    // replaceThreadTargetCats treats activeInvocations[].catId as cat-level state, so duplicates
    // would render the same cat slot twice. Keep earliest startedAt as the canonical slot age.
    const byCatId = new Map<string, LifecycleProjectionCandidate>();
    for (const s of result.active) {
      if (s.catId === null || s.catId === undefined) continue;
      const existing = byCatId.get(s.catId);
      if (!existing || s.startedAt < existing.startedAt) {
        const lifecycleOwnerId = resolveLifecycleOwnerId(threadId, userId, s.catId, s.executionId, invocationTracker);
        const turnInvocationId =
          s.invocationId !== s.executionId && lifecycleOwnerId === s.executionId ? s.invocationId : undefined;
        byCatId.set(s.catId, {
          catId: s.catId,
          startedAt: s.startedAt,
          lifecycleOwnerId,
          ...(turnInvocationId ? { turnInvocationId } : {}),
        });
      }
    }
    return projectActiveInvocations(threadId, Array.from(byCatId.values()));
  } catch (err) {
    // F194 AC-B13: fallback metric — split-brain protection bypassed when this fires.
    log.warn(
      { err, kind: 'liveness_fallback', threadId, userId, feature: 'F194', endpoint: '/queue' },
      'F194 helper failed, fall-back tracker-only',
    );
    return projectActiveInvocations(threadId, trackerProjectionCandidates(threadId, userId, invocationTracker));
  }
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
        opts.taskProgressStore,
        opts.ballCustody,
        opts.invocationRegistry,
        opts.onReconciledZombie,
        // F220 Phase 2a (#972): wire the queue into the zombie sweep, and re-broadcast
        // `queue_updated` when (and only when) entries were actually converged.
        invocationQueue,
        (info) => {
          void emitQueueUpdated(
            opts.socketManager,
            info.userId,
            info.threadId,
            invocationQueue.list(info.threadId, info.userId),
            messageStore,
            'zombie_converged',
          ).catch((err) => request.log.warn({ err, feature: 'F220' }, 'zombie_converged broadcast failed'));
        },
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
      const steerCatId = entry.targetCats[0] ?? 'unknown';
      if (invocationTracker.has(threadId, steerCatId)) {
        const activeUserId = invocationTracker.getUserId(threadId, steerCatId);
        if (activeUserId && activeUserId !== guard.userId) {
          reply.status(409);
          return { error: '当前有其他用户的调用在执行，无法立即执行', code: 'INVOCATION_ACTIVE' };
        }
        const cancelResult = invocationTracker.cancel(threadId, steerCatId, guard.userId, 'preempted');
        releaseAgentSessionLocks(
          { threadId, userId: guard.userId, catId: steerCatId },
          request,
          'steer',
          cancelResult.executionIds ?? [],
        );
        // Broadcast cancel+done so frontend clears old invocation's "正在回复中" state.
        // Without this, activeInvocations retains the old invocationId permanently.
        // Scope to steerCatId only — cancelResult.catIds may include co-dispatched cats
        // whose separate invocations should not be terminated.
        if (cancelResult.cancelled) {
          const scopedResult = { ...cancelResult, catIds: [steerCatId] };
          for (const m of buildCancelMessages(scopedResult)) {
            socketManager.broadcastAgentMessage(m, threadId);
          }
        }
        // F108 P1-4 fix: abort only the target cat's dispatches, not the entire thread
        getMultiMentionOrchestrator().abortBySlot(threadId, steerCatId as CatId);
        if (!cancelResult.cancelled && invocationTracker.has(threadId, steerCatId)) {
          reply.status(409);
          return { error: '当前调用无法取消，无法立即执行', code: 'INVOCATION_CANCEL_FAILED' };
        }
        // Real invocation just cancelled → free its slot so processNext can start the steered entry.
        queueProcessor.clearPause(threadId, steerCatId);
        queueProcessor.releaseSlot(threadId, steerCatId);
      } else {
        // A stale invocation can lose its tracker slot while retaining the
        // resumable-session lock. Immediate steer is an explicit preemption,
        // so clear that owner-scoped lock before starting the replacement.
        releaseAgentSessionLocks({ threadId, userId: guard.userId, catId: steerCatId }, request, 'steer');
        // 2026-06-02 fix (Steer 无法抢占 — race-safe, 云端 codex R3 P1): tracker has NO live
        // invocation for steerCatId, but its processingSlot may still be occupied by an executeEntry
        // stuck in the PRE-START window (processingSlots.set runs before `await
        // invocationRecordStore.create` + startAll — a window bounded by a Redis `eval`, NOT by any
        // constant). Force-releasing that slot by age would double-start the cat once create returns.
        // Instead, mirror callback-a2a-trigger:194-217: TOMBSTONE the in-flight entry. executeEntry
        // re-checks entry presence right after startAll (QueueProcessor.ts F216-c3 guard) and
        // self-aborts before routeExecution, then frees its own slot; the promoted steered entry runs
        // via tryAutoExecute. Race-safe: no slot is force-released, no liveness heuristic.
        const inflight = invocationQueue.findProcessingByCat(threadId, steerCatId);
        // 云端 R4 P1-b: cross-user guard — mirror the has()=true `activeUserId !== guard.userId`
        // rejection. In a public/system thread another user can hold this cat's pre-start slot;
        // one user must NOT interrupt another user's in-flight entry by steering their own.
        if (inflight && inflight.userId !== guard.userId) {
          reply.status(409);
          return { error: '当前有其他用户的调用在执行，无法立即执行', code: 'INVOCATION_ACTIVE' };
        }
        if (inflight) {
          // An occupied slot with has()=false is ALWAYS "executeEntry pending in the pre-start
          // (create-await) window" — steer cannot distinguish a slow-but-live create from a hung
          // one (云端 R3–R6: NO age threshold is sound, since create awaits an unbounded Redis eval).
          // So force-releasing is never sound (would double-start if create later resumes). The only
          // sound action is TOMBSTONE: executeEntry self-aborts at its post-startAll guard when create
          // returns, then the promoted entry runs via tryAutoExecute. A truly-hung create (dead Redis)
          // is recovered by the 75-min zombie sweep / force-reset endpoint — not by steer.
          // 云端 R7 P1: collect the tombstoned entry's message ids BEFORE removing it.
          const tombstonedMsgIds = [inflight.messageId, ...(inflight.mergedMessageIds ?? [])].filter(
            Boolean,
          ) as string[];
          queueProcessor.clearPause(threadId, steerCatId);
          const tombstoned = invocationQueue.removeProcessedAcrossUsers(threadId, inflight.id); // tombstone → self-abort
          await queueProcessor.finalizeRemovedEntry?.(tombstoned, 'user_cancel');
          // 云端 R7 P1: mirror the withdraw/clear F117 cleanup — the tombstoned in-flight entry's
          // executeEntry self-aborts BEFORE its markDelivered block, so without this the original
          // user message stays permanently 'queued' (undelivered + excluded from context) even though
          // its queue entry is gone. Mark it canceled + emit message_deleted.
          if (messageStore) {
            for (const msgId of tombstonedMsgIds) {
              const canceled = await messageStore.markCanceled(msgId);
              if (canceled?.deliveryTransitioned === true) {
                socketManager.emitToUser(guard.userId, 'message_deleted', {
                  messageId: msgId,
                  threadId,
                  deletedBy: guard.userId,
                });
              }
            }
          }
          if (!invocationQueue.markSteering(threadId, guard.userId, entryId, steerCatId)) {
            reply.status(409);
            return { error: 'Steer 状态已变化，请重试', code: 'STEER_STATE_CHANGED' };
          }
          invocationQueue.promote(threadId, guard.userId, entryId);
          await persistQueueEntries(threadId, guard.userId, [entryId]);
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
        // No in-flight processing entry occupies the slot → nothing unsafe to clear here.
        // Fall through to the normal promote + processNext (starts if the slot is genuinely free).
        queueProcessor.clearPause(threadId, steerCatId);
      }

      if (!invocationQueue.markSteering(threadId, guard.userId, entryId, steerCatId)) {
        reply.status(409);
        return { error: 'Steer 状态已变化，请重试', code: 'STEER_STATE_CHANGED' };
      }
      invocationQueue.promote(threadId, guard.userId, entryId);
      await persistQueueEntries(threadId, guard.userId, [entryId]);
      await emitQueueUpdated(
        socketManager,
        guard.userId,
        threadId,
        invocationQueue.list(threadId, guard.userId),
        messageStore,
        'steer_immediate',
      );

      const result = await queueProcessor.processNext(threadId, guard.userId);
      if (!result.started) {
        invocationQueue.clearSteering(threadId, guard.userId, entryId, steerCatId);
        await persistQueueEntries(threadId, guard.userId, [entryId]);
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
    //    cancelledCatIds (tracker slots just aborted) ∪ running records' targetCats. The latter
    //    covers the STALE case codex flagged — when the tracker slot is already gone (so cancelAll
    //    returned []) but the processingSlot + running record persist, force-reset must still
    //    release that orphan processingSlot or hasActiveExecution stays true until TTL.
    //    Sources are guard.userId-scoped, but QueueProcessor slots are not; the final owner check
    //    below prevents a stale source from colliding with a newer foreign tracker slot.
    const slotsToRelease = new Set<string>(cancelledCatIds);
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
