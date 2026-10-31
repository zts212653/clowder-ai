/**
 * F268 Phase A — Capability Tips Telemetry Pipeline Schemas
 *
 * Defines the batch envelope for tip usage events flowing from web → API.
 * Privacy: all content is structurally constrained by CapabilityTipUsageEventSchema
 * (no free-text fields possible). See AC-A3 forbidden-field tests.
 *
 * Transport contract (AC-A2):
 * - Non-blocking: tip display NEVER waits on upload success
 * - Bounded queue: client holds max 200 events, FIFO eviction on overflow
 * - Idempotent: server deduplicates by batchId only (payloadDigest guards content integrity)
 * - Retry: exponential backoff, 5 retries, 5-minute cap
 * - Offline: queue persists in localStorage, flush on reconnect
 * - Max-age: events older than 7d pruned on load (client-side)
 */

import { z } from 'zod';
import { CapabilityTipUsageEventSchema } from './capability-tips.js';

// ── Batch Envelope (client → server) ────────────────────────────────────────

export const TipEventBatchSchema = z
  .object({
    /** Client-generated UUID v4 for idempotency deduplication */
    batchId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        'batchId must be a valid UUID v4',
      ),
    /** Client monotonic attempt counter (1-based); incremented on retry */
    attempt: z.number().int().min(1).max(10),
    /** Events in this batch (1..50) */
    events: z.array(CapabilityTipUsageEventSchema).min(1).max(50),
    /** Client timestamp (epoch ms) when batch was assembled */
    assembledAt: z.number().int().nonnegative(),
    /** Schema version for forward-compatible evolution */
    schemaVersion: z.literal(1),
  })
  .strict();

export type TipEventBatch = z.infer<typeof TipEventBatchSchema>;

// ── Server Acknowledgment (server → client) ─────────────────────────────────

export const TipEventBatchAckSchema = z
  .object({
    /** Echo back batchId for client correlation */
    batchId: z.string(),
    /** Count of events accepted into durable store */
    accepted: z.number().int().nonnegative(),
    /** Count of events rejected by validation */
    rejected: z.number().int().nonnegative(),
    /** Field-path reasons for rejected events (no content!) */
    rejectedReasons: z.array(z.string().max(200)).optional(),
  })
  .strict();

export type TipEventBatchAck = z.infer<typeof TipEventBatchAckSchema>;

// ── Client Queue Constants ──────────────────────────────────────────────────

/** Maximum age for client-held events (7 days, ms). Events older than this are pruned on load. */
export const TIP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum events held in client queue before FIFO eviction */
export const TIP_QUEUE_MAX_EVENTS = 200;

/** Flush triggers: event count threshold */
export const TIP_QUEUE_FLUSH_COUNT = 20;

/** Flush triggers: time since last flush (ms) */
export const TIP_QUEUE_FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum events per batch */
export const TIP_BATCH_MAX_SIZE = 50;

/** Retry backoff sequence (ms): 5s, 15s, 45s, 2min, 5min */
export const TIP_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

/** Maximum retry attempts per batch */
export const TIP_MAX_RETRY_ATTEMPTS = 5;
