/**
 * Task CRUD Routes (毛线球)
 *
 * POST   /api/tasks         → 创建任务 (201)
 * GET    /api/tasks?threadId → 列出线程任务
 * GET    /api/tasks/:id     → 获取单个 / 404
 * PATCH  /api/tasks/:id     → 更新状态/标题/owner
 * DELETE /api/tasks/:id     → 删除 (204)
 */

import type { CatId, CreateTaskInput, UpdateTaskInput } from '@cat-cafe/shared';
import { catIdSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface TasksRoutesOptions {
  taskStore: ITaskStore;
  socketManager: SocketManager;
}

const VALID_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;

/** createdBy accepts any registered catId OR 'user' */
const createdBySchema = z.union([catIdSchema(), z.literal('user')]);

const createSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1).max(200),
  why: z.string().max(1000).default(''),
  createdBy: createdBySchema,
  ownerCatId: catIdSchema().nullable().optional(),
});

const updateSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    ownerCatId: catIdSchema().nullable().optional(),
    status: z.enum(VALID_STATUSES).optional(),
    why: z.string().max(1000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

/** Build CreateTaskInput from zod output (bridges string→CatId branded types) */
function toCreateInput(data: z.infer<typeof createSchema>): CreateTaskInput {
  const input: CreateTaskInput = {
    threadId: data.threadId,
    title: data.title,
    why: data.why,
    createdBy: data.createdBy as CatId | 'user',
  };
  if (data.ownerCatId != null) {
    return { ...input, ownerCatId: data.ownerCatId as CatId };
  }
  return input;
}

/** Build UpdateTaskInput from zod output (filters undefined, bridges branded types) */
function toUpdateInput(data: z.infer<typeof updateSchema>): UpdateTaskInput {
  const input: UpdateTaskInput = {};
  if (data.title !== undefined) input.title = data.title;
  if (data.status !== undefined) input.status = data.status;
  if (data.why !== undefined) input.why = data.why;
  if (data.ownerCatId !== undefined) input.ownerCatId = data.ownerCatId as CatId | null;
  return input;
}

export const tasksRoutes: FastifyPluginAsync<TasksRoutesOptions> = async (app, opts) => {
  const { taskStore, socketManager } = opts;

  // POST /api/tasks
  app.post('/api/tasks', async (request, reply) => {
    const result = createSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const task = await taskStore.create(toCreateInput(result.data));
    socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_created', task);

    reply.status(201);
    return task;
  });

  // GET /api/tasks?threadId=xxx[&kind=work|pr_tracking]
  app.get('/api/tasks', async (request, reply) => {
    const { threadId, kind } = request.query as { threadId?: string; kind?: string };
    if (!threadId) {
      reply.status(400);
      return { error: 'Missing threadId query parameter' };
    }

    let tasks = await taskStore.listByThread(threadId);
    if (kind) tasks = tasks.filter((t) => t.kind === kind);
    return { tasks };
  });

  // GET /api/tasks/:id
  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await taskStore.get(id);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    return task;
  });

  // PATCH /api/tasks/:id
  app.patch('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const updated = await taskStore.update(id, toUpdateInput(result.data));
    if (!updated) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);

    return updated;
  });

  // DELETE /api/tasks/:id
  app.delete('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await taskStore.delete(id);
    if (!deleted) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    reply.status(204);
  });
};
