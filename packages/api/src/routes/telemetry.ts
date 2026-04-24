/**
 * F153 Phase E: Telemetry API routes for Hub embedded observability.
 *
 * All endpoints require session/cookie authentication (AC-E5).
 * Trace queries HMAC raw IDs before matching the pseudonymized store (AC-E4).
 *
 * Design boundary: descriptive observability only — shows "what happened",
 * no quality scores or normative eval signals.
 */

import type { FastifyPluginAsync } from 'fastify';
import { hmacId } from '../infrastructure/telemetry/hmac.js';
import type { LocalTraceStore } from '../infrastructure/telemetry/local-trace-store.js';
import type { MetricsSnapshotStore } from '../infrastructure/telemetry/metrics-snapshot-store.js';
import { parsePrometheusText } from '../infrastructure/telemetry/metrics-snapshot-store.js';

export interface ReadinessResult {
  status: 'ready' | 'degraded';
  checks: Record<string, { ok: boolean; ms: number; error?: string }>;
}

export interface TelemetryRoutesOptions {
  /** LocalTraceStore ring buffer — injected from initTelemetry(). */
  traceStore: LocalTraceStore | null;
  /** Read Prometheus metrics from in-process registry. */
  getMetricsText?: () => Promise<string>;
  /** MetricsSnapshotStore for time-series trend data. */
  metricsSnapshotStore?: MetricsSnapshotStore | null;
  /** Readiness probe — same checks as /ready. */
  checkReadiness?: () => Promise<ReadinessResult>;
}

/**
 * Auth guard — returns userId or sends 401.
 * All telemetry endpoints use this (not the public /ready pattern).
 */
function requireSession(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): string | null {
  const userId = (request as import('fastify').FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

export const telemetryRoutes: FastifyPluginAsync<TelemetryRoutesOptions> = async (app, opts) => {
  /**
   * GET /api/telemetry/traces — query recent trace spans from ring buffer.
   *
   * Query params (all optional):
   *   traceId       — OTel trace ID (hex, matched directly)
   *   invocationId  — raw ID, HMAC'd before matching store
   *   catId         — agent.id (Class D, matched directly)
   *   limit         — max results (default 100, max 500)
   */
  app.get<{
    Querystring: {
      traceId?: string;
      invocationId?: string;
      catId?: string;
      limit?: string;
    };
  }>('/api/telemetry/traces', async (request, reply) => {
    if (!requireSession(request, reply)) return;

    if (!opts.traceStore) {
      return reply.status(503).send({ error: 'Trace store not available (OTel may be disabled)' });
    }

    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '100', 10) || 100), 500);

    const spans = opts.traceStore.query({
      traceId: request.query.traceId || undefined,
      // HMAC raw invocationId before matching pseudonymized store
      invocationId: request.query.invocationId ? hmacId(request.query.invocationId) : undefined,
      catId: request.query.catId || undefined,
      limit,
    });

    return { spans, count: spans.length };
  });

  /**
   * GET /api/telemetry/traces/stats — ring buffer diagnostics.
   */
  app.get('/api/telemetry/traces/stats', async (request, reply) => {
    if (!requireSession(request, reply)) return;

    if (!opts.traceStore) {
      return reply.status(503).send({ error: 'Trace store not available' });
    }

    return opts.traceStore.stats();
  });

  /**
   * GET /api/telemetry/metrics — read Prometheus metrics from in-process registry.
   * Returns raw Prometheus text format (for frontend parsing or direct display).
   */
  app.get('/api/telemetry/metrics', async (request, reply) => {
    if (!requireSession(request, reply)) return;

    if (!opts.getMetricsText) {
      return reply.status(503).send({ error: 'Metrics reader not available' });
    }

    const text = await opts.getMetricsText();
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(text);
  });

  /**
   * GET /api/telemetry/metrics/history — time-series metrics snapshots.
   *
   * Query params (all optional):
   *   since — epoch ms cutoff (default: return all)
   *   limit — max results (default 720, max 720)
   */
  app.get<{
    Querystring: { since?: string; limit?: string };
  }>('/api/telemetry/metrics/history', async (request, reply) => {
    if (!requireSession(request, reply)) return;

    if (!opts.metricsSnapshotStore) {
      return reply.status(503).send({ error: 'Metrics snapshot store not available' });
    }

    const since = request.query.since ? parseInt(request.query.since, 10) || undefined : undefined;
    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '720', 10) || 720), 720);

    const snapshots = opts.metricsSnapshotStore.query(since, limit);
    return { snapshots, count: snapshots.length };
  });

  /**
   * GET /api/telemetry/health — aggregated health verdict.
   * Combines readiness probe + trace/metrics store stats + recent error rate.
   */
  app.get('/api/telemetry/health', async (request, reply) => {
    if (!requireSession(request, reply)) return;

    const readiness = opts.checkReadiness ? await opts.checkReadiness() : null;
    const traceStats = opts.traceStore?.stats() ?? null;
    const snapshotStats = opts.metricsSnapshotStore?.stats() ?? null;
    const errorRate = await computeRecentErrorRate(opts.getMetricsText);

    const otelEnabled = !process.env.OTEL_SDK_DISABLED;
    const readinessOk = !readiness || readiness.status === 'ready';
    const threshold = Number.parseFloat(process.env.TELEMETRY_ALERT_ERROR_RATE ?? '0.3');
    const errorRateOk = errorRate === null || errorRate < threshold;
    const healthy = readinessOk && errorRateOk;

    if (!healthy) reply.code(503);
    return {
      status: healthy ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      otelEnabled,
      readiness: readiness ?? undefined,
      errorRate,
      traceStore: traceStats,
      metricsSnapshotStore: snapshotStats,
      timestamp: Date.now(),
    };
  });
};

async function computeRecentErrorRate(getMetricsText?: () => Promise<string>): Promise<number | null> {
  if (!getMetricsText) return null;
  try {
    const text = await getMetricsText();
    const metrics = parsePrometheusText(text);
    let okTotal = 0;
    let errorTotal = 0;
    for (const [key, value] of Object.entries(metrics)) {
      if (!key.startsWith('cat_cafe_invocation_completed')) continue;
      if (key.includes('status="ok"')) okTotal += value;
      else if (key.includes('status="error"')) errorTotal += value;
    }
    const total = okTotal + errorTotal;
    if (total === 0) return null;
    return errorTotal / total;
  } catch {
    return null;
  }
}
