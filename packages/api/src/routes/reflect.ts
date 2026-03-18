/**
 * Reflect Route
 * POST /api/reflect — LLM-based reflection on stored memories.
 *
 * Phase 5.0: Manual-first reflect (ADR-005 §6).
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IReflectionService } from '../domains/memory/interfaces.js';

const reflectSchema = z.object({
  query: z.string().trim().min(1),
});

export interface ReflectRoutesOptions {
  /** F102: SQLite-backed reflection service — the only backend */
  reflectionService: IReflectionService;
}

export interface ReflectResponse {
  reflection: string;
  degraded: boolean;
  degradeReason?: string;
  dispositionMode: 'off' | 'template_only';
}

export const reflectRoutes: FastifyPluginAsync<ReflectRoutesOptions> = async (app, opts) => {
  app.post('/api/reflect', async (request, reply) => {
    const parseResult = reflectSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { query } = parseResult.data;

    try {
      const reflection = await opts.reflectionService.reflect(query);
      return { reflection, degraded: false, dispositionMode: 'off' as const } satisfies ReflectResponse;
    } catch {
      return {
        reflection: '',
        degraded: true,
        degradeReason: 'reflection_service_error',
        dispositionMode: 'off' as const,
      } satisfies ReflectResponse;
    }
  });
};
