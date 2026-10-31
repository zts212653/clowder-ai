/**
 * F152 Phase C: Distillation Routes
 * PATCH /api/evidence/:anchor/generalizable — mark item for global reflow
 * POST  /api/distillation/nominate          — nominate candidate
 * POST  /api/distillation/:id/review        — approve/reject candidate
 * GET   /api/distillation/candidates        — list pending candidates
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { DistillationService } from '../domains/memory/distillation-service.js';
import type { IEvidenceStore } from '../domains/memory/interfaces.js';

export interface DistillationRoutesOptions {
  evidenceStore: IEvidenceStore;
  distillationService: DistillationService;
}

const generalizableSchema = z.object({
  generalizable: z.boolean(),
});

const nominateSchema = z.object({
  anchor: z.string().min(1),
  projectPath: z.string().min(1),
  personNames: z.array(z.string()).optional(),
});

const DISTILLABLE_KINDS = new Set(['lesson', 'decision']);

const reviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reviewerId: z.string().min(1),
});

export const distillationRoutes: FastifyPluginAsync<DistillationRoutesOptions> = async (app, opts) => {
  app.patch('/api/evidence/:anchor/generalizable', async (request, reply) => {
    const { anchor } = request.params as { anchor: string };
    const parsed = generalizableSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }

    const item = await opts.evidenceStore.getByAnchor(anchor);
    if (!item) {
      reply.status(404);
      return { error: `Anchor "${anchor}" not found` };
    }

    if (parsed.data.generalizable && !DISTILLABLE_KINDS.has(item.kind)) {
      reply.status(400);
      return { error: `Item kind "${item.kind}" cannot be marked generalizable (allowed: lesson, decision)` };
    }

    await opts.evidenceStore.upsert([{ ...item, generalizable: parsed.data.generalizable }]);
    return { ok: true, anchor, generalizable: parsed.data.generalizable };
  });

  app.post('/api/distillation/nominate', async (request, reply) => {
    const parsed = nominateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }

    try {
      const candidate = await opts.distillationService.nominate(parsed.data.anchor, parsed.data.projectPath, {
        personNames: parsed.data.personNames,
      });
      return { id: candidate.id, status: candidate.status, anchor: candidate.anchor };
    } catch (err) {
      reply.status(400);
      return { error: String((err as Error).message) };
    }
  });

  app.post('/api/distillation/:id/review', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = reviewSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }

    try {
      if (parsed.data.decision === 'approve') {
        await opts.distillationService.approve(id, parsed.data.reviewerId);
      } else {
        await opts.distillationService.reject(id, parsed.data.reviewerId);
      }
      return { ok: true, id, decision: parsed.data.decision };
    } catch (err) {
      reply.status(404);
      return { error: String((err as Error).message) };
    }
  });

  app.get('/api/distillation/candidates', async () => {
    const candidates = await opts.distillationService.listPending();
    return {
      candidates: candidates.map((c) => ({
        id: c.id,
        anchor: c.anchor,
        status: c.status,
        sanitizedTitle: c.evidence.sanitizedTitle,
        nominatedAt: c.nominatedAt,
      })),
    };
  });
};
