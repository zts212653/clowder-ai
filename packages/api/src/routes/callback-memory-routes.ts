import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IEvidenceStore, IMarkerQueue, IReflectionService } from '../domains/memory/interfaces.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

interface CallbackMemoryRoutesDeps {
  /** F102: DI — SQLite-backed services (required) */
  evidenceStore: IEvidenceStore;
  markerQueue: IMarkerQueue;
  reflectionService: IReflectionService;
}

const searchEvidenceQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

const reflectSchema = z.object({
  query: z.string().trim().min(1),
});
const retainMemorySchema = z.object({
  content: z.string().trim().min(1).max(50000),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  metadata: z.record(z.string()).optional(),
});

export async function registerCallbackMemoryRoutes(
  app: FastifyInstance,
  deps: CallbackMemoryRoutesDeps,
): Promise<void> {
  app.get('/api/callbacks/search-evidence', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = searchEvidenceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parsed.error.issues };
    }
    const { q, limit } = parsed.data;

    try {
      const items = await deps.evidenceStore.search(q, { limit: limit ?? 5 });
      const results = items.map((item) => ({
        title: item.title,
        anchor: item.anchor,
        snippet: item.summary ?? '',
        confidence: 'mid' as const,
        sourceType: (item.kind === 'decision' ? 'decision' : item.kind === 'plan' ? 'phase' : 'discussion') as
          | 'decision'
          | 'phase'
          | 'discussion',
      }));
      return { results, degraded: false };
    } catch {
      return { results: [], degraded: true, degradeReason: 'evidence_store_error' };
    }
  });

  app.post('/api/callbacks/reflect', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = reflectSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { query } = parsed.data;

    try {
      const reflection = await deps.reflectionService.reflect(query);
      return { reflection, degraded: false, dispositionMode: 'off' as const };
    } catch {
      return {
        reflection: '',
        degraded: true,
        degradeReason: 'reflection_service_error',
        dispositionMode: 'off' as const,
      };
    }
  });

  app.post('/api/callbacks/retain-memory', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = retainMemorySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { content } = parsed.data;

    try {
      await deps.markerQueue.submit({
        content,
        source: `callback:${record.catId}:${record.invocationId}`,
        status: 'captured',
      });
      return { status: 'ok' };
    } catch {
      return { status: 'degraded', degradeReason: 'marker_queue_error' };
    }
  });
}
