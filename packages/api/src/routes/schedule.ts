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
import type { DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import type { GlobalControlStore } from '../infrastructure/scheduler/GlobalControlStore.js';
import type { PackTemplateStore } from '../infrastructure/scheduler/PackTemplateStore.js';
import type { TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { TriggerSpec } from '../infrastructure/scheduler/types.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import { governanceRoutes } from './schedule-governance.js';

export interface ScheduleRoutesOptions {
  taskRunner: TaskRunnerV2;
  dynamicTaskStore?: DynamicTaskStore;
  templateRegistry?: {
    get: (id: string) => import('../infrastructure/scheduler/templates/types.js').TaskTemplate | null;
    list: () => import('../infrastructure/scheduler/templates/types.js').TaskTemplate[];
    register?: (template: import('../infrastructure/scheduler/templates/types.js').TaskTemplate) => void;
    unregister?: (templateId: string) => boolean;
  };
  /** Phase 3B (AC-D1): governance store */
  globalControlStore?: GlobalControlStore;
  /** Phase 3B (AC-D3): pack template store */
  packTemplateStore?: PackTemplateStore;
}

/** Extract threadId from subjectKey — handles both thread-xxx (real tasks) and thread:xxx formats */
export function extractThreadId(subjectKey: string): string | null {
  if (subjectKey.startsWith('thread-')) return subjectKey.slice(7);
  if (subjectKey.startsWith('thread:')) return subjectKey.slice(7);
  return null;
}

export const scheduleRoutes: FastifyPluginAsync<ScheduleRoutesOptions> = async (app, opts) => {
  const { taskRunner, dynamicTaskStore, templateRegistry, globalControlStore, packTemplateStore } = opts;

  // GET /api/schedule/tasks
  app.get('/api/schedule/tasks', async () => {
    const summaries = taskRunner.getTaskSummaries();
    return { tasks: summaries };
  });

  // GET /api/schedule/tasks/:id/runs
  app.get('/api/schedule/tasks/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { threadId, limit } = request.query as { threadId?: string; limit?: string };
    const maxRows = Math.min(Number(limit) || 50, 200);

    const registered = taskRunner.getRegisteredTasks();
    if (!registered.includes(id)) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    const ledger = taskRunner.getLedger();
    let runs: import('../infrastructure/scheduler/types.js').RunLedgerRow[];

    if (threadId) {
      const hyphenKey = `thread-${threadId}`;
      const colonKey = `thread:${threadId}`;
      const hyphenRuns = ledger.queryBySubject(id, hyphenKey, maxRows);
      const colonRuns = ledger.queryBySubject(id, colonKey, maxRows);
      runs = [...hyphenRuns, ...colonRuns].sort(
        (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
      );
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
    const registered = taskRunner.getRegisteredTasks();
    if (!registered.includes(id)) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    await taskRunner.triggerNow(id, { manual: true });
    return { success: true, taskId: id };
  });

  // GET /api/schedule/templates (AC-G1)
  app.get('/api/schedule/templates', async () => {
    if (!templateRegistry) return { templates: [] };
    return {
      templates: templateRegistry.list().map((t) => ({
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

    const template = templateRegistry.get(body.templateId);
    if (!template) {
      reply.status(400);
      return { error: `Unknown template: ${body.templateId}` };
    }

    const trigger = body.trigger ?? template.defaultTrigger;
    const params = body.params ?? {};
    const display = body.display
      ? {
          label: body.display.label,
          category: body.display.category as import('../infrastructure/scheduler/types.js').DisplayCategory,
          description: body.display.description,
        }
      : { label: template.label, category: template.category, description: template.description };

    return {
      draft: {
        templateId: body.templateId,
        templateLabel: template.label,
        trigger,
        params,
        display,
        deliveryThreadId: body.deliveryThreadId ?? null,
        paramSchema: template.paramSchema,
      },
    };
  });

  // POST /api/schedule/tasks (AC-G3: create dynamic task)
  app.post('/api/schedule/tasks', async (request, reply) => {
    if (!dynamicTaskStore || !templateRegistry) {
      reply.status(501);
      return { error: 'Dynamic tasks not configured' };
    }

    const body = (request.body ?? {}) as {
      templateId?: string;
      trigger?: TriggerSpec;
      params?: Record<string, unknown>;
      display?: { label: string; category: string; description?: string };
      deliveryThreadId?: string;
      createdBy?: string;
    };

    if (!body.templateId) {
      reply.status(400);
      return { error: 'Missing templateId' };
    }

    const template = templateRegistry.get(body.templateId);
    if (!template) {
      reply.status(400);
      return { error: `Unknown template: ${body.templateId}` };
    }

    const trigger = body.trigger ?? template.defaultTrigger;
    const params = body.params ?? {};

    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      reply.status(400);
      return { error: 'params must be a plain object' };
    }

    // Server-authoritative: always overwrite triggerUserId from request identity.
    // Prevents client from forging userId on scheduler-triggered cat replies.
    params.triggerUserId = resolveHeaderUserId(request) ?? 'default-user';

    const id = `dyn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const display = body.display
      ? {
          label: body.display.label,
          category: body.display.category as import('../infrastructure/scheduler/types.js').DisplayCategory,
          description: body.display.description,
        }
      : { label: template.label, category: template.category, description: template.description };

    const def = {
      id,
      templateId: body.templateId,
      trigger,
      params,
      display,
      deliveryThreadId: body.deliveryThreadId ?? null,
      enabled: true,
      createdBy: body.createdBy ?? 'unknown',
      createdAt: new Date().toISOString(),
    };

    dynamicTaskStore.insert(def);

    // Register in runtime
    const spec = template.createSpec(id, { trigger, params, deliveryThreadId: def.deliveryThreadId });
    spec.display = display;
    taskRunner.registerDynamic(spec, id);

    return { success: true, task: { id, ...display, trigger } };
  });

  // DELETE /api/schedule/tasks/:id (AC-G4: remove dynamic task)
  app.delete('/api/schedule/tasks/:id', async (request, reply) => {
    if (!dynamicTaskStore) {
      reply.status(501);
      return { error: 'Dynamic tasks not configured' };
    }

    const { id } = request.params as { id: string };
    const removed = dynamicTaskStore.remove(id);
    if (!removed) {
      reply.status(404);
      return { error: 'Dynamic task not found' };
    }

    taskRunner.unregister(id);
    return { success: true };
  });

  // PATCH /api/schedule/tasks/:id (AC-G4: toggle enabled — affects runtime)
  app.patch('/api/schedule/tasks/:id', async (request, reply) => {
    if (!dynamicTaskStore || !templateRegistry) {
      reply.status(501);
      return { error: 'Dynamic tasks not configured' };
    }

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { enabled?: boolean };

    if (typeof body.enabled !== 'boolean') {
      reply.status(400);
      return { error: 'Missing enabled field' };
    }

    const updated = dynamicTaskStore.setEnabled(id, body.enabled);
    if (!updated) {
      reply.status(404);
      return { error: 'Dynamic task not found' };
    }

    if (!body.enabled) {
      // Pause: unregister from runtime
      taskRunner.unregister(id);
    } else {
      // Resume: re-register in runtime
      const def = dynamicTaskStore.getById(id);
      if (def) {
        const template = templateRegistry.get(def.templateId);
        if (template) {
          const spec = template.createSpec(def.id, {
            trigger: def.trigger,
            params: def.params,
            deliveryThreadId: def.deliveryThreadId,
          });
          spec.display = def.display;
          try {
            taskRunner.registerDynamic(spec, def.id);
          } catch {
            // Already registered — ignore
          }
        }
      }
    }

    return { success: true, enabled: body.enabled };
  });

  // ─── Governance + Pack Templates (AC-D1/D3) — extracted for file size ──
  await app.register(governanceRoutes, {
    globalControlStore,
    packTemplateStore,
    templateRegistry,
    dynamicTaskStore,
  });
};
