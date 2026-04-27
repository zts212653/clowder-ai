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
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
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
}

export interface QueueRoutesOptions {
  threadStore: IThreadStore;
  invocationQueue: InvocationQueue;
  queueProcessor: QueueProcessor;
  invocationTracker: InvocationTrackerLike;
  socketManager: SocketManager;
  /** F117: MessageStore for marking queued messages as canceled on withdraw/clear */
  messageStore?: IMessageStore;
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

export const queueRoutes: FastifyPluginAsync<QueueRoutesOptions> = async (app, opts) => {
  const { threadStore, invocationQueue, queueProcessor, invocationTracker, socketManager, messageStore } = opts;

  // GET /api/threads/:threadId/queue
  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/queue', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    return {
      queue: invocationQueue.list(threadId, guard.userId),
      paused: queueProcessor.isPaused(threadId),
      pauseReason: queueProcessor.getPauseReason(threadId),
      // Issue #83: Expose active invocation slots for F5 refresh recovery.
      // Frontend can use this to restore processing state even when drafts expire.
      activeInvocations: invocationTracker.getActiveSlots(threadId),
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
      if (!entry || entry.status === 'processing') {
        reply.status(400);
        return { error: `Cannot reorder entry ${entryId} (not found or processing)` };
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
};
