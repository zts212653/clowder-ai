import type { ActiveExecutionListResponse, ActiveExecutionProjection } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  parseManagedCommandWakeTask,
  readManagedCommandWakeProjection,
} from '../domains/ball-custody/managed-command-wake-lifecycle.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { DynamicTaskDef } from '../infrastructure/scheduler/DynamicTaskStore.js';
import { resolveUserId } from '../utils/request-identity.js';
import { isRetiredWakeWithRunningManagedCommand } from './hold-ball-cancel.js';

export interface LiveExecutionCandidate {
  readonly catId: string;
  readonly startedAt: number;
  readonly executionId?: string;
}

interface ActiveExecutionTracker {
  getUserId(threadId: string, catId: string): string | null;
  getExecutionId?(threadId: string, catId: string): string | undefined;
}

export interface ActiveExecutionRouteDeps {
  readonly threadStore: IThreadStore;
  readonly invocationTracker: ActiveExecutionTracker;
  readonly dynamicTaskStore?: Pick<{ getAll(): DynamicTaskDef[] }, 'getAll'>;
  readonly resolveLiveExecutions: (
    threadId: string,
    userId: string,
    request: FastifyRequest,
  ) => Promise<LiveExecutionCandidate[]>;
  readonly cancelExactLiveInvocation: (input: {
    threadId: string;
    userId: string;
    catId: string;
    executionId: string;
    request: FastifyRequest;
  }) => { cancelled: boolean };
}

const cancelLiveBodySchema = z.object({ catId: z.string().min(1).max(100) }).strict();

function canAccessThread(thread: Thread, userId: string): boolean {
  return thread.createdBy === 'system' || thread.createdBy === userId;
}

function unresolvedExecutionId(threadId: string, candidate: LiveExecutionCandidate): string {
  return `unresolved:${threadId}:${candidate.catId}:${candidate.startedAt}`;
}

function projectLiveExecution(
  thread: Thread,
  userId: string,
  candidate: LiveExecutionCandidate,
  tracker: ActiveExecutionTracker,
): ActiveExecutionProjection {
  const trackerExecutionId =
    tracker.getUserId(thread.id, candidate.catId) === userId
      ? tracker.getExecutionId?.(thread.id, candidate.catId)
      : undefined;
  const executionId = candidate.executionId ?? unresolvedExecutionId(thread.id, candidate);
  return {
    executionId,
    threadId: thread.id,
    threadTitle: thread.title,
    catId: candidate.catId,
    kind: 'live_invocation',
    startedAt: candidate.startedAt,
    cancelability:
      trackerExecutionId === executionId
        ? {
            state: 'cancelable',
            target: {
              kind: 'live_invocation',
              threadId: thread.id,
              catId: candidate.catId,
              executionId,
            },
          }
        : { state: 'not_cancelable', reason: 'control_plane_unavailable' },
  };
}

function sortExecutions(executions: ActiveExecutionProjection[]): ActiveExecutionProjection[] {
  return executions.sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      left.threadId.localeCompare(right.threadId) ||
      left.executionId.localeCompare(right.executionId),
  );
}

function projectManagedCommandExecution(
  task: DynamicTaskDef,
  userId: string,
  threadById: ReadonlyMap<string, Thread>,
): ActiveExecutionProjection | null {
  const active = parseManagedCommandWakeTask(task);
  const command = active?.command ?? readManagedCommandWakeProjection(task);
  const threadId = active?.threadId ?? task.deliveryThreadId;
  const catId = active?.catId ?? task.createdBy.replace(/^hold-ball:/, '');
  const triggerUserId = active?.userId ?? task.params.triggerUserId;
  if (
    !command ||
    command.state !== 'command_running' ||
    !threadId ||
    typeof triggerUserId !== 'string' ||
    triggerUserId !== userId ||
    !catId ||
    (!active && !isRetiredWakeWithRunningManagedCommand(task))
  ) {
    return null;
  }
  const thread = threadById.get(threadId);
  if (!thread) return null;
  return {
    executionId: task.id,
    threadId: thread.id,
    threadTitle: thread.title,
    catId,
    kind: 'managed_command',
    startedAt: command.startedAt,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'managed_command', taskId: task.id },
    },
  };
}

async function requireAccessibleThread(
  request: FastifyRequest<{ Params: { threadId: string } }>,
  reply: FastifyReply,
  threadStore: IThreadStore,
  forbiddenError: string,
): Promise<{ userId: string; thread: Thread } | null> {
  const userId = resolveUserId(request);
  if (!userId) {
    reply.status(401).send({ error: 'Identity required', code: 'AUTH_REQUIRED' });
    return null;
  }
  const thread = await threadStore.get(request.params.threadId);
  if (!thread) {
    reply.status(404).send({ error: '对话不存在', code: 'THREAD_NOT_FOUND' });
    return null;
  }
  if (!canAccessThread(thread, userId)) {
    reply.status(403).send({ error: forbiddenError, code: 'FORBIDDEN' });
    return null;
  }
  return { userId, thread };
}

async function buildActiveExecutionList(
  currentThread: Thread,
  userId: string,
  request: FastifyRequest,
  deps: ActiveExecutionRouteDeps,
): Promise<ActiveExecutionListResponse> {
  const threads = (await deps.threadStore.listByProject(userId, currentThread.projectPath)).filter((thread) =>
    canAccessThread(thread, userId),
  );
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const liveGroups = await Promise.all(
    threads.map(async (thread) => ({
      thread,
      candidates: await deps.resolveLiveExecutions(thread.id, userId, request),
    })),
  );
  const executions = liveGroups.flatMap(({ thread, candidates }) =>
    candidates.map((candidate) => projectLiveExecution(thread, userId, candidate, deps.invocationTracker)),
  );

  for (const task of deps.dynamicTaskStore?.getAll() ?? []) {
    const managedExecution = projectManagedCommandExecution(task, userId, threadById);
    if (managedExecution) executions.push(managedExecution);
  }
  return { projectPath: currentThread.projectPath, executions: sortExecutions(executions) };
}

export function registerActiveExecutionRoutes(app: FastifyInstance, deps: ActiveExecutionRouteDeps): void {
  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/executions/active', async (request, reply) => {
    const access = await requireAccessibleThread(request, reply, deps.threadStore, '无权查看此项目的运行状态');
    if (!access) return;
    return buildActiveExecutionList(access.thread, access.userId, request, deps);
  });

  app.post<{
    Params: { threadId: string; executionId: string };
    Body: { catId: string };
  }>('/api/threads/:threadId/executions/live/:executionId/cancel', async (request, reply) => {
    const access = await requireAccessibleThread(request, reply, deps.threadStore, '无权取消此执行');
    if (!access) return;
    const parsed = cancelLiveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', code: 'INVALID_REQUEST' };
    }

    const { threadId, executionId } = request.params;
    const { catId } = parsed.data;
    const trackerExecutionId =
      deps.invocationTracker.getUserId(threadId, catId) === access.userId
        ? deps.invocationTracker.getExecutionId?.(threadId, catId)
        : undefined;
    if (trackerExecutionId !== executionId) {
      reply.status(409);
      return {
        error: trackerExecutionId ? '该执行已被更新的回合替代' : '该执行已结束或无法取消',
        code: trackerExecutionId ? 'EXECUTION_REPLACED' : 'EXECUTION_NOT_ACTIVE',
      };
    }

    return {
      ok: true,
      ...deps.cancelExactLiveInvocation({ threadId, userId: access.userId, catId, executionId, request }),
    };
  });
}
