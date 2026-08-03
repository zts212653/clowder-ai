/**
 * Schedule Panel API Routes (F139 Phase 2 + Phase 3A + Phase 3B)
 *
 * GET  /api/schedule/tasks              → list registered tasks + summaries
 * GET  /api/schedule/tasks/:id/runs     → run history (optional ?threadId= filter)
 * POST /api/schedule/tasks/:id/trigger  → manual trigger (bypasses governance)
 * GET  /api/schedule/templates          → list available templates (AC-G1)
 * POST /api/schedule/tasks              → create dynamic task (AC-G3)
 * DELETE /api/schedule/tasks/:id        → remove dynamic task (AC-G4)
 * PATCH /api/schedule/tasks/:id         → toggle enabled (AC-G4)
 * GET  /api/schedule/control            → global state + task overrides (AC-D1)
 * PATCH /api/schedule/control           → toggle global enabled (AC-D1)
 * PUT  /api/schedule/control/tasks/:id  → set task override (AC-D1)
 * DELETE /api/schedule/control/tasks/:id → remove task override (AC-D1)
 */

import type { FastifyPluginAsync } from 'fastify';
import { f255ConfigRequired, isF255ConfigOnlyTemplate } from '../infrastructure/scheduler/f255-template-boundary.js';
import type { TriggerSpec } from '../infrastructure/scheduler/types.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';
import { governanceRoutes } from './schedule-governance.js';
import { scheduleMutationRoutes } from './schedule-mutation-routes.js';
import {
  addSubjectKeyWithAliases,
  deriveScheduleRequestContext,
  extractThreadId,
  f255ManagedTask,
  isF255ManagedTask,
  isVisibleDynamicTaskDef,
  mergeUnregisteredDynamicTasks,
  normalizeOnceTrigger,
  normalizeScheduleTargetParam,
  resolveAgentKeyDeliveryThreadScope,
  resolveScopedDeliveryThreadId,
  type ScheduleRoutesOptions,
  toPlainScheduleParams,
} from './schedule-route-support.js';

export type { ScheduleRoutesOptions } from './schedule-route-support.js';
export { deriveScheduleActorForTest, extractThreadId } from './schedule-route-support.js';

export const scheduleRoutes: FastifyPluginAsync<ScheduleRoutesOptions> = async (app, opts) => {
  const {
    taskRunner,
    dynamicTaskStore,
    templateRegistry,
    globalControlStore,
    packTemplateStore,
    taskStore,
    threadStore,
    registry,
    agentKeyRegistry,
  } = opts;

  // #476: Register callback auth preHandler for MCP-originated schedule requests
  if (registry) registerCallbackAuthHook(app, registry, { ...(agentKeyRegistry ? { agentKeyRegistry } : {}) });

  // GET /api/schedule/tasks
  // #320: Optional ?threadId= filter — resolves thread's task subjectKeys for cross-match
  app.get('/api/schedule/tasks', async (request) => {
    const { threadId } = request.query as { threadId?: string };
    const summaries = mergeUnregisteredDynamicTasks(
      taskRunner.getTaskSummaries(),
      taskRunner,
      dynamicTaskStore,
      templateRegistry,
    );

    if (!threadId || !taskStore) {
      return { tasks: summaries };
    }

    // Build set of subjectKeys for tasks in this thread
    const threadTasks = await taskStore.listByThread(threadId);
    const threadSubjectKeys = new Set<string>();
    const activeThreadSubjectKinds = new Set<string>();
    for (const t of threadTasks) {
      if (t.subjectKey) addSubjectKeyWithAliases(threadSubjectKeys, t.subjectKey);
      if (t.status === 'done' || !t.subjectKey) continue;
      if (t.subjectKey.startsWith('pr:') || t.subjectKey.startsWith('pr-')) activeThreadSubjectKinds.add('pr');
      else if (t.subjectKey.startsWith('thread:') || t.subjectKey.startsWith('thread-')) {
        activeThreadSubjectKinds.add('thread');
      } else if (t.subjectKey.startsWith('issue:')) {
        activeThreadSubjectKinds.add('issue');
      }
    }
    // Also match thread-prefixed subject keys (dynamic/thread-scoped tasks)
    threadSubjectKeys.add(`thread-${threadId}`);
    threadSubjectKeys.add(`thread:${threadId}`);

    // P1-2 fix: don't rely solely on lastRun — query ledger for ANY matching run.
    // Also include tasks whose subjectKind matches active thread task kinds.
    const ledger = taskRunner.getLedger();
    const filtered = summaries.flatMap((s) => {
      if (s.deliveryThreadId === threadId) return [s];
      // Quick path: if lastRun matches, include immediately
      if (s.lastRun && threadSubjectKeys.has(s.lastRun.subject_key)) return [s];
      // Slow path: check if ANY run for this task matches thread's subject keys
      for (const sk of threadSubjectKeys) {
        const runs = ledger.queryBySubject(s.id, sk, 1);
        if (runs.length > 0) return [s];
      }
      // Kind-match path (#320 P1): thread has active task of matching kind → include,
      // but scrub run metadata that belongs to other threads/PRs.
      if (s.display?.subjectKind && activeThreadSubjectKinds.has(s.display.subjectKind)) {
        const { lastRun: _, subjectPreview: __, runStats: ___, ...rest } = s;
        return [
          { ...rest, lastRun: null, subjectPreview: null, runStats: { total: 0, delivered: 0, failed: 0, skipped: 0 } },
        ];
      }
      return [];
    });

    return { tasks: filtered };
  });

  // GET /api/schedule/tasks/:id/runs
  // #320: threadId filter now resolves task subjectKeys for cross-match
  app.get('/api/schedule/tasks/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { threadId, limit } = request.query as { threadId?: string; limit?: string };
    const maxRows = Math.min(Number(limit) || 50, 200);

    const registered = taskRunner.getRegisteredTasks();
    const dynamicDef = dynamicTaskStore?.getById(id);
    if (!registered.includes(id) && !isVisibleDynamicTaskDef(dynamicDef)) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    const ledger = taskRunner.getLedger();
    let runs: import('../infrastructure/scheduler/types.js').RunLedgerRow[];

    if (threadId) {
      // Collect all subject keys for this thread (thread-xxx, thread:xxx, + TaskStore entries)
      const subjectKeys = new Set([`thread-${threadId}`, `thread:${threadId}`]);
      if (taskStore) {
        const threadTasks = await taskStore.listByThread(threadId);
        for (const t of threadTasks) {
          if (t.subjectKey) addSubjectKeyWithAliases(subjectKeys, t.subjectKey);
        }
      }
      const allRuns: import('../infrastructure/scheduler/types.js').RunLedgerRow[] = [];
      for (const sk of subjectKeys) {
        allRuns.push(...ledger.queryBySubject(id, sk, maxRows));
      }
      runs = allRuns.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
      if (runs.length > maxRows) runs = runs.slice(0, maxRows);
    } else {
      runs = ledger.query(id, maxRows);
    }

    return {
      runs: runs.map((r) => ({
        ...r,
        threadId: extractThreadId(r.subject_key),
      })),
    };
  });

  // POST /api/schedule/tasks/:id/trigger
  app.post('/api/schedule/tasks/:id/trigger', async (request, reply) => {
    const { id } = request.params as { id: string };
    const dynamicDef = dynamicTaskStore?.getById(id);
    if (isVisibleDynamicTaskDef(dynamicDef) && isF255ManagedTask(dynamicDef)) {
      reply.status(409);
      return f255ManagedTask();
    }
    const registered = taskRunner.getRegisteredTasks();
    if (!registered.includes(id)) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    const outcome = await taskRunner.triggerNow(id, { manual: true });
    if (outcome === 'cancellation_pending') {
      reply.status(409);
      return { error: 'Task cancellation is pending', code: 'WAIT_CANCELLATION_PENDING', taskId: id };
    }
    return { success: true, taskId: id };
  });

  // GET /api/schedule/templates (AC-G1)
  app.get('/api/schedule/templates', async () => {
    if (!templateRegistry) return { templates: [] };
    return {
      templates: templateRegistry
        .list()
        .filter((template) => !isF255ConfigOnlyTemplate(template.templateId, packTemplateStore))
        .map((t) => ({
          templateId: t.templateId,
          label: t.label,
          category: t.category,
          description: t.description,
          defaultTrigger: t.defaultTrigger,
          paramSchema: t.paramSchema,
        })),
    };
  });

  // POST /api/schedule/tasks/preview (AC-G2: draft step — validate + preview, no persist)
  app.post('/api/schedule/tasks/preview', async (request, reply) => {
    if (!templateRegistry) {
      reply.status(501);
      return { error: 'Templates not configured' };
    }

    const body = (request.body ?? {}) as {
      templateId?: string;
      trigger?: TriggerSpec;
      params?: Record<string, unknown>;
      display?: { label: string; category: string; description?: string };
      deliveryThreadId?: string;
    };

    if (!body.templateId) {
      reply.status(400);
      return { error: 'Missing templateId' };
    }
    if (isF255ConfigOnlyTemplate(body.templateId, packTemplateStore)) {
      reply.status(409);
      return f255ConfigRequired();
    }

    const template = templateRegistry.get(body.templateId);
    if (!template) {
      reply.status(400);
      return { error: `Unknown template: ${body.templateId}` };
    }

    // #415: normalize once trigger (delayMs → fireAt)
    let trigger: TriggerSpec;
    if (body.trigger && (body.trigger as Record<string, unknown>).type === 'once') {
      const result = normalizeOnceTrigger(body.trigger as Record<string, unknown>);
      if ('error' in result) {
        reply.status(400);
        return { error: result.error };
      }
      trigger = result;
    } else {
      trigger = body.trigger ?? template.defaultTrigger;
    }
    const rawParams = toPlainScheduleParams(body.params ?? {});
    if (!rawParams) {
      reply.status(400);
      return { error: 'params must be a plain object' };
    }
    const context = deriveScheduleRequestContext(request, {}, rawParams);
    const targetResult = normalizeScheduleTargetParam(context.params);
    if (!targetResult.ok) {
      reply.status(400);
      return targetResult.error;
    }
    const params = targetResult.params;
    const display = body.display
      ? {
          label: body.display.label,
          category: body.display.category as import('../infrastructure/scheduler/types.js').DisplayCategory,
          description: body.display.description,
        }
      : { label: template.label, category: template.category, description: template.description };

    const resolution = await resolveScopedDeliveryThreadId(request.callbackAuth, body, registry);
    if (resolution.code === 'STALE_INVOCATION') {
      reply.status(409);
      return {
        error: 'Stale callback invocation superseded by a newer invocation',
        code: 'STALE_INVOCATION',
      };
    }
    const agentKeyScope = await resolveAgentKeyDeliveryThreadScope(request, resolution.deliveryThreadId, threadStore);
    if (!agentKeyScope.ok) {
      reply.status(agentKeyScope.statusCode);
      return {
        error: agentKeyScope.error,
        ...(agentKeyScope.code ? { code: agentKeyScope.code } : {}),
      };
    }

    return {
      draft: {
        templateId: body.templateId,
        templateLabel: template.label,
        trigger,
        params,
        display,
        deliveryThreadId: resolution.deliveryThreadId,
        paramSchema: template.paramSchema,
      },
    };
  });

  await app.register(scheduleMutationRoutes, opts);

  // ─── Governance + Pack Templates (AC-D1/D3) — extracted for file size ──
  await app.register(governanceRoutes, {
    globalControlStore,
    packTemplateStore,
    templateRegistry,
    dynamicTaskStore,
  });
};
