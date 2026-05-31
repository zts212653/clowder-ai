/**
 * Queue Management API Routes (F39)
 *
 * GET    /api/threads/:threadId/queue               → 列出队列条目
 * DELETE /api/threads/:threadId/queue/:entryId       → 撤回条目
 * POST   /api/threads/:threadId/queue/next          → 手动触发处理下一条
 * POST   /api/threads/:threadId/queue/:entryId/steer → Steer queued entry（立即执行/提到队首）
 * PATCH  /api/threads/:threadId/queue/:entryId/move → 重排序（上移/下移）
 * PATCH  /api/threads/:threadId/queue/reorder       → F175: 批量设置 position（拖拽重排）
 * DELETE /api/threads/:threadId/queue               → 清空队列
 * POST   /api/threads/:threadId/cancel/:catId       → F122B AC-B9: Per-cat cancel
 */

import type { CatId } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getThreadLiveInvocations } from '../domains/cats/services/agents/invocation/getThreadLiveInvocations.js';
import {
  type InvocationQueue,
  isSystemPinnedQueueEntry,
} from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { reconcileZombies } from '../domains/cats/services/agents/invocation/reconcileZombies.js';
import type { TaskProgressStore } from '../domains/cats/services/agents/invocation/TaskProgressStore.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { buildCancelMessages, type SocketManager } from '../infrastructure/websocket/index.js';
import { resolveUserId } from '../utils/request-identity.js';
import { getMultiMentionOrchestrator } from './callback-multi-mention-routes.js';

interface InvocationTrackerLike {
  has(threadId: string, catId?: string): boolean;
  getUserId(threadId: string, catId: string): string | null;
  cancel(
    threadId: string,
    catId: string,
    requestUserId?: string,
    abortReason?: string,
  ): { cancelled: boolean; catIds: string[] };
  /** Issue #83: Get all active slots for a thread (F5 refresh recovery) */
  getActiveSlots(threadId: string): Array<{ catId: string; startedAt: number }>;
  /** F-invocation-stale-recovery: Cancel ALL active slots for a thread (abort controllers + delete slots). */
  cancelAll?(threadId: string, requestUserId?: string, abortReason?: string): string[];
}

export interface QueueRoutesOptions {
  threadStore: IThreadStore;
  invocationQueue: InvocationQueue;
  queueProcessor: QueueProcessor;
  invocationTracker: InvocationTrackerLike;
  socketManager: SocketManager;
  /** F117: MessageStore for marking queued messages as canceled on withdraw/clear */
  messageStore?: IMessageStore;
  /** F194 Phase B: canonical liveness read sources (record + draft). When omitted,
   *  GET /queue's activeInvocations falls back to legacy tracker-only enumeration
   *  for backward compat in tests. */
  invocationRecordStore?: IInvocationRecordStore;
  draftStore?: IDraftStore;
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
}

const moveBodySchema = z.object({
  direction: z.enum(['up', 'down']),
});

const steerBodySchema = z.object({
  mode: z.enum(['promote', 'immediate']),
});

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
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void },
  taskProgressStore?: TaskProgressStore,
  invocationRegistry?: QueueRoutesOptions['invocationRegistry'],
): Promise<Array<{ catId: string; startedAt: number }>> {
  if (!recordStore || !draftStore) {
    return invocationTracker.getActiveSlots(threadId);
  }
  try {
    const result = await getThreadLiveInvocations(threadId, userId, {
      listRunningRecords: (tid, uid) => recordStore.listRunningByThread(tid, uid),
      getActiveSlots: (tid) => invocationTracker.getActiveSlots(tid),
      getTrackerUserId: (tid, cid) => invocationTracker.getUserId(tid, cid),
      getDrafts: (uid, tid) => draftStore.getByThread(uid, tid),
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
        log,
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
    const byCatId = new Map<string, { catId: string; startedAt: number }>();
    for (const s of result.active) {
      if (s.catId === null || s.catId === undefined) continue;
      const existing = byCatId.get(s.catId);
      if (!existing || s.startedAt < existing.startedAt) {
        byCatId.set(s.catId, { catId: s.catId, startedAt: s.startedAt });
      }
    }
    return Array.from(byCatId.values());
  } catch (err) {
    // F194 AC-B13: fallback metric — split-brain protection bypassed when this fires.
    log.warn(
      { err, kind: 'liveness_fallback', threadId, userId, feature: 'F194', endpoint: '/queue' },
      'F194 helper failed, fall-back tracker-only',
    );
    return invocationTracker.getActiveSlots(threadId);
  }
}

export const queueRoutes: FastifyPluginAsync<QueueRoutesOptions> = async (app, opts) => {
  const { threadStore, invocationQueue, queueProcessor, invocationTracker, socketManager, messageStore } = opts;

  // GET /api/threads/:threadId/queue
  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/queue', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    const activeInvocations = await resolveActiveInvocations(
      threadId,
      guard.userId,
      invocationTracker,
      opts.invocationRecordStore,
      opts.draftStore,
      request.log,
      opts.taskProgressStore,
      opts.invocationRegistry,
    );
    return {
      queue: invocationQueue.list(threadId, guard.userId),
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

      // F117: Collect message IDs before removing (entry contains messageId + mergedMessageIds)
      const messageIds = [entry.messageId, ...(entry.mergedMessageIds ?? [])].filter(Boolean) as string[];

      const removed = invocationQueue.remove(threadId, guard.userId, entryId);
      // F122B B6 P2: Clean up completion hook to prevent leak when entry removed before execution
      queueProcessor.unregisterEntryCompleteHook?.(entryId);
      socketManager.emitToUser(guard.userId, 'queue_updated', {
        threadId,
        queue: invocationQueue.list(threadId, guard.userId),
        action: 'removed',
      });

      // F117: Mark queued messages as canceled + emit message_deleted
      if (messageStore) {
        for (const msgId of messageIds) {
          await messageStore.markCanceled(msgId);
          socketManager.emitToUser(guard.userId, 'message_deleted', {
            messageId: msgId,
            threadId,
            deletedBy: guard.userId,
          });
        }
      }

      return { removed };
    },
  );

  // POST /api/threads/:threadId/queue/next
  app.post<{ Params: { threadId: string } }>('/api/threads/:threadId/queue/next', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    const result = await queueProcessor.processNext(threadId, guard.userId);
    return result;
  });

  // POST /api/threads/:threadId/queue/:entryId/steer
  app.post<{ Params: { threadId: string; entryId: string } }>(
    '/api/threads/:threadId/queue/:entryId/steer',
    async (request, reply) => {
      const { threadId, entryId } = request.params;
      const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
      if (!guard) return;

      const parseResult = steerBodySchema.safeParse(request.body);
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

      const { mode } = parseResult.data;
      if (mode === 'promote') {
        invocationQueue.promote(threadId, guard.userId, entryId);
        socketManager.emitToUser(guard.userId, 'queue_updated', {
          threadId,
          queue: invocationQueue.list(threadId, guard.userId),
          action: 'steer_promote',
        });
        return { ok: true };
      }

      // mode === 'immediate'
      const steerCatId = entry.targetCats[0] ?? 'unknown';
      if (invocationTracker.has(threadId, steerCatId)) {
        const activeUserId = invocationTracker.getUserId(threadId, steerCatId);
        if (activeUserId && activeUserId !== guard.userId) {
          reply.status(409);
          return { error: '当前有其他用户的调用在执行，无法立即执行', code: 'INVOCATION_ACTIVE' };
        }
        const cancelResult = invocationTracker.cancel(threadId, steerCatId, guard.userId, 'preempted');
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
        queueProcessor.clearPause(threadId, steerCatId);
        queueProcessor.releaseSlot(threadId, steerCatId);
      }

      invocationQueue.promote(threadId, guard.userId, entryId);
      socketManager.emitToUser(guard.userId, 'queue_updated', {
        threadId,
        queue: invocationQueue.list(threadId, guard.userId),
        action: 'steer_immediate',
      });

      const result = await queueProcessor.processNext(threadId, guard.userId);
      if (!result.started) {
        reply.status(409);
        return { error: '队列繁忙，暂无法立即执行', code: 'QUEUE_BUSY' };
      }

      return result;
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
      socketManager.emitToUser(guard.userId, 'queue_updated', {
        threadId,
        queue: invocationQueue.list(threadId, guard.userId),
        action: 'reordered',
      });

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

    socketManager.emitToUser(guard.userId, 'queue_updated', {
      threadId,
      queue: invocationQueue.list(threadId, guard.userId),
      action: 'reordered',
    });
    return { ok: true };
  });

  // DELETE /api/threads/:threadId/queue
  app.delete<{ Params: { threadId: string } }>('/api/threads/:threadId/queue', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    // F117: Collect message IDs from non-processing entries for cancelation
    // Skip 'processing' entries — their invocation is already running and will markDelivered itself
    const entriesBeforeClear = invocationQueue.list(threadId, guard.userId);
    const allMessageIds: string[] = [];
    for (const e of entriesBeforeClear) {
      if (e.status === 'processing') continue;
      queueProcessor.unregisterEntryCompleteHook?.(e.id);
      if (e.messageId) allMessageIds.push(e.messageId);
      if (e.mergedMessageIds) allMessageIds.push(...e.mergedMessageIds);
    }

    const cleared = invocationQueue.clear(threadId, guard.userId);
    socketManager.emitToUser(guard.userId, 'queue_updated', {
      threadId,
      queue: [],
      action: 'cleared',
    });

    // F117: Mark all queued messages as canceled + emit message_deleted
    if (messageStore) {
      for (const msgId of allMessageIds) {
        await messageStore.markCanceled(msgId);
        socketManager.emitToUser(guard.userId, 'message_deleted', {
          messageId: msgId,
          threadId,
          deletedBy: guard.userId,
        });
      }
    }

    return { cleared };
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
            for (const m of buildCancelMessages({ cancelled: true, catIds: orphanCats })) {
              socketManager.broadcastAgentMessage(m, threadId);
            }
            for (const c of orphanCats) {
              queueProcessor.clearPause(threadId, c);
              queueProcessor.releaseSlot(threadId, c);
            }
            return { ok: true, cancelled: true };
          }
        }
        reply.status(404);
        return { error: '该猫当前未在执行', code: 'CAT_NOT_ACTIVE' };
      }

      const cancelResult = invocationTracker.cancel(threadId, catId, guard.userId, 'user_cancel');
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
    const cancelledCatIds = invocationTracker.cancelAll?.(threadId, guard.userId, 'cancel_all') ?? [];

    // 2+3. Collect EVERY user-owned cat whose processingSlot may still pin hasActiveExecution:
    //    cancelledCatIds (tracker slots just aborted) ∪ running records' targetCats. The latter
    //    covers the STALE case codex flagged — when the tracker slot is already gone (so cancelAll
    //    returned []) but the processingSlot + running record persist, force-reset must still
    //    release that orphan processingSlot or hasActiveExecution stays true until TTL.
    //    Both sources are guard.userId-scoped (cancelAll + listRunningByThread), so no cross-user
    //    slot leak on shared/system threads.
    const slotsToRelease = new Set<string>(cancelledCatIds);
    let canceledRecords = 0;
    if (opts.invocationRecordStore) {
      const runningRecords = await opts.invocationRecordStore.listRunningByThread(threadId, guard.userId);
      for (const record of runningRecords) {
        for (const c of record.targetCats as string[]) slotsToRelease.add(c);
        await opts.invocationRecordStore.update(record.id, { status: 'canceled' });
        canceledRecords++;
      }
    }

    // Broadcast cancel + clear pause + release processingSlot for EVERY user-owned cat in
    // slotsToRelease (cancelled tracker slots ∪ stale records' targetCats). P2 (opus-4.6 cross-cat
    // review): broadcasting only cancelledCatIds left stale records' cats without a done broadcast,
    // so the frontend "正在回复中" never cleared after force-reset (user had to F5). Doing all three
    // over the full set keeps force-reset aligned with the orphan/normal cancel paths and covers the
    // stale case cancelAll missed.
    if (slotsToRelease.size > 0) {
      for (const m of buildCancelMessages({ cancelled: true, catIds: [...slotsToRelease] })) {
        socketManager.broadcastAgentMessage(m, threadId);
      }
    }
    for (const cid of slotsToRelease) {
      queueProcessor.clearPause(threadId, cid);
      queueProcessor.releaseSlot(threadId, cid);
    }

    return { ok: true, canceledRecords };
  });
};
