/**
 * F076: Slice routes — Stage 4 slice planning CRUD + reorder
 */

import type { CreateSliceInput, SliceType, UpdateSliceInput } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ExternalProjectStore } from '../domains/projects/external-project-store.js';
import type { SliceStore } from '../domains/projects/slice-store.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface SliceRoutesOptions {
  externalProjectStore: ExternalProjectStore;
  sliceStore: SliceStore;
}

export const sliceRoutes: FastifyPluginAsync<SliceRoutesOptions> = async (app, opts) => {
  const { externalProjectStore, sliceStore } = opts;

  function requireUserId(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveHeaderUserId(request) ?? undefined;
    if (!userId) {
      void reply.status(401).send({ error: 'Identity required' });
      return null;
    }
    return userId;
  }

  function requireOwnedProject(id: string, userId: string, reply: FastifyReply) {
    const project = externalProjectStore.getById(id);
    if (!project || project.userId !== userId) {
      void reply.status(404).send({ error: 'Project not found' });
      return null;
    }
    return project;
  }

  app.post('/api/external-projects/:projectId/slices', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;

    const body = request.body as Record<string, unknown>;
    const input: CreateSliceInput = {
      name: (body.name as string) ?? '',
      sliceType: (body.sliceType as SliceType) ?? 'value',
      description: (body.description as string) ?? '',
      cardIds: (body.cardIds as string[]) ?? [],
      actor: (body.actor as string) ?? '',
      workflow: (body.workflow as string) ?? '',
      verifiableOutcome: (body.verifiableOutcome as string) ?? '',
    };
    const slice = sliceStore.create(projectId, input);
    return reply.status(201).send({ slice });
  });

  app.get('/api/external-projects/:projectId/slices', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;

    const query = request.query as { type?: string };
    const items = query.type
      ? sliceStore.listByType(projectId, query.type as SliceType)
      : sliceStore.listByProject(projectId);
    return reply.send({ slices: items });
  });

  app.get('/api/external-projects/:projectId/slices/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, id } = request.params as { projectId: string; id: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;

    const slice = sliceStore.getById(id);
    if (!slice || slice.projectId !== projectId) {
      return reply.status(404).send({ error: 'Slice not found' });
    }
    return reply.send({ slice });
  });

  app.patch('/api/external-projects/:projectId/slices/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, id } = request.params as { projectId: string; id: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;

    const existing = sliceStore.getById(id);
    if (!existing || existing.projectId !== projectId) {
      return reply.status(404).send({ error: 'Slice not found' });
    }

    const body = request.body as Record<string, unknown>;
    const patch: UpdateSliceInput = {};
    if (body.name !== undefined) (patch as Record<string, unknown>).name = body.name;
    if (body.description !== undefined) (patch as Record<string, unknown>).description = body.description;
    if (body.cardIds !== undefined) (patch as Record<string, unknown>).cardIds = body.cardIds;
    if (body.actor !== undefined) (patch as Record<string, unknown>).actor = body.actor;
    if (body.workflow !== undefined) (patch as Record<string, unknown>).workflow = body.workflow;
    if (body.verifiableOutcome !== undefined)
      (patch as Record<string, unknown>).verifiableOutcome = body.verifiableOutcome;
    if (body.status !== undefined) (patch as Record<string, unknown>).status = body.status;

    const slice = sliceStore.update(id, patch);
    if (!slice) return reply.status(404).send({ error: 'Slice not found' });
    return reply.send({ slice });
  });

  app.patch('/api/external-projects/:projectId/slices/reorder', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;

    const body = request.body as { id1?: string; id2?: string };
    if (!body.id1 || !body.id2) {
      return reply.status(400).send({ error: 'id1 and id2 are required' });
    }

    // Verify both slices belong to this project (cross-project privilege escalation guard)
    const s1 = sliceStore.getById(body.id1);
    const s2 = sliceStore.getById(body.id2);
    if (!s1 || s1.projectId !== projectId || !s2 || s2.projectId !== projectId) {
      return reply.status(404).send({ error: 'One or both slices not found in this project' });
    }

    const ok = sliceStore.reorder(body.id1, body.id2);
    if (!ok) return reply.status(404).send({ error: 'One or both slices not found' });
    return reply.send({ ok: true });
  });

  app.delete('/api/external-projects/:projectId/slices/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, id } = request.params as { projectId: string; id: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;

    const existing = sliceStore.getById(id);
    if (!existing || existing.projectId !== projectId) {
      return reply.status(404).send({ error: 'Slice not found' });
    }

    sliceStore.delete(id);
    return reply.status(204).send();
  });
};
