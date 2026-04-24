/**
 * F153 Phase E: In-memory ring buffer for redacted trace span DTOs.
 *
 * Stores projected DTOs (not SDK span objects) with dual-threshold
 * eviction: maxSpans cap + maxAgeMs TTL, whichever triggers first.
 *
 * All IDs stored here are already pseudonymized by RedactingSpanProcessor
 * (Class C HMAC). Query callers must HMAC raw IDs before matching.
 */

/** Projected DTO — only descriptive fields, no SDK references. */
export interface TraceSpanDTO {
  /** OTel trace ID (random hex, not PII — stored as-is). */
  traceId: string;
  /** OTel span ID (random hex). */
  spanId: string;
  /** Parent span ID if child span. */
  parentSpanId?: string;
  /** Span operation name (e.g. 'cat_cafe.invocation', 'cat_cafe.llm_call'). */
  name: string;
  /** SpanKind numeric value. */
  kind: number;
  /** Start time in Unix ms. */
  startTimeMs: number;
  /** End time in Unix ms. */
  endTimeMs: number;
  /** Duration in ms (endTimeMs - startTimeMs). */
  durationMs: number;
  /** Span status. */
  status: { code: number; message?: string };
  /** Redacted attributes snapshot (deep-copied from span). */
  attributes: Record<string, unknown>;
  /** Span events snapshot. */
  events: ReadonlyArray<{
    name: string;
    timeMs: number;
    attributes?: Record<string, unknown>;
  }>;
  /** Timestamp when this DTO was stored (for age-based eviction). */
  storedAt: number;
}

export interface TraceQueryFilter {
  /** OTel trace ID (raw hex — NOT HMAC'd, matched directly). */
  traceId?: string;
  /** Raw invocation ID — will be HMAC'd before matching attributes. */
  invocationId?: string;
  /** Cat ID — matched directly against agent.id attribute (Class D, not HMAC'd). */
  catId?: string;
  /** Max results to return (default 100). */
  limit?: number;
}

export interface LocalTraceStoreConfig {
  /** Max spans in buffer (default 10000). */
  maxSpans?: number;
  /** Max age in ms before eviction (default 7200000 = 2h). */
  maxAgeMs?: number;
}

export interface TraceStoreStats {
  spanCount: number;
  maxSpans: number;
  maxAgeMs: number;
  oldestStoredAt: number | null;
  newestStoredAt: number | null;
}

const DEFAULT_MAX_SPANS = 10_000;
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

export class LocalTraceStore {
  private readonly buffer: TraceSpanDTO[] = [];
  private readonly maxSpans: number;
  private readonly maxAgeMs: number;

  constructor(config?: LocalTraceStoreConfig) {
    this.maxSpans = config?.maxSpans ?? DEFAULT_MAX_SPANS;
    this.maxAgeMs = config?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /** Add a span DTO. Evicts expired and overflow entries. */
  add(dto: TraceSpanDTO): void {
    this.evictExpired();
    // If at capacity, drop oldest
    while (this.buffer.length >= this.maxSpans) {
      this.buffer.shift();
    }
    this.buffer.push(dto);
  }

  /**
   * Query stored spans.
   *
   * traceId is matched directly (OTel random hex, not PII).
   * invocationId must already be HMAC'd by caller (store has pseudonymized IDs).
   * catId is matched directly against agent.id attribute (Class D passthrough).
   */
  query(filter: TraceQueryFilter): TraceSpanDTO[] {
    this.evictExpired();
    const limit = filter.limit ?? 100;
    const results: TraceSpanDTO[] = [];

    // Iterate newest-first so the UI shows most recent spans
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (results.length >= limit) break;
      const dto = this.buffer[i]!;

      if (filter.traceId && dto.traceId !== filter.traceId) continue;
      if (filter.invocationId && dto.attributes.invocationId !== filter.invocationId) continue;
      if (filter.catId && dto.attributes['agent.id'] !== filter.catId) continue;

      results.push(dto);
    }

    return results;
  }

  /** Get buffer stats for health/diagnostics. */
  stats(): TraceStoreStats {
    this.evictExpired();
    return {
      spanCount: this.buffer.length,
      maxSpans: this.maxSpans,
      maxAgeMs: this.maxAgeMs,
      oldestStoredAt: this.buffer.length > 0 ? this.buffer[0].storedAt : null,
      newestStoredAt: this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].storedAt : null,
    };
  }

  /** Clear all stored spans. */
  clear(): void {
    this.buffer.length = 0;
  }

  /** Remove spans older than maxAgeMs. */
  private evictExpired(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.buffer.length > 0 && this.buffer[0].storedAt < cutoff) {
      this.buffer.shift();
    }
  }
}
