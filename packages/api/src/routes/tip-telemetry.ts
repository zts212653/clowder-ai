/**
 * F268 capability-tips telemetry ingress.
 *
 * Validates authenticated batches, enforces the seven-day delivery window,
 * delegates atomic receipt/aggregate writes to a durable sink, and returns an
 * idempotent acknowledgement. No raw event body is persisted server-side.
 */

import type { TipEventBatchAck } from '@cat-cafe/shared';
import { TIP_MAX_AGE_MS, TipEventBatchSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type {
  CapabilityTipsUsageRow,
  CapabilityTipsUsageSelector,
} from '../infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js';
import { summarizeTipDemos } from './tip-demo-summary.js';
import type { ITipEventSink } from './tip-telemetry-sink.js';

export type {
  IngestResult,
  IngestStatus,
  ITipEventSink,
  TipTelemetryRedisLike,
} from './tip-telemetry-sink.js';
export {
  computePayloadDigest,
  InMemoryTipEventSink,
  RedisTipEventSink,
  UnavailableTipEventSink,
} from './tip-telemetry-sink.js';

export interface TipTelemetryRoutesOptions {
  sink: ITipEventSink;
  /** Injectable clock for boundary tests; production defaults to Date.now. */
  now?: () => number;
  readUsage?: (selector: CapabilityTipsUsageSelector) => Promise<{ rows: readonly CapabilityTipsUsageRow[] }>;
}

const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function rejectedBatchId(body: unknown): string {
  return typeof body === 'object' && body !== null && 'batchId' in body
    ? String((body as Record<string, unknown>).batchId)
    : 'unknown';
}

export const tipTelemetryRoutes: FastifyPluginAsync<TipTelemetryRoutesOptions> = async (app, options) => {
  app.get<{ Querystring: { days?: string } }>('/api/tip-telemetry/demos', async (request, reply) => {
    const userId = (request as import('fastify').FastifyRequest & { sessionUserId?: string }).sessionUserId;
    if (!userId) return reply.status(401).send({ error: 'Session required' });
    const days = request.query.days === undefined ? 7 : Number(request.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 90)
      return reply.status(400).send({ error: 'days must be an integer from 1 to 90' });
    if (!options.readUsage) return reply.status(503).send({ error: 'Tip telemetry service temporarily unavailable' });
    const dayMs = 86400000;
    const endMs = Math.floor((options.now?.() ?? Date.now()) / dayMs) * dayMs + dayMs;
    const selector = {
      kind: 'capability-tips-usage-window' as const,
      windowStartMs: endMs - days * dayMs,
      windowEndMs: endMs,
    };
    try {
      const usage = await options.readUsage(selector);
      return {
        ...summarizeTipDemos(usage.rows),
        window: { startMs: selector.windowStartMs, endMs },
        provenance: {
          source: 'F268-durable-aggregates',
          identityScope: 'deployment-aggregate',
          aggregateRetentionDays: 90,
        },
      };
    } catch {
      return reply.status(503).send({ error: 'Tip telemetry service temporarily unavailable' });
    }
  });
  app.post<{ Body: unknown }>('/api/tip-telemetry/batch', async (request, reply) => {
    const userId = (request as import('fastify').FastifyRequest & { sessionUserId?: string }).sessionUserId;
    if (!userId) {
      return reply.status(401).send({ error: 'Session required' });
    }

    const parsed = TipEventBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      const reasons = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      const ack: TipEventBatchAck = {
        batchId: rejectedBatchId(request.body),
        accepted: 0,
        rejected: reasons.length,
        rejectedReasons: reasons.slice(0, 10),
      };
      options.sink.recordTransport('rejected', 1);
      return reply.status(400).send(ack);
    }

    const batch = parsed.data;
    const now = options.now?.() ?? Date.now();
    const oldestAcceptedAt = now - TIP_MAX_AGE_MS;
    const newestAcceptedAt = now + MAX_FUTURE_CLOCK_SKEW_MS;
    const invalidTimestampIndexes = batch.events.flatMap((event, index) =>
      event.timestamp < oldestAcceptedAt || event.timestamp > newestAcceptedAt ? [index] : [],
    );

    if (invalidTimestampIndexes.length > 0) {
      const ack: TipEventBatchAck = {
        batchId: batch.batchId,
        accepted: 0,
        rejected: invalidTimestampIndexes.length,
        rejectedReasons: invalidTimestampIndexes
          .slice(0, 10)
          .map((index) => `events.${index}.timestamp: outside accepted delivery window`),
      };
      options.sink.recordTransport('rejected', 1);
      return reply.status(400).send(ack);
    }

    const result = await options.sink.ingest(batch, userId);
    if (result.status === 'unavailable') {
      return reply.status(503).send({ error: 'Tip telemetry service temporarily unavailable' });
    }

    if (result.status === 'conflict') {
      const ack: TipEventBatchAck = {
        batchId: batch.batchId,
        accepted: 0,
        rejected: batch.events.length,
        rejectedReasons: ['payload conflict: same batchId with different events'],
      };
      options.sink.recordTransport('conflict', 1);
      return reply.status(409).send(ack);
    }

    options.sink.recordTransport(result.status, 1);
    const ack: TipEventBatchAck = {
      batchId: batch.batchId,
      accepted: result.eventCount,
      rejected: 0,
    };
    return reply.status(202).send(ack);
  });
};
