/**
 * F076: Resolution routes — Stage 3 clarification queue CRUD
 */

import type { CreateResolutionInput, ResolutionPath } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ExternalProjectStore } from '../domains/projects/external-project-store.js';
import type { ResolutionStore } from '../domains/projects/resolution-store.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface ResolutionRoutesOptions {
  externalProjectStore: ExternalProjectStore;
  resolutionStore: ResolutionStore;
}

export const resolutionRoutes: FastifyPluginAsync<ResolutionRoutesOptions> = async (app, opts) => {
  const { externalProjectStore, resolutionStore } = opts;

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

  app.post('/api/external-projects/:projectId/resolutions', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const body = request.body as Record<string, unknown>;
    const input: CreateResolutionInput = {
      cardId: (body.cardId as string) ?? '',
      path: (body.path as ResolutionPath) ?? 'confirmation',
      question: (body.question as string) ?? '',
      options: (body.options as string[]) ?? [],
      recommendation: (body.recommendation as string) ?? '',
    };
    const resolution = resolutionStore.create(projectId, input);
    return reply.status(201).send({ resolution });
  });

  app.get('/api/external-projects/:projectId/resolutions', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const query = request.query as { status?: string };
    const items =
      query.status === 'open' ? resolutionStore.listOpen(projectId) : resolutionStore.listByProject(projectId);
    return reply.send({ resolutions: items });
  });

  app.get('/api/external-projects/:projectId/resolutions/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, id } = request.params as { projectId: string; id: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const resolution = resolutionStore.getById(id);
    if (!resolution || resolution.projectId !== projectId) {
      return reply.status(404).send({ error: 'Resolution not found' });
    }
    return reply.send({ resolution });
  });

  app.patch('/api/external-projects/:projectId/resolutions/:id/answer', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, id } = request.params as { projectId: string; id: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const existing = resolutionStore.getById(id);
    if (!existing || existing.projectId !== projectId) {
      return reply.status(404).send({ error: 'Resolution not found' });
    }

    const body = request.body as Record<string, unknown>;
    const resolution = resolutionStore.answer(id, {
      answer: (body.answer as string) ?? '',
    });
    if (!resolution) return reply.status(404).send({ error: 'Resolution not found' });
    return reply.send({ resolution });
  });

  app.patch('/api/external-projects/:projectId/resolutions/:id/escalate', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, id } = request.params as { projectId: string; id: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const existing = resolutionStore.getById(id);
    if (!existing || existing.projectId !== projectId) {
      return reply.status(404).send({ error: 'Resolution not found' });
    }

    const resolution = resolutionStore.escalate(id);
    if (!resolution) return reply.status(404).send({ error: 'Resolution not found' });
    return reply.send({ resolution });
  });

  app.delete('/api/external-projects/:projectId/resolutions/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, id } = request.params as { projectId: string; id: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const existing = resolutionStore.getById(id);
    if (!existing || existing.projectId !== projectId) {
      return reply.status(404).send({ error: 'Resolution not found' });
    }

    resolutionStore.delete(id);
    return reply.status(204).send();
  });
};
