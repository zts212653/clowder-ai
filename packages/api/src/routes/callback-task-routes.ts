/**
 * Callback task routes — MCP post_message 回传的任务更新端点
 */

import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

const updateTaskSchema = callbackAuthSchema.extend({
  taskId: z.string().min(1),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  why: z.string().max(1000).optional(),
});

const listTasksQuerySchema = callbackAuthSchema.extend({
  threadId: z.string().min(1).optional(),
  catId: z.string().min(1).optional(),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  kind: z.enum(['work', 'pr_tracking']).optional(),
});

export function registerCallbackTaskRoutes(
  app: FastifyInstance,
  deps: {
    registry: InvocationRegistry;
    taskStore: ITaskStore;
    socketManager: SocketManager;
    threadStore?: IThreadStore;
  },
): void {
  const { registry, taskStore, socketManager, threadStore } = deps;

  app.post('/api/callbacks/update-task', async (request, reply) => {
    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, taskId, status, why } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    const existing = await taskStore.get(taskId);
    if (!existing) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    if (existing.threadId !== record.threadId) {
      reply.status(403);
      return { error: 'Task belongs to a different thread' };
    }
    if (existing.ownerCatId && existing.ownerCatId !== record.catId) {
      reply.status(403);
      return { error: 'Task is owned by another cat' };
    }

    const updateData: Record<string, unknown> = {};
    if (status) updateData.status = status;
    if (why) updateData.why = why;

    const updated = await taskStore.update(taskId, updateData);
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to update task' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    return { status: 'ok', task: updated };
  });

  app.get('/api/callbacks/list-tasks', async (request, reply) => {
    const parsed = listTasksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, threadId, catId, status, kind } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    if (catId && !catRegistry.has(catId)) {
      reply.status(400);
      return { error: `Unknown catId: ${catId}` };
    }

    let scopedThreadIds: string[] = [];
    if (threadId) {
      if (threadId === record.threadId) {
        scopedThreadIds = [threadId];
      } else {
        if (!threadStore) {
          reply.status(503);
          return { error: 'Thread store not configured for cross-thread task query' };
        }
        const targetThread = await threadStore.get(threadId);
        if (!targetThread || targetThread.createdBy !== record.userId) {
          reply.status(403);
          return { error: 'Thread access denied' };
        }
        scopedThreadIds = [threadId];
      }
    } else if (threadStore) {
      const userThreads = await threadStore.list(record.userId);
      scopedThreadIds = userThreads.map((item) => item.id);
    } else {
      app.log.warn(
        { userId: record.userId, invocationId },
        '[callbacks/list-tasks] threadStore unavailable, falling back to current thread only',
      );
      scopedThreadIds = [record.threadId];
    }

    const perThreadTasks = await Promise.all(scopedThreadIds.map((id) => taskStore.listByThread(id)));
    let tasks = perThreadTasks.flat();
    if (catId) tasks = tasks.filter((item) => item.ownerCatId === catId);
    if (status) tasks = tasks.filter((item) => item.status === status);
    if (kind) tasks = tasks.filter((item) => item.kind === kind);
    tasks.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id));

    return { tasks };
  });
}
