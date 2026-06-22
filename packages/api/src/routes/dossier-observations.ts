/**
 * F208 Phase D: Dossier Observation API Routes
 *
 * POST /api/dossier/observations — operator adds observation (AC-D1)
 * GET  /api/dossier/observations — list observations (all or per cat)
 *
 * Owner-gated write (only operator can add observations).
 * OQ-10: Phase D = staging + read display; promotion to summary layer in Phase E.
 * AC-D3: Observations do NOT replace summary layer (peer/operator judgment + provenance).
 *
 * Split from GET /api/dossier intentionally (opus-47 design review):
 *   - /api/dossier = file-based static, cache-friendly
 *   - /api/dossier/observations = Redis-backed runtime state, different lifecycle
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { IDossierObservationStore } from '../domains/cats/services/stores/ports/DossierObservationStore.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

export interface DossierObservationRoutesOptions {
  observationStore: IDossierObservationStore;
}

export const dossierObservationRoutes: FastifyPluginAsync<DossierObservationRoutesOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const store = opts.observationStore;

  // POST /api/dossier/observations — add a operator observation
  app.post('/api/dossier/observations', async (request, reply) => {
    const body = request.body as { catId?: string; content?: string } | null;

    if (!body?.catId || typeof body.catId !== 'string') {
      reply.status(400);
      return { error: 'catId is required' };
    }
    if (!body?.content || typeof body.content !== 'string' || body.content.trim() === '') {
      reply.status(400);
      return { error: 'content is required and must be non-empty' };
    }

    // Strict auth: browser-without-session → null (no defaultUserId fallback).
    // Prevents unauthenticated browser callers from writing TTL=0 user data.
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Authentication required to add observations' };
    }
    const ownerError = resolveOwnerGate(userId, {
      errorMessage: 'Only the operator can add dossier observations',
    });
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }
    const author = userId;

    const observation = await store.add({
      catId: body.catId,
      content: body.content.trim(),
      author,
    });

    reply.status(201);
    return { observation };
  });

  // GET /api/dossier/observations — list observations
  // ?catId=opus → returns { observations: DossierObservation[] } for that cat
  // (no catId)  → returns { observations: Record<string, DossierObservation[]> } grouped
  app.get('/api/dossier/observations', async (request) => {
    const query = request.query as { catId?: string; limit?: string };

    const limit = query.limit ? Math.min(Math.max(1, Number.parseInt(query.limit, 10) || 100), 100) : 100;

    if (query.catId) {
      const observations = await store.list(query.catId, limit);
      return { observations };
    }

    const observations = await store.listAll(limit);
    return { observations };
  });
};
