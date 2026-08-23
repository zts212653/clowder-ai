import { isRecallResultStatus } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { CrossCatMetricsComputer } from '../domains/memory/CrossCatMetricsComputer.js';
import { freezeF200Flags } from '../domains/memory/f200-types.js';
import { LifecycleTraceStore } from '../domains/memory/LifecycleTraceStore.js';
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
    Querystring: { days?: string; catId?: string; invocationId?: string; verified?: string; limit?: string };
  }>('/api/recall/trajectories', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const days = Math.min(Math.max(1, parseInt(request.query.days ?? '30', 10) || 30), 90);
    const catId = request.query.catId || undefined;
    const invocationId = request.query.invocationId || undefined;
    const verified = request.query.verified === 'true' ? true : request.query.verified === 'false' ? false : undefined;
    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '20', 10) || 20), 100);

    return { trajectories: trajectoryService.listRecent({ days, catId, invocationId, verified, limit }) };
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
              candidates_json, consumed_json, result_count, result_status, timestamp,
              source, push_surface, presented, inspected, outcome
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
      consumed_json: string;
      result_count: number | null;
      result_status: string | null;
      timestamp: number;
      source: string;
      push_surface: string | null;
      presented: number;
      inspected: number;
      outcome: string | null;
    }>;

    return {
      events: rows.map((r) => {
        const candidates = JSON.parse(r.candidates_json || '[]') as Array<{ anchor: string; docKind?: string }>;
        const consumed = JSON.parse(r.consumed_json || '[]') as Array<{ anchor: string }>;
        const consumedAnchors = new Set(consumed.map((c) => c.anchor));
        const resultStatus = isRecallResultStatus(r.result_status)
          ? r.result_status
          : r.result_count != null
            ? r.result_count === 0
              ? 'no_results'
              : 'counted'
            : 'legacy_unknown';
        const resultCount = resultStatus === 'legacy_unknown' ? undefined : (r.result_count ?? undefined);
        return {
          id: r.recall_id,
          toolName: r.tool_name,
          query: r.query,
          mode: r.mode ?? undefined,
          scope: r.scope ?? undefined,
          timestamp: r.timestamp,
          source: r.source,
          ...(r.push_surface ? { pushSurface: r.push_surface } : {}),
          presented: r.presented === 1,
          inspected: r.inspected === 1,
          outcome: r.outcome ?? (r.inspected === 1 ? 'used' : 'ignored'),
          ...(resultCount != null ? { resultCount } : {}),
          resultStatus,
          results: candidates.map((c) => ({
            title: c.anchor,
            anchor: c.anchor,
            sourceType: c.docKind,
            consumed: consumedAnchors.has(c.anchor),
          })),
        };
      }),
    };
  });

  // ── F263 Phase C lifecycle endpoints ─────────────────────────────
  // All three endpoints enforce the same thread-scoped access model as
  // /api/recall/ledger: fail-closed without threadStore, scoped to
  // the caller's accessible threads only.

  /** Resolve the calling user's accessible thread IDs. Fail-closed. */
  async function resolveUserThreadIds(
    userId: string,
    reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  ): Promise<string[] | null> {
    if (!opts.threadStore) {
      reply.status(503).send({ error: 'Thread store unavailable' });
      return null;
    }
    const userThreads = await opts.threadStore.list(userId);
    return userThreads.map((t) => t.id);
  }

  // F263 Phase C: three-axis lifecycle snapshot
  app.get<{
    Querystring: { days?: string };
  }>('/api/recall/lifecycle/three-axis', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const threadIds = await resolveUserThreadIds(userId, reply);
    if (threadIds === null) return; // 503 already sent

    const days = Math.min(Math.max(1, parseInt(request.query.days ?? '7', 10) || 7), 90);

    if (threadIds.length === 0) {
      const now = Date.now();
      return {
        harmfulConsumption: { value: 0, maturity: 'no-data', reason: '无可访问的 thread。' },
        unmetDemandLowerBound: { value: 0, maturity: 'no-data', reason: '无可访问的 thread。' },
        attentionCost: { value: 0, maturity: 'no-data', reason: '无可访问的 thread。' },
        days,
        from: now - days * 86400000,
        to: now,
      };
    }

    try {
      const traceStore = new LifecycleTraceStore(opts.evidenceDb);
      return traceStore.computeThreeAxis(days, threadIds);
    } catch {
      // V33 migration may not be applied yet — return no-data
      return {
        harmfulConsumption: { value: 0, maturity: 'no-data', reason: 'lifecycle_traces 表尚未初始化。' },
        unmetDemandLowerBound: { value: 0, maturity: 'no-data', reason: 'lifecycle_traces 表尚未初始化。' },
        attentionCost: { value: 0, maturity: 'no-data', reason: 'lifecycle_traces 表尚未初始化。' },
        days,
        from: Date.now() - days * 86400000,
        to: Date.now(),
      };
    }
  });

  // F263 Phase C: verification events query
  app.get<{
    Querystring: { target?: string; days?: string; limit?: string };
  }>('/api/recall/lifecycle/verification-events', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const threadIds = await resolveUserThreadIds(userId, reply);
    if (threadIds === null) return;

    const days = Math.min(Math.max(1, parseInt(request.query.days ?? '30', 10) || 30), 90);
    const now = Date.now();
    const from = now - days * 86400000;
    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '50', 10) || 50), 500);
    const target = request.query.target || undefined;

    if (threadIds.length === 0) return { events: [], days, from, to: now };

    try {
      const traceStore = new LifecycleTraceStore(opts.evidenceDb);
      const events = traceStore.getVerificationEvents({
        targetAnchor: target,
        threadIds,
        from,
        to: now,
        limit,
      });
      return { events, days, from, to: now };
    } catch {
      return { events: [], days, from, to: now };
    }
  });

  // F263 Phase C: lifecycle traces query (for drill-down)
  app.get<{
    Querystring: { kind?: string; category?: string; sourceFamily?: string; days?: string; limit?: string };
  }>('/api/recall/lifecycle/traces', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const threadIds = await resolveUserThreadIds(userId, reply);
    if (threadIds === null) return;

    const days = Math.min(Math.max(1, parseInt(request.query.days ?? '30', 10) || 30), 90);
    const now = Date.now();
    const from = now - days * 86400000;
    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '50', 10) || 50), 500);

    if (threadIds.length === 0) return { traces: [], days, from, to: now };

    try {
      const traceStore = new LifecycleTraceStore(opts.evidenceDb);
      const traces = traceStore.query({
        kind: request.query.kind as
          | 'harmful_consumption'
          | 'unmet_demand'
          | 'verification'
          | 'attention_cost'
          | undefined,
        category: request.query.category || undefined,
        sourceFamily: request.query.sourceFamily as
          | 'search_evidence'
          | 'graph_resolve'
          | 'list_recent'
          | 'session_bootstrap'
          | 'cold_context'
          | undefined,
        threadIds,
        from,
        to: now,
        limit,
      });
      return { traces, days, from, to: now };
    } catch {
      return { traces: [], days, from, to: now };
    }
  });

  // F263 B.5 Task 4: consumption ledger — stateless aggregate over recall_events
  // Thread-scoped: only aggregates events from threads the caller can access.
  app.get<{
    Querystring: { days?: string };
  }>('/api/recall/ledger', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const days = Math.min(Math.max(1, parseInt(request.query.days ?? '7', 10) || 7), 90);
    const now = Date.now();
    const from = now - days * 24 * 60 * 60 * 1000;

    // Fail closed: require threadStore to scope by user's accessible threads
    if (!opts.threadStore) {
      return reply.status(503).send({ error: 'Thread store unavailable' });
    }
    const userThreads = await opts.threadStore.list(userId);
    const threadIds = userThreads.map((t) => t.id);
    if (threadIds.length === 0) {
      return { days, from, to: now, rows: [] };
    }

    const placeholders = threadIds.map(() => '?').join(', ');
    const rows = opts.evidenceDb
      .prepare(
        `SELECT
           source,
           COALESCE(push_surface, tool_name) AS surface,
           COUNT(*) AS presented,
           SUM(inspected) AS inspected,
           SUM(CASE WHEN outcome = 'used' THEN 1 ELSE 0 END) AS used
         FROM recall_events
         WHERE timestamp >= ? AND thread_id IN (${placeholders})
         GROUP BY source, COALESCE(push_surface, tool_name)
         ORDER BY source DESC, presented DESC`,
      )
      .all(from, ...threadIds) as Array<{
      source: string;
      surface: string;
      presented: number;
      inspected: number;
      used: number;
    }>;

    return {
      days,
      from,
      to: now,
      rows: rows.map((r) => ({
        source: r.source as 'push' | 'pull',
        surface: r.surface,
        presented: r.presented,
        inspected: r.inspected,
        used: r.used,
      })),
    };
  });
};
