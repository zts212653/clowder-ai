/**
 * F246: Approval Hub aggregation route.
 *
 * GET /api/approval-hub/pending — query all registered adapters for pending
 * proposals, merge + sort by createdAt desc, return unified ApprovalItem[].
 * No side effects. No cache. Fresh read-through every call (KD-3 v1).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { IApprovalAdapter } from '../domains/approval-hub/ports/IApprovalAdapter.js';
import { resolveUserId } from '../utils/request-identity.js';

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
};
