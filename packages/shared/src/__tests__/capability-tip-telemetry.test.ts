/**
 * F268 AC-A2 — Batch Envelope Contract Tests
 *
 * Verifies the TipEventBatch schema enforces:
 * - Valid UUID v4 batchId (idempotency key)
 * - Bounded batch size (1..50 events)
 * - Monotonic attempt counter
 * - Schema version lock
 * - Strict mode (no extra fields)
 */

import { describe, expect, it } from 'vitest';
import {
  TIP_BATCH_MAX_SIZE,
  TIP_MAX_RETRY_ATTEMPTS,
  TIP_QUEUE_FLUSH_COUNT,
  TIP_QUEUE_MAX_EVENTS,
  TIP_RETRY_BACKOFF_MS,
  TipEventBatchAckSchema,
  TipEventBatchSchema,
} from '../capability-tip-telemetry.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const validEvent = {
  event: 'capability_tip_exposed' as const,
  tipId: 'magic-word-scaffold',
  context: 'thinking' as const,
  surface: 'pending_bubble' as const,
  outcome: 'shown' as const,
  timestamp: 1721000000000,
};

const validBatch = {
  batchId: '550e8400-e29b-41d4-a716-446655440000',
  attempt: 1,
  events: [validEvent],
  assembledAt: 1721000005000,
  schemaVersion: 1 as const,
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('F268 AC-A2: TipEventBatch envelope', () => {
  describe('valid batch acceptance', () => {
    it('accepts a valid single-event batch', () => {
      expect(TipEventBatchSchema.safeParse(validBatch).success).toBe(true);
    });

    it('accepts a batch at max size (50 events)', () => {
      const events = Array.from({ length: 50 }, (_, i) => ({
        ...validEvent,
        tipId: `tip-${i}`,
        timestamp: 1721000000000 + i * 1000,
      }));
      const batch = { ...validBatch, events };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(true);
    });

    it('accepts retry attempt (attempt > 1)', () => {
      const batch = { ...validBatch, attempt: 3 };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(true);
    });
  });

  describe('batchId validation (idempotency)', () => {
    it('rejects non-UUID batchId', () => {
      const batch = { ...validBatch, batchId: 'not-a-uuid' };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it('rejects UUID v1 (must be v4)', () => {
      const batch = { ...validBatch, batchId: '550e8400-e29b-11d4-a716-446655440000' };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it('rejects empty batchId', () => {
      const batch = { ...validBatch, batchId: '' };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });
  });

  describe('batch size bounds', () => {
    it('rejects empty events array', () => {
      const batch = { ...validBatch, events: [] };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it('rejects batch exceeding 50 events', () => {
      const events = Array.from({ length: 51 }, (_, i) => ({
        ...validEvent,
        tipId: `tip-${i}`,
        timestamp: 1721000000000 + i * 1000,
      }));
      const batch = { ...validBatch, events };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });
  });

  describe('attempt counter', () => {
    it('rejects attempt = 0', () => {
      const batch = { ...validBatch, attempt: 0 };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it('rejects attempt > 10 (hard safety cap)', () => {
      const batch = { ...validBatch, attempt: 11 };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it('rejects non-integer attempt', () => {
      const batch = { ...validBatch, attempt: 1.5 };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });
  });

  describe('schema version', () => {
    it('rejects schemaVersion != 1', () => {
      const batch = { ...validBatch, schemaVersion: 2 };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });
  });

  describe('strict mode (no extra fields in envelope)', () => {
    it('rejects extra field in batch envelope', () => {
      const batch = { ...validBatch, userId: 'user-123' };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it('rejects extra field that could carry content', () => {
      const batch = { ...validBatch, metadata: { userAgent: 'Chrome/126' } };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });
  });

  describe('nested event validation', () => {
    it('rejects batch with invalid event inside', () => {
      const batch = {
        ...validBatch,
        events: [{ ...validEvent, extraField: 'injected content' }],
      };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });

    it('rejects batch with event missing required field', () => {
      const { timestamp: _, ...noTs } = validEvent;
      const batch = { ...validBatch, events: [noTs] };
      expect(TipEventBatchSchema.safeParse(batch).success).toBe(false);
    });
  });
});

describe('F268 AC-A2: TipEventBatchAck', () => {
  it('accepts valid ack', () => {
    const ack = { batchId: '550e8400-e29b-41d4-a716-446655440000', accepted: 5, rejected: 0 };
    expect(TipEventBatchAckSchema.safeParse(ack).success).toBe(true);
  });

  it('accepts ack with rejected reasons', () => {
    const ack = {
      batchId: '550e8400-e29b-41d4-a716-446655440000',
      accepted: 3,
      rejected: 2,
      rejectedReasons: ['events[1].event: invalid enum value', 'events[3].timestamp: expected number'],
    };
    expect(TipEventBatchAckSchema.safeParse(ack).success).toBe(true);
  });

  it('rejects ack with extra fields', () => {
    const ack = {
      batchId: '550e8400-e29b-41d4-a716-446655440000',
      accepted: 5,
      rejected: 0,
      serverTimestamp: 123,
    };
    expect(TipEventBatchAckSchema.safeParse(ack).success).toBe(false);
  });
});

describe('F268 AC-A2: Queue constants', () => {
  it('queue max > batch max (can hold multiple batches)', () => {
    expect(TIP_QUEUE_MAX_EVENTS).toBeGreaterThan(TIP_BATCH_MAX_SIZE);
  });

  it('flush count <= batch max (single flush fits one batch)', () => {
    expect(TIP_QUEUE_FLUSH_COUNT).toBeLessThanOrEqual(TIP_BATCH_MAX_SIZE);
  });

  it('retry backoff sequence length matches max retry attempts (P2-3: all entries used)', () => {
    // Semantics: TIP_MAX_RETRY_ATTEMPTS = number of retries (not total attempts)
    // Total sends = 1 initial + MAX_RETRY_ATTEMPTS retries
    // Backoff entries needed = MAX_RETRY_ATTEMPTS (one per retry)
    expect(TIP_RETRY_BACKOFF_MS.length).toBe(TIP_MAX_RETRY_ATTEMPTS);
  });

  it('retry backoff is monotonically increasing', () => {
    for (let i = 1; i < TIP_RETRY_BACKOFF_MS.length; i++) {
      expect(TIP_RETRY_BACKOFF_MS[i]).toBeGreaterThan(TIP_RETRY_BACKOFF_MS[i - 1]!);
    }
  });
});
