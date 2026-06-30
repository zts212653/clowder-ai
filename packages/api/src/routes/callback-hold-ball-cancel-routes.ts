import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import type { TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveUserId } from '../utils/request-identity.js';
import { cancelWakeWhenRunner } from './callback-hold-ball-routes.js';
import { executeHoldCancel, findHoldBallTask } from './hold-ball-cancel.js';
import { HOLD_BALL_SOURCE } from './hold-ball-source.js';

const log = createModuleLogger('routes/callback-hold-ball-cancel');

const holdBallFeedbackSchema = z.object({
  threadId: z.string().min(1).max(100),
  taskId: z.string().min(1).max(200).optional(),
  catId: z.string().min(1).max(100).optional(),
});

export interface HoldBallCancelRouteDeps {
  dynamicTaskStore: DynamicTaskStore;
  taskRunner: TaskRunnerV2;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  threadStore: { get(threadId: string): { createdBy: string } | null | Promise<{ createdBy: string } | null> };
  onHoldBallCancelFeedback?: (input: {
    taskId: string;
    threadId: string;
    userId: string;
    catId: string;
  }) => void | Promise<void>;
}

async function authorizeThreadAccess(
  deps: HoldBallCancelRouteDeps,
  userId: string,
  threadId: string,
  reply: FastifyReply,
) {
  const thread = await deps.threadStore.get(threadId);
  if (!thread || (thread.createdBy !== userId && thread.createdBy !== 'system')) {
    reply.status(403);
    return false;
  }
  return true;
}

export function registerHoldBallCancelRoutes(app: FastifyInstance, deps: HoldBallCancelRouteDeps): void {
  const { dynamicTaskStore, taskRunner, messageStore, socketManager } = deps;

  app.delete<{ Params: { taskId: string }; Querystring: { withFeedback?: string } }>(
    '/api/callbacks/hold-ball/:taskId',
    async (request, reply) => {
      const userId = resolveUserId(request);
      if (!userId) {
        reply.status(401);
        return { error: 'Unauthorized' };
      }

      const { taskId } = request.params;
      const withFeedback = request.query.withFeedback === '1' || request.query.withFeedback === 'true';
      const task = findHoldBallTask(taskId, dynamicTaskStore);
      if (!task) {
        reply.status(404);
        return { error: 'Hold task not found or not a hold-ball task' };
      }

      const threadId = task.deliveryThreadId;
      if (threadId && !(await authorizeThreadAccess(deps, userId, threadId, reply))) {
        return { error: 'Not authorized to cancel holds in this thread' };
      }

      executeHoldCancel(task, { dynamicTaskStore, taskRunner });
      const catId = task.createdBy?.replace('hold-ball:', '') ?? 'unknown';
      // P1-1: also cancel any running wakeWhen command for this (thread, cat)
      if (threadId) {
        cancelWakeWhenRunner(threadId, catId);
      }
      log.info({ taskId, threadId, catId, userId }, 'F167 Phase J: hold_ball cancelled by user');

      if (withFeedback && threadId && deps.onHoldBallCancelFeedback) {
        try {
          await deps.onHoldBallCancelFeedback({ taskId, threadId, userId, catId });
        } catch (err) {
          log.warn({ taskId, threadId, err }, 'F222 UX-3: failed to trigger hold_ball cancel feedback');
        }
      }

      if (threadId) {
        try {
          const cancelMessage = `🏓 ${catId} 持球已取消`;
          const stored = await messageStore.append({
            userId: 'system',
            catId: null,
            content: cancelMessage,
            mentions: [],
            timestamp: Date.now(),
            threadId,
            source: HOLD_BALL_SOURCE,
          });
          socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
            threadId,
            message: {
              id: stored.id,
              type: 'connector',
              content: stored.content,
              source: HOLD_BALL_SOURCE,
              timestamp: stored.timestamp,
            },
          });
        } catch (err) {
          log.warn({ taskId, threadId, err }, 'F167 Phase J: failed to post hold cancel visibility message');
        }
      }

      return { status: 'ok', cancelled: true, taskId };
    },
  );

  app.post('/api/callbacks/hold-ball/feedback', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const parsed = holdBallFeedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { threadId, taskId, catId } = parsed.data;
    if (!(await authorizeThreadAccess(deps, userId, threadId, reply))) {
      return { error: 'Not authorized to report hold feedback in this thread' };
    }

    if (!deps.onHoldBallCancelFeedback) {
      reply.status(503);
      return { error: 'Hold feedback is not configured' };
    }

    await deps.onHoldBallCancelFeedback({
      taskId: taskId ?? 'hold-ball-stale',
      threadId,
      userId,
      catId: catId ?? 'unknown',
    });

    return { status: 'ok', feedback: true };
  });
}
