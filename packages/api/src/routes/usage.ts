/**
 * Usage Routes — F128
 * GET /api/usage/daily — 按日 × 猫聚合 token 消耗报表
 */

import type { FastifyPluginAsync } from 'fastify';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import { aggregateUsageByDay } from '../domains/cats/services/usage-aggregator.js';

export interface UsageRoutesOptions {
  invocationRecordStore: IInvocationRecordStore;
}

export const usageRoutes: FastifyPluginAsync<UsageRoutesOptions> = async (app, opts) => {
  app.get<{
    Querystring: { days?: string; catId?: string };
  }>('/api/usage/daily', async (request, reply) => {
    const store = opts.invocationRecordStore;

    if (typeof store.scanAll !== 'function') {
      return reply.status(501).send({
        error: 'Usage aggregation requires Redis-backed invocation store (scanAll not available)',
      });
    }

    const daysParam = request.query.days;
    const days = daysParam ? Math.min(Math.max(1, parseInt(daysParam, 10) || 7), 7) : 7;
    const catId = request.query.catId || undefined;

    const records = await store.scanAll();
    const report = aggregateUsageByDay(records, { days, catId });

    return report;
  });
};
