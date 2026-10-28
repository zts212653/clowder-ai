import { adoptOrdinaryTaskTenant } from '../domains/ball-custody/adopt-ordinary-task-tenant.js';
import { OrdinaryTaskHandoffError } from '../domains/ball-custody/OrdinaryTaskHandoffContract.js';
import type { OrdinaryTaskHandoffService } from '../domains/ball-custody/OrdinaryTaskHandoffService.js';
import type { PreparedArtifactReader } from '../domains/growing/ports/PreparedArtifactReader.js';
/**
 * Task CRUD Routes (毛线球)
 *
 * POST   /api/tasks         → 创建任务 (201)
 * GET    /api/tasks?threadId → 列出线程任务
 * GET    /api/tasks/:id     → 获取单个 / 404
 * PATCH  /api/tasks/:id     → 更新状态/标题/owner
 * DELETE /api/tasks/:id     → 删除 (204)
 */

import type { CatId, CreateTaskInput, TaskItem, UpdateTaskInput } from '@cat-cafe/shared';
import { catIdSchema, entrustedWorkHumanDecisionV1Schema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MAX_BALL_CUSTODY_HTTP_PROBE_TIMEOUT_MS } from '../domains/ball-custody/BallCustodyProbeTaskSpec.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import {
  isEntrustedWorkTerminalActionRequiredError,
  isOrdinaryImplementTask,
} from '../domains/cats/services/stores/ports/TaskStoreContract.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  EntrustedWorkHumanTerminalError,
  type EntrustedWorkHumanTerminalResult,
  type EntrustedWorkHumanTerminalService,
} from '../domains/growing/EntrustedWorkHumanTerminalService.js';
import type { DeploymentWaitLifecycleService } from '../domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { validateUrl } from '../infrastructure/scheduler/content-fetcher.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import {
  resolveDirectLocalAuthorizationUserId,
  resolveSessionUserId,
  resolveStrictUserId,
  resolveUserId,
} from '../utils/request-identity.js';
import { updateOrdinaryTaskAsHuman } from './task-native-human-update.js';

export interface TasksRoutesOptions {
  taskStore: ITaskStore;
  threadStore?: Pick<IThreadStore, 'get'>;
  ordinaryTaskHandoffs?: OrdinaryTaskHandoffService;
  messageStore?: Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey' | 'getById'>;
  socketManager: SocketManager;
  artifactReader?: PreparedArtifactReader;
  deploymentWaitLifecycleHolder?: { current?: DeploymentWaitLifecycleService };
  humanTerminal?: EntrustedWorkHumanTerminalService;
}

type WaitCancelLifecycle = {
  cancel(taskId: string, actor: { readonly kind: 'user'; readonly userId: string }): Promise<unknown>;
};

type CancelWaitSelection =
  | { readonly ok: true; readonly kind: 'plugin' }
  | { readonly ok: true; readonly kind: 'deployment'; readonly lifecycle: WaitCancelLifecycle }
  | { readonly ok: false; readonly status: 403 | 409 | 503; readonly error: string };

function selectCancelableWait(task: TaskItem, userId: string, options: TasksRoutesOptions): CancelWaitSelection {
  if (!task.userId || task.userId !== userId) return { ok: false, status: 403, error: 'Not your wait' };
  if (task.entrustedWork && task.entrustedWork.closure.state !== 'open') {
    return { ok: false, status: 409, error: 'Task has no active wait' };
  }
  if (
    task.kind === 'work' &&
    (task.deploymentWait?.await || task.deploymentWait?.waitOutcome?.delivery === 'pending')
  ) {
    if (task.status === 'done') return { ok: false, status: 409, error: 'Task has no active wait' };
    const lifecycle = options.deploymentWaitLifecycleHolder?.current;
    return lifecycle
      ? { ok: true, kind: 'deployment', lifecycle }
      : { ok: false, status: 503, error: 'Wait lifecycle unavailable' };
  }
  const wait = task.pluginWait;
  return !task.entrustedWork && wait && !wait.invalidated && (wait.await || wait.waitOutcome?.delivery === 'pending')
    ? { ok: true, kind: 'plugin' }
    : { ok: false, status: 409, error: 'Task has no active wait' };
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
    expectedOwnerRevision: z.number().int().nonnegative().optional(),
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

function humanTerminalHttpStatus(error: EntrustedWorkHumanTerminalError): 403 | 404 | 409 | 503 {
  if (error.code === 'HUMAN_TERMINAL_NOT_FOUND') return 404;
  if (error.code === 'HUMAN_TERMINAL_FORBIDDEN') return 403;
  if (error.code === 'HUMAN_TERMINAL_RECEIPT_UNAVAILABLE') return 503;
  return 409;
}

function publishHumanTerminalResult(socketManager: SocketManager, result: EntrustedWorkHumanTerminalResult): void {
  socketManager.broadcastToRoom(`thread:${result.task.threadId}`, 'task_updated', result.task);
  if (!result.receipt.created) return;
  socketManager.emitToUser(result.receipt.receipt.ownerUserId, 'messages_delivered', {
    threadId: result.receipt.message.threadId,
    messageIds: [result.receipt.message.id],
    deliveredAt: result.receipt.message.timestamp,
    messages: [result.receipt.message],
  });
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

    const userId = resolveUserId(request);
    if (!userId) return reply.code(401).send({ error: 'Identity required' });
    const task = await taskStore.create({ ...toCreateInput(result.data), userId });
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

    let before = await taskStore.get(id);
    if (before && isOrdinaryImplementTask(before)) {
      const userId = resolveUserId(request);
      const adopted = userId
        ? await adoptOrdinaryTaskTenant({ task: before, userId, tasks: taskStore, threads: opts.threadStore })
        : null;
      if (!adopted) return reply.code(403).send({ error: 'Task owner identity required' });
      before = adopted;
    }
    // Task aggregate reconciles deployment waits inside the same successful write.
    // A rejected assignment must not terminalize a wait as a preliminary side effect.
    let updated: TaskItem | null;
    try {
      if (before && isOrdinaryImplementTask(before)) {
        const userId = resolveUserId(request);
        if (!userId || userId !== before.userId) return reply.code(403).send({ error: 'Task owner identity required' });
        const mutation = await updateOrdinaryTaskAsHuman({
          task: before,
          userId,
          patch: toUpdateInput(result.data),
          expectedOwnerRevision: result.data.expectedOwnerRevision,
          tasks: taskStore,
          messages: opts.messageStore,
          handoffs: opts.ordinaryTaskHandoffs,
        });
        if (mutation.kind !== 'updated' && mutation.kind !== 'replayed')
          return reply.code(409).send({
            error: 'Task assignment changed',
            reason: mutation.kind === 'refused' ? mutation.reason : 'not_found',
          });
        updated = mutation.task;
      } else updated = await taskStore.update(id, toUpdateInput(result.data));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('TASK_EXECUTION_MUST_STOP'))
        return reply.code(409).send({ error: error.message });
      if (error instanceof OrdinaryTaskHandoffError) return reply.code(409).send({ error: error.code });
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

    await opts.deploymentWaitLifecycleHolder?.current?.recordTaskMutationOutcome(updated);

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
    const current = await taskStore.get(id);
    if (!current) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    const task = structuredClone(current);
    const selection = selectCancelableWait(task, userId, opts);
    if (!selection.ok) {
      reply.status(selection.status);
      return { error: selection.error };
    }
    if (selection.kind === 'plugin') {
      const wait = task.pluginWait!;
      const { await: _active, registration: _registration, ...rest } = wait;
      const updated = await taskStore.replacePluginWait(task.id, {
        expectedStatus: task.status,
        expectedState: wait,
        expectedGeneration: wait.generation,
        state: {
          ...rest,
          invalidated: 'user_cancel',
          waitOutcome: {
            outcomeId: `task:${task.id}:g${wait.generation}:user_cancel`,
            generation: wait.generation,
            ownerFence: { kind: 'containing_task', generation: wait.generation },
            reason: 'user_cancel',
            delivery: 'not_applicable',
          },
        },
      });
      if (!updated) {
        reply.status(409);
        return { error: 'Wait changed before cancellation' };
      }
      socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
      return { status: 'cancelled', result: updated.pluginWait?.waitOutcome };
    }
    const result = await selection.lifecycle.cancel(task.id, { kind: 'user', userId });
    const updated = await taskStore.get(task.id);
    if (updated) socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    return { status: 'cancelled', result };
  });

  // Legacy human endpoint: arbitrary caller-provided closure evidence is no longer authoritative.
  app.post('/api/tasks/:id/entrusted-work/close', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    void request.body;
    reply.status(409);
    return {
      error: 'Human terminal decisions require server-issued evidence; use the human-terminal action',
      code: 'HUMAN_TERMINAL_ROUTE_REQUIRED',
    };
  });

  // Authenticated human terminal action: server stamps evidence, rechecks Task execution, and writes one receipt.
  app.post('/api/tasks/:id/entrusted-work/human-terminal', async (request, reply) => {
    const userId = resolveSessionUserId(request) ?? resolveDirectLocalAuthorizationUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    if (!opts.humanTerminal) {
      reply.status(503);
      return { error: 'Human terminal lifecycle unavailable', code: 'HUMAN_TERMINAL_UNAVAILABLE' };
    }
    const parsed = entrustedWorkHumanDecisionV1Schema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { id } = request.params as { id: string };
    try {
      const result = await opts.humanTerminal.decide({ taskId: id, userId, input: parsed.data });
      publishHumanTerminalResult(socketManager, result);
      return result;
    } catch (error) {
      if (!(error instanceof EntrustedWorkHumanTerminalError)) throw error;
      reply.status(humanTerminalHttpStatus(error));
      return { error: error.message, code: error.code, ...(error.execution ? { execution: error.execution } : {}) };
    }
  });

  // DELETE /api/tasks/:id
  app.delete('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = await taskStore.get(id);
    if (current && isOrdinaryImplementTask(current)) {
      const userId = resolveUserId(request);
      const adopted = userId
        ? await adoptOrdinaryTaskTenant({ task: current, userId, tasks: taskStore, threads: opts.threadStore })
        : null;
      if (!adopted) return reply.code(403).send({ error: 'Task owner identity required' });
    }
    let deleted: boolean;
    try {
      deleted = await taskStore.delete(id);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('TASK_EXECUTION_MUST_STOP'))
        return reply.code(409).send({ error: error.message });
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
