/**
 * Queue Management API Routes (F39)
 *
 * GET    /api/threads/:threadId/queue               → 列出队列条目
 * DELETE /api/threads/:threadId/queue/:entryId       → 撤回条目
 * POST   /api/threads/:threadId/queue/next          → 手动触发处理下一条
 * POST   /api/threads/:threadId/queue/:entryId/steer → Steer queued entry（立即执行/提到队首）
 * PATCH  /api/threads/:threadId/queue/:entryId/move → 重排序（上移/下移）
 * DELETE /api/threads/:threadId/queue               → 清空队列
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveUserId } from '../utils/request-identity.js';
import { getMultiMentionOrchestrator } from './callback-multi-mention-routes.js';

interface InvocationTrackerLike {
  has(threadId: string): boolean;
  getUserId(threadId: string): string | null;
  cancel(threadId: string, requestUserId?: string, abortReason?: string): { cancelled: boolean; catIds: string[] };
}

export interface QueueRoutesOptions {
  threadStore: IThreadStore;
  invocationQueue: InvocationQueue;
  queueProcessor: QueueProcessor;
  invocationTracker: InvocationTrackerLike;
  socketManager: SocketManager;
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
  const { threadStore, invocationQueue, queueProcessor, invocationTracker, socketManager } = opts;

  // GET /api/threads/:threadId/queue
  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/queue', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    return {
      queue: invocationQueue.list(threadId, guard.userId),
      paused: queueProcessor.isPaused(threadId),
      pauseReason: queueProcessor.getPauseReason(threadId),
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

      const removed = invocationQueue.remove(threadId, guard.userId, entryId);
      socketManager.emitToUser(guard.userId, 'queue_updated', {
        threadId,
        queue: invocationQueue.list(threadId, guard.userId),
        action: 'removed',
      });

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
      if (invocationTracker.has(threadId)) {
        const activeUserId = invocationTracker.getUserId(threadId);
        if (activeUserId && activeUserId !== guard.userId) {
          reply.status(409);
          return { error: '当前有其他用户的调用在执行，无法立即执行', code: 'INVOCATION_ACTIVE' };
        }
        const cancelResult = invocationTracker.cancel(threadId, guard.userId, 'preempted');
        // Also abort any active multi-mention dispatches for this thread
        getMultiMentionOrchestrator().abortByThread(threadId);
        if (!cancelResult.cancelled && invocationTracker.has(threadId)) {
          reply.status(409);
          return { error: '当前调用无法取消，无法立即执行', code: 'INVOCATION_CANCEL_FAILED' };
        }
        queueProcessor.clearPause(threadId);
        queueProcessor.releaseThread(threadId);
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

  // DELETE /api/threads/:threadId/queue
  app.delete<{ Params: { threadId: string } }>('/api/threads/:threadId/queue', async (request, reply) => {
    const { threadId } = request.params;
    const guard = await guardThreadOwnership(request, reply, threadStore, threadId);
    if (!guard) return;

    const cleared = invocationQueue.clear(threadId, guard.userId);
    socketManager.emitToUser(guard.userId, 'queue_updated', {
      threadId,
      queue: [],
      action: 'cleared',
    });

    return { cleared };
  });
};
