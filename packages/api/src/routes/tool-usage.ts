/**
 * Tool Usage Routes — F150 (#339)
 * GET /api/usage/tools — 按天×猫聚合 tool/skill/MCP 调用次数。
 */

import type { FastifyPluginAsync } from 'fastify';
import type { ToolCategory } from '../domains/cats/services/tool-usage/classify.js';
import type { ToolUsageCounter, ToolUsageReport } from '../domains/cats/services/tool-usage/ToolUsageCounter.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface ToolUsageRoutesOptions {
  toolUsageCounter: ToolUsageCounter;
}

/** In-memory cache with TTL. */
interface CacheEntry {
  key: string;
  report: ToolUsageReport;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cacheMap = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 20;

/** @internal — exposed for testing */
export function clearToolUsageCache(): void {
  cacheMap.clear();
}

const VALID_CATEGORIES = new Set<string>(['native', 'mcp', 'skill', 'all']);

export const toolUsageRoutes: FastifyPluginAsync<ToolUsageRoutesOptions> = async (app, opts) => {
  app.get<{
    Querystring: { days?: string; catId?: string; category?: string; refresh?: string };
  }>('/api/usage/tools', async (request, reply) => {
    // Auth: require identity header (consistent with /api/usage/daily)
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });
    }

    const counter = opts.toolUsageCounter;

    const daysParam = request.query.days;
    // days=0 means "all-time" (Redis + archive); otherwise clamp to 1–90
    const rawDays = daysParam ? parseInt(daysParam, 10) : 7;
    const days = rawDays === 0 ? 0 : Math.min(Math.max(1, rawDays || 7), 90);
    const catId = request.query.catId || undefined;
    const categoryParam = request.query.category || 'all';
    const forceRefresh = request.query.refresh === '1';

    if (!VALID_CATEGORIES.has(categoryParam)) {
      return reply
        .status(400)
        .send({ error: `Invalid category: ${categoryParam}. Must be native, mcp, skill, or all.` });
    }

    const category: ToolCategory | undefined = categoryParam === 'all' ? undefined : (categoryParam as ToolCategory);
    const cacheKey = `tools:${days}:${catId ?? ''}:${categoryParam}`;

    if (!forceRefresh) {
      const cached = cacheMap.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.report;
      }
    }

    const report = await counter.aggregate(days, { catId, category });

    if (cacheMap.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = cacheMap.keys().next().value as string;
      cacheMap.delete(oldestKey);
    }
    cacheMap.set(cacheKey, { key: cacheKey, report, expiresAt: Date.now() + CACHE_TTL_MS });

    return report;
  });
};
