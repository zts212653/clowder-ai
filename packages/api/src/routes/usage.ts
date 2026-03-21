/**
 * Usage Routes — F051 daily consumption
 * GET /api/usage/daily — 按日 × 猫聚合 token 消耗报表
 *
 * Auth: requires X-Cat-Cafe-User identity header.
 * Data is scoped to the requesting user's invocations.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import { aggregateUsageByDay, type DailyUsageReport } from '../domains/cats/services/usage-aggregator.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface UsageRoutesOptions {
  invocationRecordStore: IInvocationRecordStore;
}

/** Simple in-memory response cache with TTL, keyed by userId+days+catId */
interface CacheEntry {
  key: string;
  report: DailyUsageReport;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const cacheMap = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 20;

/** @internal — exposed for testing */
export function clearUsageCache(): void {
  cacheMap.clear();
}

export const usageRoutes: FastifyPluginAsync<UsageRoutesOptions> = async (app, opts) => {
  app.get<{
    Querystring: { days?: string; catId?: string; refresh?: string };
  }>('/api/usage/daily', async (request, reply) => {
    const store = opts.invocationRecordStore;

    if (typeof store.scanAll !== 'function') {
      return reply.status(501).send({
        error: 'Usage aggregation requires Redis-backed invocation store (scanAll not available)',
      });
    }

    // Header-only auth: no query param fallback, no default-user fallback
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });
    }

    const daysParam = request.query.days;
    const days = daysParam ? Math.min(Math.max(1, parseInt(daysParam, 10) || 7), 7) : 7;
    const catId = request.query.catId || undefined;
    const forceRefresh = request.query.refresh === '1';
    const cacheKey = `${userId}:${days}:${catId ?? ''}`;

    // Return cached response if valid (unless force refresh)
    const cached = cacheMap.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.report;
    }

    const allRecords = await store.scanAll();
    // Filter to requesting user's invocations only
    const userRecords = allRecords.filter((r) => r.userId === userId);
    const report = aggregateUsageByDay(userRecords, { days, catId });

    // Evict oldest if cache is full
    if (cacheMap.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = cacheMap.keys().next().value as string;
      cacheMap.delete(oldestKey);
    }
    cacheMap.set(cacheKey, { key: cacheKey, report, expiresAt: Date.now() + CACHE_TTL_MS });

    return report;
  });
};
