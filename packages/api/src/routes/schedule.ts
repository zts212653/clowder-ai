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

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import type { GlobalControlStore } from '../infrastructure/scheduler/GlobalControlStore.js';
import type { PackTemplateStore } from '../infrastructure/scheduler/PackTemplateStore.js';
import {
  notifyTaskDeleted,
  notifyTaskPaused,
  notifyTaskRegistered,
  notifyTaskResumed,
} from '../infrastructure/scheduler/schedule-notify.js';
import type { TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { ScheduleLifecycleNotifier, TriggerSpec } from '../infrastructure/scheduler/types.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';
import { governanceRoutes } from './schedule-governance.js';

/** #415: Normalize once-trigger input — accepts delayMs (relative) or fireAt (absolute) */
function normalizeOnceTrigger(trigger: Record<string, unknown>): TriggerSpec | { error: string } {
  if (trigger.type !== 'once') return trigger as TriggerSpec;
  const delayMs = typeof trigger.delayMs === 'number' ? trigger.delayMs : undefined;
  const fireAt = typeof trigger.fireAt === 'number' ? trigger.fireAt : undefined;
  if (delayMs != null) {
    if (!Number.isFinite(delayMs) || delayMs < 0) return { error: 'once trigger delayMs must be a finite number >= 0' };
    return { type: 'once', fireAt: Date.now() + delayMs };
  }
  if (fireAt != null) {
    if (!Number.isFinite(fireAt) || fireAt < 0) {
      return { error: 'once trigger fireAt must be a finite positive epoch ms' };
    }
    return { type: 'once', fireAt };
  }
  return { error: 'once trigger requires either delayMs or fireAt' };
}

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
  /** #320: Unified task store for thread→subjectKey resolution */
  taskStore?: ITaskStore;
  /** Ephemeral lifecycle notifications for scheduler management actions */
  notifyLifecycle?: ScheduleLifecycleNotifier;
  /** Optional callback registry for inferring current thread from callback auth. */
  registry?: InvocationRegistry;
}

/** Extract threadId from subjectKey — handles both thread-xxx (real tasks) and thread:xxx formats */
export function extractThreadId(subjectKey: string): string | null {
  if (subjectKey.startsWith('thread-')) return subjectKey.slice(7);
  if (subjectKey.startsWith('thread:')) return subjectKey.slice(7);
  return null;
}

function addSubjectKeyWithAliases(target: Set<string>, subjectKey: string): void {
  target.add(subjectKey);
  if (subjectKey.startsWith('pr:')) target.add(`pr-${subjectKey.slice(3)}`);
  if (subjectKey.startsWith('pr-')) target.add(`pr:${subjectKey.slice(3)}`);
}

type DeliveryThreadResolutionCode = 'STALE_INVOCATION';

interface ScheduleActor {
  triggerUserId: string;
  createdBy: string;
}

/** Resolve deliveryThreadId from preHandler auth (headers) or explicit body param.
 *  Panel UI requests have no auth → uses explicit deliveryThreadId or null.
 *  MCP requests have callbackAuth → infer from invocation record.
 *  Invalid credentials are rejected at the preHandler level (fail-closed, #474). */
function resolveScopedDeliveryThreadId(
  callbackAuth: InvocationRecord | undefined,
  body: { deliveryThreadId?: string },
  registry?: InvocationRegistry,
): { deliveryThreadId: string | null; code: DeliveryThreadResolutionCode | null } {
  if (!callbackAuth) {
    return { deliveryThreadId: body.deliveryThreadId ?? null, code: null };
  }
  if (registry && !registry.isLatest(callbackAuth.invocationId)) {
    return { deliveryThreadId: null, code: 'STALE_INVOCATION' };
  }
  if (body.deliveryThreadId) return { deliveryThreadId: body.deliveryThreadId, code: null };
  return { deliveryThreadId: callbackAuth.threadId, code: null };
}

function deriveScheduleActor(request: FastifyRequest, body: { createdBy?: string }): ScheduleActor {
  if (request.callbackAuth) {
    const actor = deriveCallbackActor(request.callbackAuth);
    return {
      triggerUserId: actor.userId,
      createdBy: actor.catId,
    };
  }
  return {
    triggerUserId: resolveHeaderUserId(request) ?? 'default-user',
    createdBy: body.createdBy ?? 'unknown',
  };
}

export const scheduleRoutes: FastifyPluginAsync<ScheduleRoutesOptions> = async (app, opts) => {
  const {
    taskRunner,
    dynamicTaskStore,
    templateRegistry,
    globalControlStore,
    packTemplateStore,
    taskStore,
    notifyLifecycle,
    registry,
  } = opts;

  // #476: Register callback auth preHandler for MCP-originated schedule requests
  if (registry) registerCallbackAuthHook(app, registry);

  // GET /api/schedule/tasks
  // #320: Optional ?threadId= filter — resolves thread's task subjectKeys for cross-match
  app.get('/api/schedule/tasks', async (request) => {
    const { threadId } = request.query as { threadId?: string };
    const summaries = taskRunner.getTaskSummaries();

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
      }
    }
    // Also match thread-prefixed subject keys (dynamic/thread-scoped tasks)
    threadSubjectKeys.add(`thread-${threadId}`);
    threadSubjectKeys.add(`thread:${threadId}`);

    // P1-2 fix: don't rely solely on lastRun — query ledger for ANY matching run.
    // Also include tasks whose subjectKind matches active thread task kinds.
    const ledger = taskRunner.getLedger();
    const filtered = summaries.flatMap((s) => {
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
    if (!registered.includes(id)) {
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
    const params = body.params ?? {};
    const display = body.display
      ? {
          label: body.display.label,
          category: body.display.category as import('../infrastructure/scheduler/types.js').DisplayCategory,
          description: body.display.description,
        }
      : { label: template.label, category: template.category, description: template.description };

    const resolution = resolveScopedDeliveryThreadId(request.callbackAuth, body, registry);
    if (resolution.code === 'STALE_INVOCATION') {
      reply.status(409);
      return {
        error: 'Stale callback invocation superseded by a newer invocation',
        code: 'STALE_INVOCATION',
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
      invocationId?: string;
      callbackToken?: string;
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
    const params = body.params ?? {};

    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      reply.status(400);
      return { error: 'params must be a plain object' };
    }

    const actor = deriveScheduleActor(request, body);
    // Server-authoritative: callback-authenticated writes derive actor fields from
    // the verified invocation record; panel requests fall back to request identity.
    params.triggerUserId = actor.triggerUserId;

    const id = `dyn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const display = body.display
      ? {
          label: body.display.label,
          category: body.display.category as import('../infrastructure/scheduler/types.js').DisplayCategory,
          description: body.display.description,
        }
      : { label: template.label, category: template.category, description: template.description };

    const resolution = resolveScopedDeliveryThreadId(request.callbackAuth, body, registry);
    if (resolution.code === 'STALE_INVOCATION') {
      reply.status(409);
      return {
        error: 'Stale callback invocation superseded by a newer invocation',
        code: 'STALE_INVOCATION',
      };
    }

    const def = {
      id,
      templateId: body.templateId,
      trigger,
      params,
      display,
      deliveryThreadId: resolution.deliveryThreadId,
      enabled: true,
      createdBy: actor.createdBy,
      createdAt: new Date().toISOString(),
    };

    dynamicTaskStore.insert(def);

    // Register in runtime
    const spec = template.createSpec(id, { trigger, params, deliveryThreadId: def.deliveryThreadId });
    spec.display = display;
    taskRunner.registerDynamic(spec, id);

    // #415: lifecycle notification — task registered
    notifyTaskRegistered(notifyLifecycle, def);

    return { success: true, task: { id, ...display, trigger } };
  });

  // DELETE /api/schedule/tasks/:id (AC-G4: remove dynamic task)
  app.delete('/api/schedule/tasks/:id', async (request, reply) => {
    if (!dynamicTaskStore) {
      reply.status(501);
      return { error: 'Dynamic tasks not configured' };
    }

    const { id } = request.params as { id: string };
    // Read def before deletion for notification
    const defForNotify = dynamicTaskStore.getById(id);
    const removed = dynamicTaskStore.remove(id);
    if (!removed) {
      reply.status(404);
      return { error: 'Dynamic task not found' };
    }

    taskRunner.unregister(id);

    // #415: lifecycle notification — task deleted
    if (defForNotify) notifyTaskDeleted(notifyLifecycle, defForNotify);

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

    const def = dynamicTaskStore.getById(id);
    if (!body.enabled) {
      // Pause: unregister from runtime
      taskRunner.unregister(id);
      if (def) notifyTaskPaused(notifyLifecycle, def);
    } else {
      // Resume: re-register in runtime
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
          notifyTaskResumed(notifyLifecycle, def);
        } else {
          dynamicTaskStore.setEnabled(id, false); // roll back — resume failed
          reply.status(500);
          return { error: `Template ${def.templateId} not found — task cannot resume` };
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
