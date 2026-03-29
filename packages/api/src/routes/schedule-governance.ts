/**
 * Schedule Governance + Pack Template Routes (F139 Phase 3B)
 *
 * GET  /api/schedule/control              → global state + overrides (AC-D1)
 * PATCH /api/schedule/control             → toggle global enabled (AC-D1)
 * PUT  /api/schedule/control/tasks/:id    → set task override (AC-D1)
 * DELETE /api/schedule/control/tasks/:id  → remove task override (AC-D1)
 * GET  /api/schedule/pack-templates       → list pack templates (AC-D3)
 * POST /api/schedule/pack-templates       → install pack template (AC-D3)
 * DELETE /api/schedule/pack-templates/:id → uninstall (AC-D3)
 */

import type { FastifyPluginAsync } from 'fastify';
import type { GlobalControlStore } from '../infrastructure/scheduler/GlobalControlStore.js';
import type { PackTemplateStore } from '../infrastructure/scheduler/PackTemplateStore.js';
import type { TaskTemplate } from '../infrastructure/scheduler/templates/types.js';
import type { TriggerSpec } from '../infrastructure/scheduler/types.js';

export interface GovernanceRoutesOptions {
  globalControlStore?: GlobalControlStore;
  packTemplateStore?: PackTemplateStore;
  templateRegistry?: {
    get: (id: string) => TaskTemplate | null;
    register?: (template: TaskTemplate) => void;
    unregister?: (templateId: string) => boolean;
  };
  dynamicTaskStore?: {
    getAll: () => { templateId: string; enabled: boolean }[];
  };
}

export const governanceRoutes: FastifyPluginAsync<GovernanceRoutesOptions> = async (app, opts) => {
  const { globalControlStore, packTemplateStore, templateRegistry, dynamicTaskStore } = opts;

  // ─── Governance Control (AC-D1) ────────────────────────────────────

  app.get('/api/schedule/control', async (_request, reply) => {
    if (!globalControlStore) {
      reply.status(501);
      return { error: 'Governance not configured' };
    }
    return {
      global: globalControlStore.getGlobalState(),
      overrides: globalControlStore.listOverrides(),
    };
  });

  app.patch('/api/schedule/control', async (request, reply) => {
    if (!globalControlStore) {
      reply.status(501);
      return { error: 'Governance not configured' };
    }
    const body = (request.body ?? {}) as { enabled?: boolean; reason?: string; updatedBy?: string };
    if (typeof body.enabled !== 'boolean') {
      reply.status(400);
      return { error: 'Missing enabled field' };
    }
    globalControlStore.setGlobalEnabled(body.enabled, body.reason ?? null, body.updatedBy ?? 'api');
    return { global: globalControlStore.getGlobalState() };
  });

  app.put('/api/schedule/control/tasks/:id', async (request, reply) => {
    if (!globalControlStore) {
      reply.status(501);
      return { error: 'Governance not configured' };
    }
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { enabled?: boolean; updatedBy?: string };
    if (typeof body.enabled !== 'boolean') {
      reply.status(400);
      return { error: 'Missing enabled field' };
    }
    globalControlStore.setTaskOverride(id, body.enabled, body.updatedBy ?? 'api');
    const override = globalControlStore.getTaskOverride(id);
    return { override };
  });

  app.delete('/api/schedule/control/tasks/:id', async (request, reply) => {
    if (!globalControlStore) {
      reply.status(501);
      return { error: 'Governance not configured' };
    }
    const { id } = request.params as { id: string };
    const removed = globalControlStore.removeTaskOverride(id);
    if (!removed) {
      reply.status(404);
      return { error: 'No override for this task' };
    }
    return { success: true };
  });

  // ─── Pack Templates (AC-D3) ────────────────────────────────────────

  app.get('/api/schedule/pack-templates', async (_request, reply) => {
    if (!packTemplateStore) {
      reply.status(501);
      return { error: 'Pack templates not configured' };
    }
    return { templates: packTemplateStore.listAll() };
  });

  app.post('/api/schedule/pack-templates', async (request, reply) => {
    if (!packTemplateStore) {
      reply.status(501);
      return { error: 'Pack templates not configured' };
    }
    const body = (request.body ?? {}) as {
      templateId?: string;
      packId?: string;
      label?: string;
      description?: string;
      category?: string;
      subjectKind?: string;
      defaultTrigger?: TriggerSpec;
      paramSchema?: Record<string, unknown>;
      builtinTemplateRef?: string;
    };

    if (!body.templateId || !body.packId || !body.builtinTemplateRef) {
      reply.status(400);
      return { error: 'Missing required fields: templateId, packId, builtinTemplateRef' };
    }

    if (templateRegistry && !templateRegistry.get(body.builtinTemplateRef)) {
      reply.status(400);
      return { error: `Unknown builtin template: "${body.builtinTemplateRef}"` };
    }

    const packDef = {
      templateId: body.templateId,
      packId: body.packId,
      label: body.label ?? body.templateId,
      description: body.description ?? '',
      category: (body.category ?? 'external') as import('../infrastructure/scheduler/types.js').DisplayCategory,
      subjectKind: (body.subjectKind ?? 'none') as import('../infrastructure/scheduler/types.js').SubjectKind,
      defaultTrigger: body.defaultTrigger ?? { type: 'interval', ms: 3600000 },
      paramSchema: (body.paramSchema ?? {}) as Record<string, { type: string; required: boolean; description: string }>,
      builtinTemplateRef: body.builtinTemplateRef,
    };

    try {
      packTemplateStore.install(packDef);
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }

    // AC-D3: Register pack template into runtime TemplateRegistry as a delegate to builtinRef
    if (templateRegistry?.register) {
      const builtinTemplate = templateRegistry.get(body.builtinTemplateRef);
      if (builtinTemplate) {
        templateRegistry.register({
          templateId: packDef.templateId,
          label: packDef.label,
          category: packDef.category,
          description: packDef.description,
          subjectKind: packDef.subjectKind,
          defaultTrigger: packDef.defaultTrigger,
          paramSchema: packDef.paramSchema as TaskTemplate['paramSchema'],
          createSpec: builtinTemplate.createSpec,
        });
      }
    }

    const installed = packTemplateStore.get(body.templateId);
    return { template: installed };
  });

  app.delete('/api/schedule/pack-templates/:id', async (request, reply) => {
    if (!packTemplateStore) {
      reply.status(501);
      return { error: 'Pack templates not configured' };
    }
    const { id } = request.params as { id: string };

    if (dynamicTaskStore) {
      const activeInstances = dynamicTaskStore.getAll().filter((d) => d.templateId === id && d.enabled);
      if (activeInstances.length > 0) {
        reply.status(409);
        return {
          error: `Cannot uninstall: ${activeInstances.length} active instance(s) use this template`,
          activeCount: activeInstances.length,
        };
      }
    }

    const removed = packTemplateStore.uninstall(id);
    if (!removed) {
      reply.status(404);
      return { error: 'Pack template not found' };
    }
    // AC-D3: Remove from runtime registry on uninstall
    templateRegistry?.unregister?.(id);
    return { success: true };
  });
};
