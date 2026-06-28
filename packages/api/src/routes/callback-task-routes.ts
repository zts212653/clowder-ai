/**
 * Callback task routes — MCP post_message 回传的任务更新端点
 */

import type { CatId } from '@cat-cafe/shared';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { recordAnchorDrillEvent, recordAnchorPreviewEvent } from './anchor-event-log.js';
import { recordAnchorFullDrill, recordAnchorReturned } from './anchor-telemetry.js';
import { anchorTaskWhy } from './callback-anchor-helpers.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { deriveCallbackActor, resolveScopedThreadId } from './callback-scope-helpers.js';

// F193-E1: shared refine — single source for status-dependent dispatch gate validation.
// dispatched → require both dispatchedThreadId AND dispatchedMessageId (trace IDs).
// not_dispatched → require non-empty reason.
// missing → only system-set (MCP handler), not cat-fillable via MCP schemas.
// Exported for testing — real tests import this, not a copy.
export function refineDispatchGate(gate: {
  status: string;
  dispatchedThreadId?: string;
  dispatchedMessageId?: string;
  reason?: string;
}): boolean {
  if (gate.status === 'dispatched') return !!gate.dispatchedThreadId && !!gate.dispatchedMessageId;
  if (gate.status === 'not_dispatched') return !!gate.reason;
  return true;
}
const REFINE_MSG = 'dispatched requires dispatchedThreadId AND dispatchedMessageId; not_dispatched requires reason.';

const updateDispatchGateSchema = z
  .object({
    status: z.enum(['dispatched', 'not_dispatched']),
    dispatchedThreadId: z.string().optional(),
    dispatchedMessageId: z.string().optional(),
    reason: z.string().optional(),
    decidedAt: z.number().optional(),
  })
  .refine(refineDispatchGate, { message: REFINE_MSG })
  .optional();

/** @internal Exported for contract testing only — not part of public API */
export const updateTaskSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  why: z.string().max(1000).optional(),
  // F193-E1 P1-4: allow patching dispatchGate
  dispatchGate: updateDispatchGateSchema,
});

const suggestedCrossPostSchema = z
  .object({
    type: z.literal('cross_post'),
    threadId: z.string().optional(),
    featureId: z.string().optional(),
    ownerCatId: z.string().optional(),
    targetCats: z.array(z.string()).optional(),
    reason: z.string().optional(),
    source: z.enum(['dispatch_gate', 'search_evidence', 'list_recent', 'feat_index']),
  })
  .optional();

// API create accepts 'missing' (system-set by MCP handler) + dispatched/not_dispatched (cat-set).
// Same refine applies to dispatched/not_dispatched; 'missing' passes through (no trace IDs needed).
const dispatchGateSchema = z
  .object({
    status: z.enum(['missing', 'dispatched', 'not_dispatched']),
    dispatchedThreadId: z.string().optional(),
    dispatchedMessageId: z.string().optional(),
    reason: z.string().optional(),
    suggestedAction: suggestedCrossPostSchema,
    decidedAt: z.number().optional(),
  })
  .refine(refineDispatchGate, { message: REFINE_MSG })
  .optional();

/** @internal Exported for contract testing only — not part of public API */
export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  why: z.string().max(1000).optional().default(''),
  ownerCatId: z.string().min(1).optional(),
  // F193 Phase E (dispatch gate)
  relatedFeatureId: z
    .string()
    .regex(/^F\d+$/)
    .optional(),
  detectedFeatureIds: z.array(z.string()).optional(),
  dispatchGate: dispatchGateSchema,
});

const listTasksQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  catId: z.string().min(1).optional(),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  kind: z.enum(['work', 'pr_tracking']).optional(),
  // F236 AC-A4: why-drill channel — when taskId is given, that task's full (untruncated) why
  // is returned (one-hop drill from the anchored list), staying within the user's thread scope.
  taskId: z.string().min(1).optional(),
});

export function registerCallbackTaskRoutes(
  app: FastifyInstance,
  deps: {
    taskStore: ITaskStore;
    socketManager: SocketManager;
    threadStore?: IThreadStore;
  },
): void {
  const { taskStore, socketManager, threadStore } = deps;

  app.post('/api/callbacks/update-task', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { taskId, status, why, dispatchGate } = parsed.data;

    const existing = await taskStore.get(taskId);
    if (!existing) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    if (existing.threadId !== actor.threadId) {
      reply.status(403);
      return { error: 'Task belongs to a different thread' };
    }
    if (existing.ownerCatId && existing.ownerCatId !== actor.catId) {
      reply.status(403);
      return { error: 'Task is owned by another cat' };
    }

    const updateData: Record<string, unknown> = {};
    if (status) updateData.status = status;
    if (why) updateData.why = why;
    // F193-E1 P1-4: allow patching dispatchGate on existing tasks
    if (dispatchGate) updateData.dispatchGate = dispatchGate;

    const updated = await taskStore.update(taskId, updateData);
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to update task' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    return { status: 'ok', task: updated };
  });

  // F160: create-task — kind forced to 'work' (KD-4)
  app.post('/api/callbacks/create-task', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { title, why, ownerCatId, relatedFeatureId, detectedFeatureIds, dispatchGate } = parsed.data;

    // F182 AC-C2: B class — validate ownerCatId is available (contract 400 on disabled)
    let resolvedOwnerCatId: CatId | null = null;
    if (ownerCatId) {
      const resolved = resolveCatTarget(ownerCatId);
      if ('error' in resolved) {
        reply.status(400);
        return resolved.error;
      }
      resolvedOwnerCatId = createCatId(resolved.ok);
    }

    const task = await taskStore.create({
      threadId: actor.threadId,
      title,
      why: why ?? '',
      createdBy: actor.catId,
      kind: 'work',
      subjectKey: null,
      ownerCatId: resolvedOwnerCatId,
      userId: actor.userId,
      // F193 Phase E (dispatch gate) — pass through to store
      ...(relatedFeatureId ? { relatedFeatureId } : {}),
      ...(detectedFeatureIds?.length ? { detectedFeatureIds } : {}),
      ...(dispatchGate ? { dispatchGate } : {}),
    });

    socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_created', task);
    reply.status(201);
    return { status: 'ok', task };
  });

  app.get('/api/callbacks/list-tasks', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = listTasksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }

    const { threadId, catId, status, kind, taskId } = parsed.data;

    if (catId && !catRegistry.has(catId)) {
      reply.status(400);
      return { error: `Unknown catId: ${catId}` };
    }

    let scopedThreadIds: string[] = [];
    if (threadId) {
      const scoped = await resolveScopedThreadId(actor, threadId, {
        threadStore,
        threadStoreMissingError: 'Thread store not configured for cross-thread task query',
        accessDeniedError: 'Thread access denied',
      });
      if (!scoped.ok) {
        reply.status(scoped.statusCode);
        return { error: scoped.error };
      }
      scopedThreadIds = [scoped.threadId];
    } else if (threadStore) {
      const userThreads = await threadStore.list(actor.userId);
      scopedThreadIds = userThreads.map((item) => item.id);
    } else {
      app.log.warn(
        { userId: actor.userId, invocationId: actor.invocationId },
        '[callbacks/list-tasks] threadStore unavailable, falling back to current thread only',
      );
      scopedThreadIds = [actor.threadId];
    }

    const perThreadTasks = await Promise.all(scopedThreadIds.map((id) => taskStore.listByThread(id)));
    let tasks = perThreadTasks.flat();
    if (catId) tasks = tasks.filter((item) => item.ownerCatId === catId);
    if (status) tasks = tasks.filter((item) => item.status === status);
    if (kind) tasks = tasks.filter((item) => item.kind === kind);
    if (taskId) tasks = tasks.filter((item) => item.id === taskId);
    tasks.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id));

    // F236 AC-A4: anchor the why field (head preview + whyLength + whyTruncated + drillDown).
    // A taskId drill returns that task's why in full.
    const isTaskDrill = Boolean(taskId);
    const payload = { tasks: tasks.map((task) => anchorTaskWhy(task, { full: isTaskDrill })) };
    // F236 AC-A1 (R1/砚砚 P1): emit returnedChars for eval-layer payload-shrink accounting.
    const listTasksChars = JSON.stringify(payload).length;
    app.log.info(
      {
        tool: 'list-tasks',
        returnedChars: listTasksChars,
        count: payload.tasks.length,
        userId: actor.userId,
      },
      '[F236] anchor returned',
    );
    // F236 Track-1: also emit as OTel metrics (chars + request/response volume substrate).
    // A taskId query returns the task's FULL why = a drill-volume response, NOT a
    // preview-volume response. Record it as drill volume (gpt52 review P1) so the
    // per-tool request/response volume accounting stays honest — otherwise list-tasks
    // full drills are indistinguishable from previews and the tool's volume signal is
    // systematically distorted. (This is volume categorization; open-rate is Track-2.)
    if (isTaskDrill) {
      // Only count drill volume when a task was actually served. A taskId that survives
      // no filter (stale drill pointer / taskId + mismatching filter) serves no `why`,
      // so counting it would over-count drill volume (cloud Codex review P2).
      if (payload.tasks.length > 0) {
        recordAnchorFullDrill({ tool: 'list-tasks', fullDrillChars: listTasksChars });
        // F236 Track-2: per-event drill record with correlation key for drill↔preview join.
        recordAnchorDrillEvent({ tool: 'list-tasks', itemId: taskId!, fullDrillChars: listTasksChars });
      }
    } else {
      recordAnchorReturned({ tool: 'list-tasks', returnedChars: listTasksChars });
      // F236 Track-2: per-event preview record with correlation keys for drill↔preview open-rate.
      // Both sides use content-only measurement (cloud R4 P1: JSON metadata skew fix).
      recordAnchorPreviewEvent({
        tool: 'list-tasks',
        itemIds: tasks.map((t) => t.id),
        returnedChars: payload.tasks.reduce((sum, t) => sum + (t.why?.length ?? 0), 0),
        originalChars: tasks.reduce((sum, t) => sum + (t.why?.length ?? 0), 0),
      });
    }
    return payload;
  });
}
