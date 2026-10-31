import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { ILabelStore, IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface LabelsRoutesOptions {
  labelStore: ILabelStore;
  threadStore?: IThreadStore;
}

const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(20),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sortOrder: z.number().int().min(0).optional(),
});

const updateLabelSchema = z
  .object({
    name: z.string().trim().min(1).max(20).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((d) => d.name !== undefined || d.color !== undefined || d.sortOrder !== undefined, {
    message: 'At least one field must be provided',
  });

export const labelsRoutes: FastifyPluginAsync<LabelsRoutesOptions> = async (app, opts) => {
  const { labelStore } = opts;

  app.post('/api/labels', async (request, reply) => {
    const parseResult = createLabelSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const userId = resolveUserId(request, { defaultUserId: 'default-user' }) ?? 'default-user';
    const { name, color, sortOrder } = parseResult.data;

    const label = await labelStore.create({
      id: nanoid(12),
      name,
      color,
      sortOrder: sortOrder ?? 0,
      createdBy: userId,
      createdAt: Date.now(),
    });

    reply.status(201);
    return label;
  });

  app.get('/api/labels', async (request) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' }) ?? 'default-user';
    return labelStore.list(userId);
  });

  app.patch('/api/labels/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = updateLabelSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const userId = resolveUserId(request, { defaultUserId: 'default-user' }) ?? 'default-user';
    const updated = await labelStore.update(id, userId, parseResult.data);
    if (!updated) {
      reply.status(404);
      return { error: 'Label not found' };
    }

    return updated;
  });

  app.delete('/api/labels/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = resolveUserId(request, { defaultUserId: 'default-user' }) ?? 'default-user';

    const ok = await labelStore.delete(id, userId);
    if (!ok) {
      reply.status(404);
      return { error: 'Label not found' };
    }

    if (opts.threadStore) {
      const active = await opts.threadStore.list(userId);
      const trashed = await opts.threadStore.listDeleted(userId);
      for (const thread of [...active, ...trashed]) {
        if (thread.labels?.includes(id)) {
          const updated = thread.labels.filter((lid) => lid !== id);
          await opts.threadStore.updateLabels(thread.id, updated);
        }
      }
    }

    return { ok: true };
  });
};
