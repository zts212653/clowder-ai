/**
 * GET /api/cats/:catId/disable-impact
 * F182 Phase D — server-side aggregation of active references for a cat
 * (OQ-2: server-side endpoint, no index, thin scan)
 */

import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface DynamicTaskDefLike {
  id: string;
  templateId: string;
  params: Record<string, unknown>;
  display: { label: string };
  enabled: boolean;
}

interface DynamicTaskStoreLike {
  getAll(): DynamicTaskDefLike[];
}

interface DisableImpactDeps {
  taskStore: ITaskStore;
  dynamicTaskStore?: DynamicTaskStoreLike;
}

async function aggregateActiveReferences(
  catId: string,
  deps: DisableImpactDeps,
  userId: string,
): Promise<{
  tasks: Array<{ id: string; title: string; status: string; ownerCatId: string | null; threadId: string }>;
  scheduledTasks: Array<{ id: string; label: string; templateId: string }>;
}> {
  const { taskStore, dynamicTaskStore } = deps;

  const allWork = await taskStore.listByKind('work');
  const tasks = allWork
    .filter((t) => t.ownerCatId === catId && t.status !== 'done' && t.userId === userId)
    .map((t) => ({ id: t.id, title: t.title, status: t.status, ownerCatId: t.ownerCatId, threadId: t.threadId }));

  const scheduledTasks = dynamicTaskStore
    ? dynamicTaskStore
        .getAll()
        .filter((d) => d.enabled && d.params.targetCatId === catId && d.params.triggerUserId === userId)
        .map((d) => ({ id: d.id, label: d.display.label, templateId: d.templateId }))
    : [];

  return { tasks, scheduledTasks };
}

export function registerDisableImpactRoute(app: FastifyInstance, deps: DisableImpactDeps): void {
  app.get<{ Params: { catId: string } }>('/api/cats/:catId/disable-impact', async (request, reply) => {
    const { catId } = request.params;
    if (!catRegistry.has(catId)) {
      reply.status(404);
      return { error: `Cat "${catId}" not found` };
    }
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    return aggregateActiveReferences(catId, deps, userId);
  });
}
