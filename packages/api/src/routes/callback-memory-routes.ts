import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IEvidenceStore, IMarkerQueue, IReflectionService } from '../domains/memory/interfaces.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

interface CallbackMemoryRoutesDeps {
  registry: InvocationRegistry;
  /** F102: DI — SQLite-backed services (required) */
  evidenceStore: IEvidenceStore;
  markerQueue: IMarkerQueue;
  reflectionService: IReflectionService;
}

const searchEvidenceQuerySchema = callbackAuthSchema.extend({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

const reflectSchema = callbackAuthSchema.extend({
  query: z.string().trim().min(1),
});
const retainMemorySchema = callbackAuthSchema.extend({
  content: z.string().trim().min(1).max(50000),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  metadata: z.record(z.string()).optional(),
});

export async function registerCallbackMemoryRoutes(
  app: FastifyInstance,
  deps: CallbackMemoryRoutesDeps,
): Promise<void> {
  const { registry } = deps;

  app.get('/api/callbacks/search-evidence', async (request, reply) => {
    const parsed = searchEvidenceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parsed.error.issues };
    }
    const { invocationId, callbackToken, q, limit } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

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
    const parsed = reflectSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { invocationId, callbackToken, query } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

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
    const parsed = retainMemorySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { invocationId, callbackToken, content } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    try {
      await deps.markerQueue.submit({
        content,
        source: `callback:${record.catId}:${invocationId}`,
        status: 'captured',
      });
      return { status: 'ok' };
    } catch {
      return { status: 'degraded', degradeReason: 'marker_queue_error' };
    }
  });
}
