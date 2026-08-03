/**
 * F268 Phase B — Redis key derivation for tip telemetry pipeline.
 *
 * No `cat-cafe:` prefix here — ioredis keyPrefix handles that automatically.
 *
 * Key families:
 * - receipt: idempotent dedup receipt (14d TTL)
 * - agg: per-(tipId, event, outcome, date_bucket) counter (90d rolling TTL)
 * - transport: hourly batch-status counters (14d TTL)
 */

/** Receipt TTL: 14 days (seconds). */
export const TIP_RECEIPT_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Aggregate TTL: 90 days rolling (seconds). */
export const TIP_AGGREGATE_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Transport counter TTL: 14 days (seconds). */
export const TIP_TRANSPORT_TTL_SECONDS = 14 * 24 * 60 * 60;

export const TipTelemetryKeys = {
  /**
   * Dedup receipt: one per (sessionUserId, batchId).
   * Value: JSON `{ digest: string, committedAt: number, eventCount: number }`.
   */
  receipt: (sessionUserId: string, batchId: string) => `tip-telemetry:receipt:${sessionUserId}:${batchId}`,

  /**
   * Aggregate counter: one per (date_bucket, tipId, event, outcome).
   * UTC day bucket format: YYYY-MM-DD.
   * Outcome dimension preserves exposure/action/failure distinguishability (Sol P1-4).
   * Value: integer counter (INCR/INCRBY).
   */
  aggregate: (dateBucket: string, tipId: string, event: string, outcome: string) =>
    `tip-telemetry:agg:${dateBucket}:${tipId}:${event}:${outcome}`,

  /**
   * Transport health counter: one per (hour_bucket, metric).
   * Hour bucket format: YYYY-MM-DDTHH.
   * Metrics: 'accepted' | 'rejected' | 'duplicate' | 'conflict'.
   * Unit: batches for every metric (never event counts).
   */
  transport: (hourBucket: string, metric: string) => `tip-telemetry:transport:${hourBucket}:${metric}`,

  /** SCAN pattern for cleanup in tests. */
  allReceipts: 'tip-telemetry:receipt:*',
  allAggregates: 'tip-telemetry:agg:*',
  allTransport: 'tip-telemetry:transport:*',
} as const;
