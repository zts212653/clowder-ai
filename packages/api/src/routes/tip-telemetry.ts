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
}

const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function rejectedBatchId(body: unknown): string {
  return typeof body === 'object' && body !== null && 'batchId' in body
    ? String((body as Record<string, unknown>).batchId)
    : 'unknown';
}

export const tipTelemetryRoutes: FastifyPluginAsync<TipTelemetryRoutesOptions> = async (app, options) => {
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
