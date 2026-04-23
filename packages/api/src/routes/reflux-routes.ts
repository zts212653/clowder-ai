/**
 * F076: Reflux Pattern routes — methodology experience capture
 */

import type { CreateRefluxPatternInput, RefluxCategory } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ExternalProjectStore } from '../domains/projects/external-project-store.js';
import type { RefluxPatternStore } from '../domains/projects/reflux-pattern-store.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface RefluxRoutesOptions {
  externalProjectStore: ExternalProjectStore;
  refluxPatternStore: RefluxPatternStore;
}

export const refluxRoutes: FastifyPluginAsync<RefluxRoutesOptions> = async (app, opts) => {
  const { externalProjectStore, refluxPatternStore } = opts;

  function requireUserId(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveHeaderUserId(request) ?? undefined;
    if (!userId) {
      void reply.status(401).send({ error: 'Identity required' });
      return null;
    }
    return userId;
  }

  async function requireOwnedProject(id: string, userId: string, reply: FastifyReply) {
    const project = await externalProjectStore.getById(id);
    if (!project || project.userId !== userId) {
      void reply.status(404).send({ error: 'Project not found' });
      return null;
    }
    return project;
  }

  app.post('/api/external-projects/:projectId/reflux-patterns', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const body = request.body as Record<string, unknown>;
    const input: CreateRefluxPatternInput = {
      category: (body.category as RefluxCategory) ?? 'methodology',
      title: (body.title as string) ?? '',
      insight: (body.insight as string) ?? '',
      evidence: (body.evidence as string) ?? '',
    };
    const pattern = refluxPatternStore.create(projectId, input);
    return reply.status(201).send({ pattern });
  });

  app.get('/api/external-projects/:projectId/reflux-patterns', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const query = request.query as { category?: string };
    const items = query.category
      ? refluxPatternStore.listByCategory(projectId, query.category as RefluxCategory)
      : refluxPatternStore.listByProject(projectId);
    return reply.send({ patterns: items });
  });

  app.delete('/api/external-projects/:projectId/reflux-patterns/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, id } = request.params as { projectId: string; id: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const existing = refluxPatternStore.getById(id);
    if (!existing || existing.projectId !== projectId) {
      return reply.status(404).send({ error: 'Reflux pattern not found' });
    }

    refluxPatternStore.delete(id);
    return reply.status(204).send();
  });
};
