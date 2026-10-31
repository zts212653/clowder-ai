import { randomUUID } from 'node:crypto';
import { normalizeThreadGoalObjective } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentRegistry } from '../domains/cats/services/agents/registry/AgentRegistry.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type {
  IThreadStore,
  Thread,
  ThreadGoalStateV1,
  ThreadGoalStatus,
} from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { resolveStrictUserId } from '../utils/request-identity.js';
import { type NativeSessionTarget, resolveNativeSessionTarget } from './native-session-target.js';
import { listNativeTargetChoices, nativeSelectionRequired } from './native-target-selection.js';
import {
  appendGoalEvent,
  type GoalSyncResult,
  isClearedFence,
  syncedClearFence,
  syncedGoal,
  visibleGoal,
} from './native-thread-goal-projection.js';
import { writeGoalIntent } from './native-thread-goal-state.js';
import { applyRefreshedGoal, applySyncedGoal, markUnavailable, nativeGoalRequest } from './native-thread-goal-sync.js';

interface NativeThreadGoalRouteOptions extends FastifyPluginOptions {
  readonly agentRegistry: AgentRegistry;
  readonly messageStore: IMessageStore;
  readonly sessionChainStore: ISessionChainStore;
  readonly threadStore: IThreadStore;
  readonly isSessionBusy?: (threadId: string, catId: string, userId: string) => boolean;
  readonly publishMessage?: (threadId: string, message: StoredMessage) => void;
}

interface GoalParams {
  Params: { threadId: string };
}

interface GoalMutationRequest extends GoalParams {
  Body: { catId?: string; objective?: string; status?: ThreadGoalStatus; tokenBudget?: number | null };
}

interface GoalReconcileRequest extends GoalParams {
  Body: { catId?: string; mode?: 'retry' | 'refresh' };
}

interface GoalAccess {
  readonly thread: Thread;
  readonly userId: string;
}

const GOAL_STATUSES = new Set<ThreadGoalStatus>([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
]);

export async function nativeThreadGoalRoutes(
  app: FastifyInstance,
  options: NativeThreadGoalRouteOptions,
): Promise<void> {
  app.get<GoalParams>('/api/threads/:threadId/goal', async (request, reply) => {
    const access = await resolveGoalAccess(request, reply, options);
    if (!access) return;
    return reply.send({
      goal: visibleGoal(access.thread.goal),
      nativeTargets: await listNativeTargetChoices({
        agentRegistry: options.agentRegistry,
        sessionChainStore: options.sessionChainStore,
        threadId: access.thread.id,
        userId: access.userId,
        capability: 'requestNativeGoal',
      }),
    });
  });

  app.put<GoalMutationRequest>('/api/threads/:threadId/goal', async (request, reply) => {
    const access = await resolveGoalAccess(request, reply, options);
    if (!access) return;
    if (await rejectAmbiguousGoalTarget(options, access, request.body?.catId, reply)) return;
    const objective = normalizeThreadGoalObjective(request.body?.objective);
    const status = request.body?.status;
    const tokenBudget = request.body?.tokenBudget;
    if (
      !objective ||
      !status ||
      !GOAL_STATUSES.has(status) ||
      (tokenBudget != null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0))
    ) {
      return reply.status(400).send({ error: 'Invalid goal' });
    }
    const goal = await writeGoalIntent(options.threadStore, access.thread.id, {
      intent: 'set',
      objective,
      status,
      tokenBudget: tokenBudget ?? null,
      syncState: 'syncing',
      catId: request.body?.catId,
    });
    if (!goal) return reply.status(409).send({ error: 'Goal changed concurrently', code: 'GOAL_CONFLICT' });
    return sendSyncResult(reply, options, access, await syncGoal(options, access, goal, app.log, request.body?.catId));
  });

  app.delete<GoalMutationRequest>('/api/threads/:threadId/goal', async (request, reply) => {
    const access = await resolveGoalAccess(request, reply, options);
    if (!access) return;
    if (await rejectAmbiguousGoalTarget(options, access, request.body?.catId, reply)) return;
    const goal = await writeGoalIntent(options.threadStore, access.thread.id, {
      intent: 'clear',
      syncState: 'clearing',
      catId: request.body?.catId,
    });
    if (!goal) return reply.status(409).send({ error: 'Goal changed concurrently', code: 'GOAL_CONFLICT' });
    return sendSyncResult(reply, options, access, await syncGoal(options, access, goal, app.log, request.body?.catId));
  });

  app.post<GoalReconcileRequest>('/api/threads/:threadId/goal/reconcile', async (request, reply) => {
    const access = await resolveGoalAccess(request, reply, options);
    if (!access) return;
    if (await rejectAmbiguousGoalTarget(options, access, request.body?.catId, reply)) return;
    const mode = request.body?.mode ?? 'retry';
    if (mode === 'refresh') {
      return sendSyncResult(reply, options, access, await refreshGoal(options, access, app.log, request.body?.catId));
    }
    if (!access.thread.goal || isClearedFence(access.thread.goal)) {
      return reply.send({ goal: null, native: { state: 'not_requested' } });
    }
    return sendSyncResult(
      reply,
      options,
      access,
      await syncGoal(options, access, access.thread.goal, app.log, request.body?.catId),
    );
  });
}

async function resolveGoalAccess(
  request: FastifyRequest<GoalParams>,
  reply: FastifyReply,
  options: NativeThreadGoalRouteOptions,
): Promise<GoalAccess | null> {
  const userId = resolveStrictUserId(request);
  if (!userId) return reply.status(401).send({ error: 'Identity required' });
  const thread = await options.threadStore.get(request.params.threadId);
  if (!thread) return reply.status(404).send({ error: 'Thread not found' });
  if (!canAccessThread(thread, userId)) return reply.status(403).send({ error: 'Access denied' });
  return { thread, userId };
}

async function syncGoal(
  options: NativeThreadGoalRouteOptions,
  access: GoalAccess,
  goal: ThreadGoalStateV1,
  logger: Pick<FastifyInstance['log'], 'warn'>,
  requestedCatId?: string,
): Promise<GoalSyncResult> {
  const target = await resolveGoalTarget(options, access, requestedCatId);
  if (!target) return markUnavailable(options.threadStore, access.thread.id, goal, 'native_session_unavailable');
  if (options.isSessionBusy?.(access.thread.id, target.catId, access.userId)) {
    return markUnavailable(options.threadStore, access.thread.id, goal, 'native_session_busy');
  }
  try {
    const result = await target.service.requestNativeGoal?.(nativeGoalRequest(target, goal));
    if (!result) return markUnavailable(options.threadStore, access.thread.id, goal, 'native_goal_unsupported');
    const nextGoal =
      goal.intent === 'clear' ? syncedClearFence(goal, target, Date.now()) : syncedGoal(goal, target, result);
    return applySyncedGoal(options.threadStore, access.thread.id, goal.revision, nextGoal, target.catId);
  } catch (error) {
    logger.warn({ err: error, threadId: access.thread.id }, 'F306 native goal sync failed');
    return markUnavailable(options.threadStore, access.thread.id, goal, 'provider_sync_failed');
  }
}

async function refreshGoal(
  options: NativeThreadGoalRouteOptions,
  access: GoalAccess,
  logger: Pick<FastifyInstance['log'], 'warn'>,
  requestedCatId?: string,
): Promise<GoalSyncResult> {
  if (access.thread.goal && isClearedFence(access.thread.goal)) {
    return { goal: access.thread.goal, synced: true };
  }
  const target = await resolveGoalTarget(options, access, requestedCatId);
  if (!target || options.isSessionBusy?.(access.thread.id, target.catId, access.userId)) {
    if (!access.thread.goal) return { goal: null, synced: false };
    return markUnavailable(options.threadStore, access.thread.id, access.thread.goal, 'native_session_unavailable');
  }
  try {
    const result = await target.service.requestNativeGoal?.({
      sessionId: target.sessionId,
      invocationId: `native-goal-refresh-${randomUUID()}`,
      timeoutMs: 30_000,
      request: { action: 'get' },
    });
    return applyRefreshedGoal(options.threadStore, access.thread.id, target, result?.goal ?? null);
  } catch (error) {
    logger.warn({ err: error, threadId: access.thread.id }, 'F306 native goal refresh failed');
    if (!access.thread.goal) return { goal: null, synced: false };
    return markUnavailable(options.threadStore, access.thread.id, access.thread.goal, 'provider_refresh_failed');
  }
}

async function resolveGoalTarget(
  options: NativeThreadGoalRouteOptions,
  access: GoalAccess,
  requestedCatId?: string,
): Promise<NativeSessionTarget | null> {
  return resolveNativeSessionTarget({
    agentRegistry: options.agentRegistry,
    sessionChainStore: options.sessionChainStore,
    threadId: access.thread.id,
    userId: access.userId,
    ...(requestedCatId ? { requestedCatId } : {}),
    capability: 'requestNativeGoal',
  });
}

async function rejectAmbiguousGoalTarget(
  options: NativeThreadGoalRouteOptions,
  access: GoalAccess,
  requestedCatId: string | undefined,
  reply: FastifyReply,
): Promise<boolean> {
  const nativeTargets = await nativeSelectionRequired({
    agentRegistry: options.agentRegistry,
    sessionChainStore: options.sessionChainStore,
    threadId: access.thread.id,
    userId: access.userId,
    capability: 'requestNativeGoal',
    ...(requestedCatId ? { requestedCatId } : {}),
  });
  if (!nativeTargets) return false;
  reply.status(409).send({
    error: 'Select a native session',
    code: 'NATIVE_SESSION_SELECTION_REQUIRED',
    nativeTargets,
  });
  return true;
}

async function sendSyncResult(
  reply: FastifyReply,
  options: NativeThreadGoalRouteOptions,
  access: GoalAccess,
  result: GoalSyncResult,
): Promise<unknown> {
  if (result.event && result.catId) {
    await appendGoalEvent(options, { threadId: access.thread.id, userId: access.userId }, result.catId, result.event);
  }
  return reply.status(result.synced ? 200 : 202).send({
    goal: visibleGoal(result.goal),
    native: { state: result.synced ? 'synced' : 'unavailable' },
  });
}
