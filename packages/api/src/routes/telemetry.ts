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
import { resolveUserId } from '../utils/request-identity.js';

export interface TelemetryRoutesOptions {
  /** LocalTraceStore ring buffer — injected from initTelemetry(). */
  traceStore: LocalTraceStore | null;
  /** Read Prometheus metrics from in-process registry. */
  getMetricsText?: () => Promise<string>;
}

/**
 * Auth guard — returns userId or sends 401.
 * All telemetry endpoints use this (not the public /ready pattern).
 */
function requireSession(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): string | null {
  const userId = resolveUserId(request);
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
   * GET /api/telemetry/health — aggregated health status.
   * Combines /ready probe info + trace store stats + uptime.
   */
  app.get('/api/telemetry/health', async (request, reply) => {
    if (!requireSession(request, reply)) return;

    const traceStats = opts.traceStore?.stats() ?? null;

    return {
      uptime: process.uptime(),
      traceStore: traceStats,
      otelEnabled: !process.env.OTEL_SDK_DISABLED,
      timestamp: Date.now(),
    };
  });
};
