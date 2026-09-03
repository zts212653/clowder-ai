/**
 * Task CRUD Routes (毛线球)
 *
 * POST   /api/tasks         → 创建任务 (201)
 * GET    /api/tasks?threadId → 列出线程任务
 * GET    /api/tasks/:id     → 获取单个 / 404
 * PATCH  /api/tasks/:id     → 更新状态/标题/owner
 * DELETE /api/tasks/:id     → 删除 (204)
 */

import type {
  CatId,
  CreateTaskInput,
  EntrustedWorkTerminalClosureV1,
  TaskItem,
  UpdateTaskInput,
} from '@cat-cafe/shared';
import { catIdSchema, entrustedWorkTerminalActionV1Schema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MAX_BALL_CUSTODY_HTTP_PROBE_TIMEOUT_MS } from '../domains/ball-custody/BallCustodyProbeTaskSpec.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { isEntrustedWorkTerminalActionRequiredError } from '../domains/cats/services/stores/ports/TaskStoreContract.js';
import type { GitHubWaitLifecycleService } from '../domains/github-signals/GitHubWaitLifecycleService.js';
import {
  EntrustedWorkLifecycleError,
  EntrustedWorkLifecycleService,
} from '../domains/growing/EntrustedWorkLifecycleService.js';
import { validateUrl } from '../infrastructure/scheduler/content-fetcher.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveStrictUserId, resolveUserId } from '../utils/request-identity.js';

export interface TasksRoutesOptions {
  taskStore: ITaskStore;
  socketManager: SocketManager;
  waitLifecycleHolder?: { current?: GitHubWaitLifecycleService };
}

const VALID_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
const VALID_RESOLVE_MODES = ['bounces_back', 'completes'] as const;

/** createdBy accepts any registered catId OR 'user' */
const createdBySchema = z.union([catIdSchema(), z.literal('user')]);
function isSafeProbeUrl(url: string): boolean {
  try {
    validateUrl(url);
    return true;
  } catch {
    return false;
  }
}

const taskProbeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http_get'),
    url: z.string().url().refine(isSafeProbeUrl, {
      message: 'http_get probe url must be public HTTP(S)',
    }),
    expectStatus: z.number().int().min(100).max(599).optional(),
    timeoutMs: z.number().int().positive().max(MAX_BALL_CUSTODY_HTTP_PROBE_TIMEOUT_MS).optional(),
  }),
  z.object({
    kind: z.literal('redis_exists'),
    key: z.string().min(1).max(500),
  }),
]);

const createSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1).max(200),
  why: z.string().max(1000).default(''),
  createdBy: createdBySchema,
  ownerCatId: catIdSchema().nullable().optional(),
  probe: taskProbeSchema.nullable().optional(),
  resolveMode: z.enum(VALID_RESOLVE_MODES).nullable().optional(),
});

const updateSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    ownerCatId: catIdSchema().nullable().optional(),
    status: z.enum(VALID_STATUSES).optional(),
    why: z.string().max(1000).optional(),
    probe: taskProbeSchema.nullable().optional(),
    resolveMode: z.enum(VALID_RESOLVE_MODES).nullable().optional(),
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
    input.ownerCatId = data.ownerCatId as CatId;
  }
  if (data.probe !== undefined) input.probe = data.probe;
  if (data.resolveMode !== undefined) input.resolveMode = data.resolveMode;
  return input;
}

/** Build UpdateTaskInput from zod output (filters undefined, bridges branded types) */
function toUpdateInput(data: z.infer<typeof updateSchema>): UpdateTaskInput {
  const input: UpdateTaskInput = {};
  if (data.title !== undefined) input.title = data.title;
  if (data.status !== undefined) input.status = data.status;
  if (data.why !== undefined) input.why = data.why;
  if (data.ownerCatId !== undefined) input.ownerCatId = data.ownerCatId as CatId | null;
  if (data.probe !== undefined) input.probe = data.probe;
  if (data.resolveMode !== undefined) input.resolveMode = data.resolveMode;
  return input;
}

function validateEntrustedWorkWebClose(
  task: TaskItem,
  userId: string,
  closure: EntrustedWorkTerminalClosureV1,
): { statusCode: 403; error: string } | null {
  if (!task.userId || task.userId !== userId) {
    return { statusCode: 403, error: 'Not your entrusted work' };
  }
  if (
    closure.state !== 'satisfied' &&
    (closure.disposition.actorKind !== 'human' || closure.disposition.actorRef !== `user:${userId}`)
  ) {
    return { statusCode: 403, error: 'Human disposition actor does not match the authenticated user' };
  }
  return null;
}

function entrustedWorkLifecycleHttpStatus(error: EntrustedWorkLifecycleError): 404 | 409 {
  return error.code === 'ENTRUSTED_WORK_NOT_FOUND' ? 404 : 409;
}

export const tasksRoutes: FastifyPluginAsync<TasksRoutesOptions> = async (app, opts) => {
  const { taskStore, socketManager } = opts;
  const entrustedWorkLifecycle = new EntrustedWorkLifecycleService(taskStore);

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

    const before = await taskStore.get(id);
    if (
      before?.kind === 'pr_tracking' &&
      before.automationState?.await &&
      result.data.ownerCatId !== undefined &&
      result.data.ownerCatId !== before.ownerCatId
    ) {
      await opts.waitLifecycleHolder?.current?.ownerChanged(id);
    }
    let updated: TaskItem | null;
    try {
      updated = await taskStore.update(id, toUpdateInput(result.data));
    } catch (error) {
      if (isEntrustedWorkTerminalActionRequiredError(error)) {
        reply.status(409);
        return {
          error: 'Entrusted work requires an evidence-backed typed closure action',
          code: error.code,
        };
      }
      throw error;
    }
    if (!updated) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);

    return updated;
  });

  // POST /api/tasks/:id/cancel-wait — authenticated, server-bound terminal transition.
  app.post('/api/tasks/:id/cancel-wait', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const body = z
      .object({})
      .strict()
      .safeParse(request.body ?? {});
    if (!body.success) {
      reply.status(400);
      return { error: 'Request body must be empty', details: body.error.issues };
    }
    const { id } = request.params as { id: string };
    const task = await taskStore.get(id);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    if (task.kind !== 'pr_tracking' || !task.automationState?.await) {
      reply.status(409);
      return { error: 'Task has no active PR wait' };
    }
    if (!task.userId || task.userId !== userId) {
      reply.status(403);
      return { error: 'Not your wait' };
    }
    const lifecycle = opts.waitLifecycleHolder?.current;
    if (!lifecycle) {
      reply.status(503);
      return { error: 'Wait lifecycle unavailable' };
    }
    const result = await lifecycle.cancel(task.id, { kind: 'user', userId });
    const updated = await taskStore.get(task.id);
    if (updated) socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    return { status: 'cancelled', result };
  });

  // POST /api/tasks/:id/entrusted-work/close — Task-owned typed terminal action.
  app.post('/api/tasks/:id/entrusted-work/close', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const parsed = entrustedWorkTerminalActionV1Schema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { id } = request.params as { id: string };
    const existing = await taskStore.get(id);
    if (!existing) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    const { closure } = parsed.data;
    const accessError = validateEntrustedWorkWebClose(existing, userId, closure);
    if (accessError) {
      reply.status(accessError.statusCode);
      return { error: accessError.error };
    }
    try {
      const task = await entrustedWorkLifecycle.close({ taskId: id, ...parsed.data });
      socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_updated', task);
      return { status: 'closed', task };
    } catch (error) {
      if (!(error instanceof EntrustedWorkLifecycleError)) throw error;
      reply.status(entrustedWorkLifecycleHttpStatus(error));
      return { error: error.message, code: error.code };
    }
  });

  // DELETE /api/tasks/:id
  app.delete('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    let deleted: boolean;
    try {
      deleted = await taskStore.delete(id);
    } catch (error) {
      if (!isEntrustedWorkTerminalActionRequiredError(error)) throw error;
      reply.status(409);
      return {
        error: 'Entrusted work cannot be deleted outside its evidence-backed typed lifecycle',
        code: error.code,
      };
    }
    if (!deleted) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    reply.status(204);
  });
};
