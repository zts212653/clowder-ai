/**
 * F246: Approval Hub aggregation routes.
 *
 * GET /api/approval-hub/pending — query all registered adapters for pending
 * proposals, merge + sort by createdAt desc, return unified ApprovalItem[].
 *
 * GET /api/approval-hub/settled — query all adapters that implement listSettled,
 * merge + sort by decidedAt desc, return SettledApprovalItem[].
 * F246 Phase F: Approval history view (AC-F5).
 *
 * No side effects. No cache. Fresh read-through every call (KD-3 v1).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { IApprovalAdapter } from '../domains/approval-hub/ports/IApprovalAdapter.js';
import { resolveUserId } from '../utils/request-identity.js';

const MAX_SETTLED_LIMIT = 200;
const DEFAULT_SETTLED_LIMIT = 50;

export interface ApprovalHubRoutesOptions {
  adapters: IApprovalAdapter[];
}

export const approvalHubRoutes: FastifyPluginAsync<ApprovalHubRoutesOptions> = async (app, opts) => {
  const { adapters } = opts;

  app.get('/api/approval-hub/pending', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const results = await Promise.all(adapters.map((a) => a.listPending(userId)));
    const items = results.flat().sort((a, b) => b.createdAt - a.createdAt);

    return { items, count: items.length };
  });

  // F246 Phase F: approval history
  app.get('/api/approval-hub/settled', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const query = request.query as Record<string, string>;
    // Cloud P2 fix: floor() before fan-out — non-integer limits sent to Redis ZREVRANGE fail with 500.
    const parsedLimit = Math.floor(Number(query.limit ?? DEFAULT_SETTLED_LIMIT));
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_SETTLED_LIMIT)
        : DEFAULT_SETTLED_LIMIT;

    // Only fan-out to adapters that implement listSettled (AC-F2: optional method)
    const capableAdapters = adapters.filter((a) => typeof a.listSettled === 'function');
    const results = await Promise.all(capableAdapters.map((a) => a.listSettled!(userId, { limit })));
    const items = results
      .flat()
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .slice(0, limit);

    return { items, count: items.length };
  });
};
