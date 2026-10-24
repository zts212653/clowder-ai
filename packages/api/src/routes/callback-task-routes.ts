/**
 * Callback task routes — MCP post_message 回传的任务更新端点
 */

import type { CatId, EntrustedWorkTerminalClosureV1, TaskItem } from '@cat-cafe/shared';
import {
  catRegistry,
  createCatId,
  custodyAdmissionRequestV1Schema,
  entrustedWorkClosureSpecV1Schema,
  entrustedWorkTerminalActionV1Schema,
  entrustedWorkUpdateActionV1Schema,
  entrustedWorkV1Schema,
  taskFeatureIdSchema,
} from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OwnedWaitStatusReader } from '../domains/ball-custody/OwnedWaitStatus.js';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { queryTaskItems } from '../domains/cats/services/stores/ports/TaskQuery.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { isEntrustedWorkTerminalActionRequiredError } from '../domains/cats/services/stores/ports/TaskStoreContract.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { DevelopmentScopeDocuments } from '../domains/growing/DevelopmentScopeResolver.js';
import {
  EntrustedWorkLifecycleError,
  EntrustedWorkLifecycleService,
} from '../domains/growing/EntrustedWorkLifecycleService.js';
import { F232PreparedArtifactReader } from '../domains/growing/F232PreparedArtifactReader.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { recordAnchorDrillEvent, recordAnchorPreviewEvent } from './anchor-event-log.js';
import { recordAnchorFullDrill, recordAnchorReturned } from './anchor-telemetry.js';
import { anchorTaskWhy } from './callback-anchor-helpers.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { registerCallbackDevelopmentWorkRoutes } from './callback-development-work-routes.js';
import { deriveCallbackActor, getDeletedCallbackThreadGuard, resolveScopedThreadId } from './callback-scope-helpers.js';
import { reconcileOwnedTaskWaits } from './callback-task-reconciliation.js';
import { admissionSourceContext, assertDirectAdmissionSourceCustody } from './entrusted-work-source-custody.js';
import { type LiveTaskAuthority, withLiveTaskAuthority } from './live-task-authority.js';

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

/** @internal Exported for API/MCP parity contract tests. */
export const admitEntrustedWorkSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    why: z.string().max(1000).default(''),
    admission: custodyAdmissionRequestV1Schema,
    closure: entrustedWorkClosureSpecV1Schema.optional(),
    time: entrustedWorkV1Schema.shape.time.optional(),
    artifactRefs: z.array(z.string().trim().min(1).max(1000)).max(64).optional(),
  })
  .strict();

/** @internal Exported for API/MCP parity contract tests. */
export const closeEntrustedWorkSchema = z
  .object({
    taskId: z.string().min(1),
    ...entrustedWorkTerminalActionV1Schema.shape,
  })
  .strict();

/** @internal Exported for API/MCP parity contract tests. */
export const updateEntrustedWorkSchema = entrustedWorkUpdateActionV1Schema;

const listTasksQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  catId: z.string().min(1).optional(),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  kind: z.enum(['work', 'pr_tracking']).optional(),
  featureId: taskFeatureIdSchema.optional(),
  // F236 AC-A4: why-drill channel — when taskId is given, that task's full (untruncated) why
  // is returned (one-hop drill from the anchored list), staying within the user's thread scope.
  taskId: z.string().min(1).optional(),
});

function carriesHumanTerminalEvidence(closure: EntrustedWorkTerminalClosureV1): boolean {
  return (
    (closure.state === 'satisfied' && closure.confirmation !== undefined) ||
    (closure.state !== 'satisfied' && closure.disposition.actorKind === 'human')
  );
}

type CatTerminalAccessResult =
  | { readonly ok: true; readonly task: TaskItem }
  | { readonly ok: false; readonly statusCode: 403 | 404; readonly body: { error: string; code?: string } };

function validateCatTerminalAccess(
  task: TaskItem | null,
  actor: { readonly threadId: string; readonly catId: string },
  closure: EntrustedWorkTerminalClosureV1,
): CatTerminalAccessResult {
  if (!task) return { ok: false, statusCode: 404, body: { error: 'Task not found' } };
  if (task.threadId !== actor.threadId) {
    return { ok: false, statusCode: 403, body: { error: 'Task belongs to a different thread' } };
  }
  if (task.ownerCatId !== actor.catId) {
    return { ok: false, statusCode: 403, body: { error: 'Entrusted work is owned by another cat' } };
  }
  if (carriesHumanTerminalEvidence(closure)) {
    return {
      ok: false,
      statusCode: 403,
      body: { error: 'Human terminal evidence is server-issued only', code: 'HUMAN_TERMINAL_ROUTE_REQUIRED' },
    };
  }
  return { ok: true, task };
}

export function registerCallbackTaskRoutes(
  app: FastifyInstance,
  deps: {
    taskStore: ITaskStore;
    ownedWaitStatusReader?: OwnedWaitStatusReader;
    messageStore: IMessageStore;
    socketManager: SocketManager;
    threadStore?: IThreadStore;
    developmentDocuments?: DevelopmentScopeDocuments;
    liveTaskAuthority?: LiveTaskAuthority;
  },
): void {
  const { taskStore, messageStore, socketManager, threadStore } = deps;
  registerCallbackDevelopmentWorkRoutes(app, deps);
  const entrustedWorkLifecycle = new EntrustedWorkLifecycleService(taskStore, {
    artifactReader: new F232PreparedArtifactReader({ messages: messageStore }),
    onChanged: (ownerUserId) =>
      socketManager.emitToUser(ownerUserId, 'entrusted_work_projection_invalidated', { ownerUserId }),
  });

  app.post(
    '/api/callbacks/update-task',
    withLiveTaskAuthority(deps.liveTaskAuthority, async (request, reply, live, assertCurrent) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      const actor = deriveCallbackActor(record);

      const deletedThreadGuard = await getDeletedCallbackThreadGuard(threadStore, actor.threadId);
      if (deletedThreadGuard) {
        reply.status(deletedThreadGuard.statusCode);
        return deletedThreadGuard.body;
      }

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
      if (
        live &&
        (existing.kind !== 'work' || existing.ownerCatId !== actor.catId || existing.userId !== actor.userId)
      ) {
        reply.status(403);
        return { error: 'Live may mutate only its own owner-scoped work Task' };
      }

      const updateData: Record<string, unknown> = {};
      if (status) updateData.status = status;
      if (why) updateData.why = why;
      // F193-E1 P1-4: allow patching dispatchGate on existing tasks
      if (dispatchGate) updateData.dispatchGate = dispatchGate;

      let updated: TaskItem | null;
      try {
        await assertCurrent();
        updated = await taskStore.update(taskId, updateData);
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
        reply.status(500);
        return { error: 'Failed to update task' };
      }

      socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
      return {
        status: 'ok',
        task: updated,
        ...(await reconcileOwnedTaskWaits(taskStore, deps.ownedWaitStatusReader, actor)),
      };
    }),
  );

  app.post(
    '/api/callbacks/admit-entrusted-work',
    withLiveTaskAuthority(deps.liveTaskAuthority, async (request, reply, _live, assertCurrent) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      const actor = deriveCallbackActor(record);
      const deletedThreadGuard = await getDeletedCallbackThreadGuard(threadStore, actor.threadId);
      if (deletedThreadGuard) {
        reply.status(deletedThreadGuard.statusCode);
        return deletedThreadGuard.body;
      }
      const parsed = admitEntrustedWorkSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parsed.error.issues };
      }

      try {
        const source = await assertDirectAdmissionSourceCustody(messageStore, actor, parsed.data.admission);
        await assertCurrent();
        const admission = await entrustedWorkLifecycle.admitOrResume(
          {
            task: {
              threadId: actor.threadId,
              title: parsed.data.title,
              why: parsed.data.why,
              createdBy: actor.catId,
              ownerCatId: actor.catId,
              userId: actor.userId,
            },
            admission: parsed.data.admission,
            closure: parsed.data.closure,
            time: parsed.data.time,
            artifactRefs: parsed.data.artifactRefs,
          },
          admissionSourceContext(source),
        );
        if (admission.result === 'needs_clarification') {
          return { status: 'needs_clarification', admission };
        }
        const taskId = admission.ownerRef.slice('task:item:'.length);
        const task = await taskStore.get(taskId);
        if (!task) {
          reply.status(500);
          return { error: 'Task admission returned an unreadable owner reference' };
        }
        if (admission.result === 'admitted') {
          socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_created', task);
        }
        return { status: admission.result, admission, task };
      } catch (error) {
        return replyEntrustedWorkLifecycleError(reply, error);
      }
    }),
  );

  app.post(
    '/api/callbacks/close-entrusted-work',
    withLiveTaskAuthority(deps.liveTaskAuthority, async (request, reply, live, assertCurrent) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      const actor = deriveCallbackActor(record);
      const deletedThreadGuard = await getDeletedCallbackThreadGuard(threadStore, actor.threadId);
      if (deletedThreadGuard) {
        reply.status(deletedThreadGuard.statusCode);
        return deletedThreadGuard.body;
      }
      const parsed = closeEntrustedWorkSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parsed.error.issues };
      }
      const access = validateCatTerminalAccess(await taskStore.get(parsed.data.taskId), actor, parsed.data.closure);
      if (!access.ok) {
        reply.status(access.statusCode);
        return access.body;
      }
      const existing = access.task;
      if (live && existing.userId !== actor.userId) {
        reply.status(403);
        return { error: 'Foreign Live Task owner' };
      }
      try {
        await assertCurrent();
        const task = await entrustedWorkLifecycle.close(parsed.data, assertCurrent);
        socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_updated', task);
        return {
          status: 'closed',
          task,
          ...(await reconcileOwnedTaskWaits(taskStore, deps.ownedWaitStatusReader, actor)),
        };
      } catch (error) {
        return replyEntrustedWorkLifecycleError(reply, error);
      }
    }),
  );

  app.post(
    '/api/callbacks/update-entrusted-work',
    withLiveTaskAuthority(deps.liveTaskAuthority, async (request, reply, live, assertCurrent) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      const actor = deriveCallbackActor(record);
      const deletedThreadGuard = await getDeletedCallbackThreadGuard(threadStore, actor.threadId);
      if (deletedThreadGuard) {
        reply.status(deletedThreadGuard.statusCode);
        return deletedThreadGuard.body;
      }
      const parsed = updateEntrustedWorkSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parsed.error.issues };
      }
      const existing = await taskStore.get(parsed.data.taskId);
      if (!existing) {
        reply.status(404);
        return { error: 'Task not found' };
      }
      if (existing.threadId !== actor.threadId) {
        reply.status(403);
        return { error: 'Task belongs to a different thread' };
      }
      // An authenticated current same-Task delegate may register Artifact evidence.
      // The callback scope guard permits only artifactRefs + revision for this capability.
      if (existing.ownerCatId !== actor.catId) {
        reply.status(403);
        return { error: 'Entrusted work is owned by another cat' };
      }
      if (live && (existing.ownerCatId !== actor.catId || existing.userId !== actor.userId)) {
        reply.status(403);
        return { error: 'Live may update only its own entrusted work' };
      }
      try {
        await assertCurrent();
        const task = await entrustedWorkLifecycle.update(parsed.data);
        socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_updated', task);
        return {
          status: 'updated',
          task,
          ...(await reconcileOwnedTaskWaits(taskStore, deps.ownedWaitStatusReader, actor)),
        };
      } catch (error) {
        return replyEntrustedWorkLifecycleError(reply, error);
      }
    }),
  );

  // F160: create-task — kind forced to 'work' (KD-4)
  app.post(
    '/api/callbacks/create-task',
    withLiveTaskAuthority(deps.liveTaskAuthority, async (request, reply, live, assertCurrent) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      const actor = deriveCallbackActor(record);

      const deletedThreadGuard = await getDeletedCallbackThreadGuard(threadStore, actor.threadId);
      if (deletedThreadGuard) {
        reply.status(deletedThreadGuard.statusCode);
        return deletedThreadGuard.body;
      }

      const parsed = createTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parsed.error.issues };
      }

      const { title, why, ownerCatId, relatedFeatureId, detectedFeatureIds, dispatchGate } = parsed.data;
      if (live && ownerCatId && ownerCatId !== actor.catId) {
        reply.status(403);
        return { error: 'Live Task creation cannot assign another cat' };
      }

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

      await assertCurrent();
      const task = await taskStore.create({
        threadId: actor.threadId,
        title,
        why: why ?? '',
        createdBy: actor.catId,
        kind: 'work',
        subjectKey: null,
        ownerCatId: live ? actor.catId : resolvedOwnerCatId,
        userId: actor.userId,
        // F193 Phase E (dispatch gate) — pass through to store
        ...(relatedFeatureId ? { relatedFeatureId } : {}),
        ...(detectedFeatureIds?.length ? { detectedFeatureIds } : {}),
        ...(dispatchGate ? { dispatchGate } : {}),
      });

      socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_created', task);
      reply.status(201);
      return { status: 'ok', task, ...(await reconcileOwnedTaskWaits(taskStore, deps.ownedWaitStatusReader, actor)) };
    }),
  );

  app.get('/api/callbacks/list-tasks', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = listTasksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }

    const { threadId, catId, status, kind, taskId, featureId } = parsed.data;

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

    const result = await queryTaskItems(taskStore, {
      threadIds: scopedThreadIds,
      ownerUserId: actor.userId,
      ...(catId ? { catId } : {}),
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      ...(taskId ? { taskId } : {}),
      ...(featureId ? { featureId } : {}),
    });
    const tasks = [...result.tasks];

    // F236 AC-A4: anchor the why field (head preview + whyLength + whyTruncated + drillDown).
    // A taskId drill returns that task's why in full.
    const isTaskDrill = Boolean(taskId);
    const payload = {
      tasks: tasks.map((task) => anchorTaskWhy(task, { full: isTaskDrill })),
      totalMatched: result.totalMatched,
      truncated: result.truncated,
      ...(result.queryRef ? { queryRef: result.queryRef } : {}),
    };
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
      recordAnchorPreviewEvent({
        tool: 'list-tasks',
        itemIds: tasks.map((t) => t.id),
        returnedChars: payload.tasks.reduce((sum, t) => sum + (t.why?.length ?? 0), 0),
        originalChars: tasks.reduce((sum, t) => sum + (t.why?.length ?? 0), 0),
        modeResolved: 'full',
        modeSource: 'legacy_equivalent',
        catId: actor.catId,
      });
    } else {
      recordAnchorReturned({ tool: 'list-tasks', returnedChars: listTasksChars });
      // F236 Track-2: per-event preview record with correlation keys for drill↔preview open-rate.
      // Both sides use content-only measurement (cloud R4 P1: JSON metadata skew fix).
      // list-tasks overview predates the Phase C `responseMode` param — its bounded
      // summary behavior is the legacy equivalent of anchor mode. Tag it so adoption
      // eval can distinguish "cat used old mechanism" from "cat explicitly chose anchor".
      recordAnchorPreviewEvent({
        tool: 'list-tasks',
        itemIds: tasks.map((t) => t.id),
        returnedChars: payload.tasks.reduce((sum, t) => sum + (t.why?.length ?? 0), 0),
        originalChars: tasks.reduce((sum, t) => sum + (t.why?.length ?? 0), 0),
        modeResolved: 'anchor',
        modeSource: 'legacy_equivalent',
        catId: actor.catId,
      });
    }
    return payload;
  });
}

function replyEntrustedWorkLifecycleError(
  reply: { status: (statusCode: number) => unknown },
  error: unknown,
): { error: string; code?: string } {
  if (!(error instanceof EntrustedWorkLifecycleError)) throw error;
  const statusCode = error.code === 'ENTRUSTED_WORK_NOT_FOUND' ? 404 : 409;
  reply.status(statusCode);
  return { error: error.message, code: error.code };
}
