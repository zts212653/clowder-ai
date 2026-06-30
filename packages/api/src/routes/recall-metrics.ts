import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { CrossCatMetricsComputer } from '../domains/memory/CrossCatMetricsComputer.js';
import { freezeF200Flags } from '../domains/memory/f200-types.js';
import { OutputVerifiedDetector } from '../domains/memory/output-verified-detector.js';
import { RecallMetricsComputer } from '../domains/memory/RecallMetricsComputer.js';
import { SqliteSignalSources } from '../domains/memory/SqliteSignalSources.js';
import {
  type SignalMessageStore,
  type SignalTaskStore,
  ThreadAwareSignalSources,
} from '../domains/memory/ThreadAwareSignalSources.js';
import { TrajectoryQueryService } from '../domains/memory/TrajectoryQueryService.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface RecallMetricsRoutesOptions {
  evidenceDb: Database.Database;
  /** Optional: pass messageStore + taskStore to enable AC-D2.1/D2.2/D2.3 auto-detection. */
  messageStore?: SignalMessageStore;
  taskStore?: SignalTaskStore;
  /** Optional: pass threadStore to enable thread ownership validation on /api/recall/events. */
  threadStore?: Pick<IThreadStore, 'get' | 'list'>;
}

interface CacheEntry {
  key: string;
  data: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();
const MAX_CACHE = 20;

export function clearRecallMetricsCache(): void {
  cache.clear();
}

async function isThreadIndexedForUser(
  threadStore: Pick<IThreadStore, 'list'>,
  threadId: string,
  userId: string,
): Promise<boolean> {
  const userVisibleThreads = await threadStore.list(userId);
  return userVisibleThreads.some((visibleThread) => visibleThread.id === threadId);
}

export const recallMetricsRoutes: FastifyPluginAsync<RecallMetricsRoutesOptions> = async (app, opts) => {
  const computer = new RecallMetricsComputer(opts.evidenceDb);
  const trajectoryService = new TrajectoryQueryService(opts.evidenceDb);
  const crossCatComputer = new CrossCatMetricsComputer(opts.evidenceDb);

  app.get<{
    Querystring: { days?: string; catId?: string; toolName?: string; refresh?: string };
  }>('/api/recall/metrics', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const days = Math.min(Math.max(1, parseInt(request.query.days ?? '30', 10) || 30), 90);
    const catId = request.query.catId || undefined;
    const toolName = request.query.toolName || undefined;
    const forceRefresh = request.query.refresh === '1';
    const cacheKey = `recall:${days}:${catId ?? ''}:${toolName ?? ''}`;

    if (!forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.data;
    }

    const report = computer.computeMetrics({ days, catId, toolName });

    if (cache.size >= MAX_CACHE) {
      const oldestKey = cache.keys().next().value as string;
      cache.delete(oldestKey);
    }
    cache.set(cacheKey, { key: cacheKey, data: report, expiresAt: Date.now() + CACHE_TTL_MS });
    return report;
  });

  app.get<{
    Querystring: { limit?: string; dormancyThreshold?: string; refresh?: string };
  }>('/api/recall/anchors', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const forceRefresh = request.query.refresh === '1';
    if (forceRefresh) computer.refreshAnchorMetrics();

    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '20', 10) || 20), 100);
    const threshold = parseInt(request.query.dormancyThreshold ?? '0', 10);

    if (threshold > 0) {
      return { anchors: computer.getDormantAnchors(threshold, limit) };
    }
    return { anchors: computer.getPopularAnchors(limit) };
  });

  app.get('/api/recall/flags', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });
    return { f200: freezeF200Flags() };
  });

  app.post('/api/recall/anchors/refresh', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    computer.refreshAnchorMetrics();
    return { status: 'ok' };
  });

  app.get<{
    Querystring: { days?: string };
  }>('/api/recall/metrics/cross-cat', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const days = Math.min(Math.max(1, parseInt(request.query.days ?? '30', 10) || 30), 90);
    return crossCatComputer.compute(days);
  });

  app.get<{
    Querystring: { days?: string; catId?: string; verified?: string; limit?: string };
  }>('/api/recall/trajectories', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const days = Math.min(Math.max(1, parseInt(request.query.days ?? '30', 10) || 30), 90);
    const catId = request.query.catId || undefined;
    const verified = request.query.verified === 'true' ? true : request.query.verified === 'false' ? false : undefined;
    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '20', 10) || 20), 100);

    return { trajectories: trajectoryService.listRecent({ days, catId, verified, limit }) };
  });

  app.post<{
    Querystring: { days?: string };
  }>('/api/recall/trajectories/verify-pending', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const days = Math.min(Math.max(1, parseInt(request.query.days ?? '30', 10) || 30), 90);
    const unverified = trajectoryService.listRecent({ verified: false, days, limit: 100, oldestFirst: true });
    // AC-D2: Use ThreadAwareSignalSources when messageStore + taskStore are available;
    // fall back to SqliteSignalSources (v1 behavior) otherwise.
    const sources =
      opts.messageStore && opts.taskStore
        ? new ThreadAwareSignalSources(opts.evidenceDb, opts.messageStore, opts.taskStore)
        : new SqliteSignalSources(opts.evidenceDb);
    const detector = new OutputVerifiedDetector(sources);

    let verifiedCount = 0;
    for (const t of unverified) {
      const result = await detector.detect(t.invocationId, t.threadId);
      if (result.verified) {
        trajectoryService.markVerified(t.trajectoryId, result.signals);
        verifiedCount++;
      }
    }

    return { checked: unverified.length, verified: verifiedCount };
  });

  const VALID_SIGNALS = new Set(['pr_merged', 'cvo_accepted', 'reviewer_approved', 'ci_passed']);

  app.post<{
    Params: { trajectoryId: string };
    Body: { signals: string[] };
  }>('/api/recall/trajectories/:trajectoryId/signals', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { trajectoryId } = request.params;
    const { signals } = request.body ?? {};
    if (!Array.isArray(signals) || signals.length === 0) {
      return reply.status(400).send({ error: 'signals must be a non-empty string array' });
    }

    const invalid = signals.filter((s) => !VALID_SIGNALS.has(s));
    if (invalid.length > 0) {
      return reply
        .status(400)
        .send({ error: `Invalid signals: ${invalid.join(', ')}. Valid: ${[...VALID_SIGNALS].join(', ')}` });
    }

    const existing = trajectoryService.getById(trajectoryId);
    if (!existing) {
      return reply.status(404).send({ error: `Trajectory ${trajectoryId} not found` });
    }

    trajectoryService.markVerified(trajectoryId, signals);
    return { status: 'ok', trajectoryId, signals };
  });

  // F102 bugfix: RecallFeed history — query recall_events by threadId
  // so the UI can show recall history beyond the HISTORY_PAGE_SIZE message window.
  app.get<{
    Querystring: { threadId: string; limit?: string };
  }>('/api/recall/events', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const threadId = request.query.threadId;
    if (!threadId) return reply.status(400).send({ error: 'threadId is required' });

    // Thread ownership guard: fail-closed — require threadStore
    if (!opts.threadStore) {
      return reply.status(503).send({ error: 'Thread store unavailable' });
    }
    const thread = await opts.threadStore.get(threadId);
    if (!thread) return reply.status(404).send({ error: 'Thread not found' });
    const canReadRecallEvents =
      canAccessThread(thread, userId) ||
      (thread.createdBy === 'system' && (await isThreadIndexedForUser(opts.threadStore, thread.id, userId)));
    if (!canReadRecallEvents) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '100', 10) || 100), 500);

    const rows = opts.evidenceDb
      .prepare(
        `SELECT recall_id, cat_id, tool_name, query, mode, scope,
              candidates_json, result_count, timestamp
       FROM recall_events
       WHERE thread_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      )
      .all(threadId, limit) as Array<{
      recall_id: string;
      cat_id: string;
      tool_name: string;
      query: string;
      mode: string | null;
      scope: string | null;
      candidates_json: string;
      result_count: number | null;
      timestamp: number;
    }>;

    return {
      events: rows.map((r) => {
        const candidates = JSON.parse(r.candidates_json || '[]') as Array<{ anchor: string; docKind?: string }>;
        const resultCount = r.result_count ?? (candidates.length > 0 ? candidates.length : undefined);
        return {
          id: r.recall_id,
          toolName: r.tool_name,
          query: r.query,
          mode: r.mode ?? undefined,
          scope: r.scope ?? undefined,
          timestamp: r.timestamp,
          ...(resultCount != null ? { resultCount } : {}),
          results: candidates.map((c) => ({
            title: c.anchor,
            anchor: c.anchor,
            sourceType: c.docKind,
          })),
        };
      }),
    };
  });
};
