import { randomUUID } from 'node:crypto';
import type { ScheduleMutationAuditEntry } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  cancelDurableManagedGateJob,
  type DurableManagedGateJob,
  validateDurableManagedGateJob,
} from '../domains/ball-custody/durable-managed-gate-job.js';
import {
  type HoldAccessDecision,
  projectHoldOwner,
  resolveHoldAccess,
} from '../domains/ball-custody/hold-ball-access-policy.js';
import { readManagedCommandWakeProjection } from '../domains/ball-custody/managed-command-wake-task-projection.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { DynamicTaskDef, DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import type { TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';
import { cancelManagedWakeIfTaskMatches } from './callback-hold-ball-routes.js';
import {
  findCancelableHoldBallTask,
  findHoldBallTask,
  isCancelableHoldBallTask,
  readHoldLifecycle,
} from './hold-ball-cancel.js';
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
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  ownerUserId: string;
  scheduleMutationAuditStore: {
    deleteTaskWithAudit(taskId: string, audit: ScheduleMutationAuditEntry): boolean;
    setTaskEnabledWithAudit(taskId: string, enabled: boolean, audit: ScheduleMutationAuditEntry): boolean;
    updateTaskParamsAndEnabledWithAudit(
      taskId: string,
      currentParams: Record<string, unknown>,
      nextParams: Record<string, unknown>,
      enabled: boolean,
      audit: ScheduleMutationAuditEntry,
    ): boolean;
  };
  /** Injectable exact-task fence for route tests; defaults to the managed runner registry. */
  cancelManagedWakeIfTaskMatches?: (taskId: string, threadId: string, catId: string) => boolean;
  onHoldBallCancelFeedback?: (input: {
    taskId: string;
    threadId: string;
    userId: string;
    catId: string;
  }) => void | Promise<void>;
}

async function isThreadVisibleToUser(
  deps: HoldBallCancelRouteDeps,
  userId: string,
  threadId: string,
): Promise<boolean> {
  const visible = await deps.threadStore.list(userId);
  return visible.some((thread) => thread.id === threadId);
}

async function authorizeHoldAccess(
  deps: HoldBallCancelRouteDeps,
  request: FastifyRequest,
  task: DynamicTaskDef,
  reply: FastifyReply,
): Promise<{ threadId: string; access: HoldAccessDecision } | null> {
  const threadId = task.deliveryThreadId;
  if (!threadId) {
    reply.status(403);
    return null;
  }
  const thread = await deps.threadStore.get(threadId);
  if (!thread) {
    reply.status(403);
    return null;
  }

  const principal = request.callbackPrincipal;
  const operatorUserId = principal ? null : resolveDirectLocalAuthorizationUserId(request);
  const principalCanAccessThread = principal
    ? principal.kind === 'invocation'
      ? principal.threadId === threadId
      : await isThreadVisibleToUser(deps, principal.userId, threadId)
    : false;
  const operatorCanAccessThread = operatorUserId ? await isThreadVisibleToUser(deps, operatorUserId, threadId) : false;
  const access = resolveHoldAccess({
    task,
    thread,
    ...(principal ? { callbackPrincipal: principal } : {}),
    ...(operatorUserId ? { operatorUserId } : {}),
    configuredOwnerUserId: deps.ownerUserId,
    principalCanAccessThread,
    operatorCanAccessThread,
  });
  if (!access) {
    reply.status(principal || operatorUserId ? 403 : 401);
    return null;
  }
  return { threadId, access };
}

async function authorizeOperatorThreadAccess(
  deps: HoldBallCancelRouteDeps,
  request: FastifyRequest,
  threadId: string,
  reply: FastifyReply,
): Promise<string | null> {
  if (request.callbackPrincipal) {
    reply.status(403);
    return null;
  }
  const operatorUserId = resolveDirectLocalAuthorizationUserId(request);
  if (!operatorUserId) {
    reply.status(401);
    return null;
  }
  if (operatorUserId !== deps.ownerUserId || !(await isThreadVisibleToUser(deps, operatorUserId, threadId))) {
    reply.status(403);
    return null;
  }
  return operatorUserId;
}

function cancelExactManagedRunner(deps: HoldBallCancelRouteDeps, taskId: string, threadId: string, catId: string) {
  const cancel = deps.cancelManagedWakeIfTaskMatches ?? cancelManagedWakeIfTaskMatches;
  cancel(taskId, threadId, catId);
}

function projectLifecycle(lifecycle: ReturnType<typeof readHoldLifecycle>, access: HoldAccessDecision) {
  if (!lifecycle || access.lifecycleVisibility === 'full') return lifecycle;
  return { mode: lifecycle.mode, status: lifecycle.status };
}

function createHoldCancelAudit(
  deps: HoldBallCancelRouteDeps,
  taskId: string,
  threadId: string,
  access: HoldAccessDecision,
): ScheduleMutationAuditEntry {
  return {
    auditId: `hold-cancel-${randomUUID()}`,
    ownerUserId: deps.ownerUserId,
    actorKind: access.actor.kind === 'operator' ? 'cvo' : 'cat',
    actorId: access.actor.id,
    action: 'delete',
    taskId,
    detail: {
      resourceKind: 'hold_ball',
      threadId,
      ownerCatId: access.owner.catId,
      ownerUserId: access.owner.userId,
      accessRole: access.actor.role,
      authKind: access.actor.authKind,
    },
    createdAt: Date.now(),
  };
}

function persistHoldCancellation(
  deps: HoldBallCancelRouteDeps,
  task: DynamicTaskDef,
  audit: ScheduleMutationAuditEntry,
) {
  const durableJob = readManagedCommandWakeProjection(task)?.durableJob;
  if (!durableJob) {
    return { applied: deps.scheduleMutationAuditStore.deleteTaskWithAudit(task.id, audit), durableJob };
  }
  const cancellationRequestedAt = Date.now();
  const nextParams = {
    ...task.params,
    holdLifecycle: {
      ...(task.params.holdLifecycle as Record<string, unknown>),
      status: 'cancel_requested',
      cancellationRequestedAt,
      cancelledBy: `${audit.actorKind}:${audit.actorId}`,
    },
  };
  const pauseAudit: ScheduleMutationAuditEntry = { ...audit, action: 'pause' };
  const applied = deps.scheduleMutationAuditStore.updateTaskParamsAndEnabledWithAudit(
    task.id,
    task.params,
    nextParams,
    false,
    pauseAudit,
  );
  return { applied, durableJob };
}

function cancelDurableGateIfPresent(
  durableJob: DurableManagedGateJob | undefined,
  taskId: string,
  access: HoldAccessDecision,
): ReturnType<typeof cancelDurableManagedGateJob> | null {
  if (!durableJob || !validateDurableManagedGateJob(durableJob, taskId)) return null;
  return cancelDurableManagedGateJob(durableJob, {
    cancelledBy: `${access.actor.kind}:${access.actor.id}:${access.actor.userId}`,
    reason: 'explicit_hold_cancel',
  });
}

type DurableHoldCancellationState = 'ordinary_cancelled' | 'durable_pending' | 'durable_cancelled' | 'durable_conflict';

function resolveDurableHoldCancellationState(
  durableJob: DurableManagedGateJob | undefined,
  outcome: ReturnType<typeof cancelDurableManagedGateJob> | null,
): DurableHoldCancellationState {
  if (!durableJob) return 'ordinary_cancelled';
  if (outcome?.state === 'pending') return 'durable_pending';
  if (outcome?.state === 'cancelled') return 'durable_cancelled';
  return 'durable_conflict';
}

function cancellationVisibilityMessage(catId: string, state: DurableHoldCancellationState): string {
  if (state === 'ordinary_cancelled') return `🏓 ${catId} 持球已取消`;
  if (state === 'durable_pending') return `🏓 ${catId} 持球取消已受理，等待 durable gate 终止`;
  if (state === 'durable_cancelled') return `🏓 ${catId} 持球已取消`;
  return `🏓 ${catId} 持球取消尚未受理，请重试或检查 durable gate 身份`;
}

export function registerHoldBallCancelRoutes(app: FastifyInstance, deps: HoldBallCancelRouteDeps): void {
  const { dynamicTaskStore, taskRunner, messageStore, socketManager } = deps;

  app.get<{ Params: { taskId: string } }>('/api/callbacks/hold-ball/:taskId/status', async (request, reply) => {
    const { taskId } = request.params;
    const task = findHoldBallTask(taskId, dynamicTaskStore);
    if (!task) {
      reply.status(404);
      return { error: 'Hold task not found or not a hold-ball task' };
    }

    const authorization = await authorizeHoldAccess(deps, request, task, reply);
    if (!authorization) {
      return { error: 'Not authorized to read holds in this thread' };
    }

    const lifecycle = readHoldLifecycle(task);
    const status = lifecycle?.status ?? (task.enabled ? 'active' : 'inactive');
    const catId = task.createdBy?.replace('hold-ball:', '') ?? 'unknown';
    return {
      taskId,
      status,
      cancelable: isCancelableHoldBallTask(task),
      catId,
      lifecycle: projectLifecycle(lifecycle, authorization.access),
      owner: projectHoldOwner(authorization.access.owner, authorization.access.lifecycleVisibility),
      access: {
        role: authorization.access.actor.role,
        canCancel: isCancelableHoldBallTask(task),
        lifecycleVisibility: authorization.access.lifecycleVisibility,
      },
    };
  });

  app.delete<{ Params: { taskId: string }; Querystring: { withFeedback?: string } }>(
    '/api/callbacks/hold-ball/:taskId',
    async (request, reply) => {
      const { taskId } = request.params;
      const withFeedback = request.query.withFeedback === '1' || request.query.withFeedback === 'true';
      const task = findCancelableHoldBallTask(taskId, dynamicTaskStore);
      if (!task) {
        reply.status(404);
        return { error: 'Hold task not found or not a hold-ball task' };
      }

      const authorization = await authorizeHoldAccess(deps, request, task, reply);
      if (!authorization) {
        return { error: 'Not authorized to cancel holds in this thread' };
      }

      const { threadId, access } = authorization;
      const audit = createHoldCancelAudit(deps, taskId, threadId, access);
      const mutation = persistHoldCancellation(deps, task, audit);
      if (!mutation.applied) {
        reply.status(409);
        return { error: 'Hold task was replaced or already completed', code: 'HOLD_TASK_REPLACED' };
      }
      taskRunner.unregister(taskId);
      const catId = access.owner.catId;
      // F295: the deleted task may already have been replaced in the same thread+cat slot.
      // Fence by taskId so a stale bubble cannot terminate the replacement command.
      cancelExactManagedRunner(deps, taskId, threadId, catId);
      const durableCancellation = cancelDurableGateIfPresent(mutation.durableJob, taskId, access);
      const durableDescriptorInvalid = Boolean(mutation.durableJob && !durableCancellation);
      const cancellationState = resolveDurableHoldCancellationState(mutation.durableJob, durableCancellation);
      const isDurableCancellation = cancellationState !== 'ordinary_cancelled';
      const durableCancelled = cancellationState === 'durable_cancelled';
      const durableConflict = cancellationState === 'durable_conflict';
      log.info(
        { taskId, threadId, ownerCatId: catId, actor: access.actor, durableCancellation, durableDescriptorInvalid },
        durableConflict
          ? 'F261: durable hold cancellation could not be admitted'
          : isDurableCancellation
            ? 'F261: durable hold cancellation requested by authorized actor'
            : 'F167: hold_ball cancelled by authorized actor',
      );

      if (withFeedback && deps.onHoldBallCancelFeedback) {
        try {
          await deps.onHoldBallCancelFeedback({ taskId, threadId, userId: access.actor.userId, catId });
        } catch (err) {
          log.warn({ taskId, threadId, err }, 'F222 UX-3: failed to trigger hold_ball cancel feedback');
        }
      }

      try {
        const cancelMessage = cancellationVisibilityMessage(catId, cancellationState);
        const stored = await messageStore.append({
          from: { kind: 'system', service: 'hold-ball' },
          userId: 'system',
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

      if (durableConflict) reply.status(409);
      else if (durableCancellation && !durableCancelled) reply.status(202);
      return {
        status: durableConflict ? 'conflict' : durableCancellation && !durableCancelled ? 'pending' : 'ok',
        cancelled: isDurableCancellation ? durableCancelled : true,
        ...(isDurableCancellation && !durableConflict ? { cancellationRequested: true } : {}),
        taskId,
        owner: projectHoldOwner(access.owner, access.lifecycleVisibility),
        actor: { kind: access.actor.kind, id: access.actor.id, role: access.actor.role },
      };
    },
  );

  app.post('/api/callbacks/hold-ball/feedback', async (request, reply) => {
    const parsed = holdBallFeedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { threadId, taskId, catId } = parsed.data;
    const userId = await authorizeOperatorThreadAccess(deps, request, threadId, reply);
    if (!userId) {
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
