/**
 * F257 GuardRejectionEventLog — append-only ZSET event log for guard rejections.
 *
 * Uses Redis ZSET (timestamp scores) for time-windowed discovery. Fail-open:
 * observation layer failures never block business calls.
 *
 * Closed union type with `kind` discriminator (F257 spec §2.1b).
 * V2/Phase B: 6 event kinds + octet contract (ledgerId/catId/threadId/
 * invocationId/sourceTool/normalizedReason/layer/timestamp).
 *
 * `iterateWindow()` is the UNIQUE scan/parse/filter primitive — consumed by
 * both internal `fetchWindow` and external pagewise episode counter
 * (via PagewiseEventSource interface). No duplicate pagination logic.
 *
 * Storage: ZSET `guard-rejection:events` { eventJSON → timestamp }.
 * Retention: 7 days (pruned on each append via ZREMRANGEBYSCORE).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { EVENTS_ZSET, HARD_QUERY_CAP, WINDOW_PAGE_SIZE } from './guard-rejection-constants.js';

// ---------------------------------------------------------------------------
// Event type definitions (closed union)
// ---------------------------------------------------------------------------

interface GuardRejectionEventBase {
  /** Per-event unique coordinate (ZSET uniqueness, sort tie-break, anchors). */
  eventId: string;
  /**
   * Ledger registry coordinate `{layer}/{slug}` — WHICH pot rejected
   * (per-guard). Carried in rejection responses; anomaly reports quote it
   * for F245 stats attribution. Never interchange with eventId (dual-
   * coordinate contract). See guard-ledger-registry.ts.
   */
  ledgerId: string;
  /** Discriminator for closed union. */
  kind: string;
  /** Thread where the rejection occurred. */
  threadId: string;
  /** Cat that triggered the rejection. */
  catId: string;
  /** Identifier for the guard that rejected (e.g., 'hold_ball_rate_limit'). */
  guardId: string;
  /** Invocation coordinate; 'unknown' until the exact-correlation bridge lands. */
  invocationId: string;
  /** Tool surface that produced the rejection (hold_ball / cross_post_message / …). */
  sourceTool: string;
  /** Machine-normalized rejection reason (rate_limited / missing_wait_source_ref / …). */
  normalizedReason: string;
  /** Emit surface (spec AC-B1 dual-entry requirement). */
  layer: 'api-route' | 'mcp-client' | 'generator';
  /**
   * Owner scope, SERVER-injected at every emit point (sol R2 P1: the query
   * surface must never leak another owner's thread/cat/invocation data).
   * Read paths filter on it; pre-scope events (missing field) are invisible
   * to owner-scoped readers (fail-closed for readers, 7d retention ages them out).
   */
  ownerUserId: string;
  /** Unix epoch ms. Also used as ZSET score. */
  timestamp: number;
  /** 'window' (threadId+catId+timestamp correlation) until exact bridge lands. */
  correlationConfidence: 'window' | 'exact';
}

/** hold_ball 429 — maxHoldsPerWindow exceeded (HTTP route layer). */
export interface HttpRateLimitEvent extends GuardRejectionEventBase {
  kind: 'http_rate_limit';
  /** Current hold count at rejection time. */
  currentCount: number;
  /** Configured maximum holds per window. */
  maxAllowed: number;
  /** Window duration in ms. */
  windowMs: number;
  /** Hold mode that triggered the rate limit (timer = wakeAfterMs, command = wakeWhen). */
  holdMode?: 'timer' | 'command';
}

/** A2A block_pingpong — streak termination (generator layer). */
export interface RouteDecisionBlockEvent extends GuardRejectionEventBase {
  kind: 'route_decision_block';
  /** Cat that initiated the blocked A2A mention. */
  fromCatId: string;
  /** Cat that was the blocked A2A target. */
  targetCatId: string;
  /** Ping-pong streak count that triggered the block. */
  streakCount: number;
}

/** Schema-shape 400 (e.g. wakeAfterMs without waitSourceRef) — HTTP route layer. */
export interface HttpSchemaRejectEvent extends GuardRejectionEventBase {
  kind: 'http_schema_reject';
}

/** Policy-gate 400 (gate-keeping block / routing-credential fail-closed). */
export interface HttpPolicyRejectEvent extends GuardRejectionEventBase {
  kind: 'http_policy_reject';
}

/** publish_verdict 403 — domain authority rejection (eval-hub route layer). */
export interface PublishPolicyRejectEvent extends GuardRejectionEventBase {
  kind: 'publish_policy_reject';
}

/** A2A route decision skip — generator-layer guard skipped a mention. */
export interface RouteDecisionSkipEvent extends GuardRejectionEventBase {
  kind: 'route_decision_skip';
  /** Cat that initiated the skipped A2A mention. */
  fromCatId: string;
  /** Cat that was the skipped A2A target. */
  targetCatId: string;
  /** Guard-specific skip reason. */
  skipReason: string;
}

export type GuardRejectionEvent =
  | HttpRateLimitEvent
  | RouteDecisionBlockEvent
  | HttpSchemaRejectEvent
  | HttpPolicyRejectEvent
  | PublishPolicyRejectEvent
  | RouteDecisionSkipEvent;

export type GuardRejectionKind = GuardRejectionEvent['kind'];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL: 7 days in milliseconds — events older than this are pruned on append. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Default query limit to prevent unbounded reads. */
const DEFAULT_QUERY_LIMIT = 200;

/** Shared query options (sol P1-4: ledgerId is a first-class filter). */
export interface GuardRejectionQueryOpts {
  since: number;
  until?: number;
  guardId?: string;
  ledgerId?: string;
  threadId?: string;
  catId?: string;
  /** Owner scope (sol R2 P1): when set, only events with this ownerUserId match. */
  ownerUserId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Event Log
// ---------------------------------------------------------------------------

/**
 * Post-append hook signature for threshold-driven escalation (F257 sub-item 2).
 * Fires after every successful ZADD. Implementations must be fail-open
 * (the hook is already wrapped in try/catch internally).
 */
export type PostAppendHook = (event: GuardRejectionEvent) => void;

export class GuardRejectionEventLog {
  private postAppendHook?: PostAppendHook;

  constructor(private readonly redis: RedisClient) {}

  /**
   * Register a post-append hook (F257 sub-item 2: threshold escalation).
   * Called after every successful event append — use for threshold checks
   * that should react to event accumulation without waiting for weekly cron.
   * The hook is wrapped in try/catch (fail-open).
   */
  setPostAppendHook(hook: PostAppendHook): void {
    this.postAppendHook = hook;
  }

  /**
   * Append a guard rejection event to the global ZSET.
   *
   * **Fail-open**: silently swallows all errors. Observation layer
   * must never block or degrade the business call that triggered it.
   *
   * Also prunes events older than RETENTION_MS (idempotent, cheap —
   * ZREMRANGEBYSCORE is O(log(N)+M) where M = removed count).
   */
  async append(event: GuardRejectionEvent): Promise<void> {
    try {
      const serialized = JSON.stringify(event);
      await this.redis.zadd(EVENTS_ZSET, event.timestamp, serialized);
      // Prune stale events (fail-open: errors here don't matter)
      const cutoff = event.timestamp - RETENTION_MS;
      await this.redis.zremrangebyscore(EVENTS_ZSET, 0, cutoff);
      // F257 sub-item 2: fire post-append hook for threshold escalation.
      // Fail-open — hook errors never block the business call.
      if (this.postAppendHook) {
        try {
          this.postAppendHook(event);
        } catch {
          /* fail-open */
        }
      }
    } catch {
      // Fail-open: observation layer never blocks business
    }
  }

  /**
   * Query events in a time window. Fail-open (returns [] on error).
   * LIMIT applied AFTER in-app filter (P2 fix: codex review 629795f29).
   */
  async queryWindow(opts: GuardRejectionQueryOpts): Promise<GuardRejectionEvent[]> {
    try {
      const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
      const { events } = await this.fetchWindow(opts);
      return events.slice(0, limit);
    } catch {
      return []; // Fail-open
    }
  }

  /**
   * Fail-open completeness-preserving query (sol P2-1: a silent `limit` slice
   * makes episode/threshold accounting under-count without warning).
   * Returns ALL window events up to HARD_QUERY_CAP with an explicit
   * `truncated` marker when the cap was hit.
   */
  async queryWindowComplete(
    opts: Omit<GuardRejectionQueryOpts, 'limit'>,
  ): Promise<{ events: GuardRejectionEvent[]; truncated: boolean }> {
    try {
      return await this.fetchWindow(opts);
    } catch {
      return { events: [], truncated: false }; // Fail-open
    }
  }

  /**
   * Strict (fail-closed) query for the eval read path.
   *
   * Same logic as queryWindow but does NOT swallow Redis errors.
   * Eval generators MUST use this — a Redis outage must produce a 500
   * (generator throws), NOT a false "zero events" verdict.
   *
   * Business-facing callers keep using queryWindow (fail-open).
   *
   * P1 fix (codex review 04a8c368b): Redis fail-open queryWindow returned []
   * on error, which the generator misinterpreted as genuine zero events and
   * wrote a false noFindingRecord verdict polluting the eval chain.
   */
  async queryWindowStrict(opts: GuardRejectionQueryOpts): Promise<GuardRejectionEvent[]> {
    const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
    const { events } = await this.fetchWindow(opts);
    return events.slice(0, limit);
  }

  /**
   * Fail-closed completeness-preserving query for the eval read path
   * (sol P2-1). Redis errors propagate; `truncated` marks a HARD_QUERY_CAP
   * hit so snapshot/bundle consumers can surface incompleteness explicitly
   * instead of silently reporting a partial window.
   */
  async queryWindowStrictComplete(
    opts: Omit<GuardRejectionQueryOpts, 'limit'>,
  ): Promise<{ events: GuardRejectionEvent[]; truncated: boolean }> {
    return this.fetchWindow(opts);
  }

  /**
   * Count events matching a guardId within a time window.
   * Useful for threshold-driven attribution triggers (default 3/7d).
   *
   * **Fail-open**: returns 0 on any error.
   */
  async countByGuard(guardId: string, since: number, until?: number): Promise<number> {
    const events = await this.queryWindow({ since, until, guardId });
    return events.length;
  }

  /**
   * Pagewise async generator: the UNIQUE scan/parse/filter primitive.
   * Both `fetchWindow` (internal) and the pagewise episode counter
   * (external, via PagewiseEventSource) consume this — no duplicate
   * pagination logic (Fable ruling: single scan implementation).
   *
   * Yields matching events in timestamp order. Callers impose their own
   * caps (HARD_QUERY_CAP, early-stop at k episodes, etc.) by breaking
   * out of the `for await` loop — the generator stops further Redis I/O.
   *
   * @param stats - Optional mutable stats object; `pagesFetched` is
   *   incremented after each Redis page call (preserves test assertions).
   */
  async *iterateWindow(
    opts: Omit<GuardRejectionQueryOpts, 'limit'>,
    stats?: { pagesFetched: number },
  ): AsyncGenerator<GuardRejectionEvent> {
    const until = opts.until ?? Date.now();
    // Exclusive upper bound: subtract 1ms from until (ZRANGEBYSCORE is inclusive).
    // This aligns with PromptSegmentsSourceSelector [windowStartMs, windowEndMs).
    const upperBound = until - 1;
    for (let offset = 0; ; offset += WINDOW_PAGE_SIZE) {
      const raw = await this.redis.zrangebyscore(
        EVENTS_ZSET,
        opts.since,
        upperBound,
        'LIMIT',
        offset,
        WINDOW_PAGE_SIZE,
      );
      if (stats) stats.pagesFetched++;
      for (const s of raw) {
        let parsed: GuardRejectionEvent;
        try {
          parsed = JSON.parse(s) as GuardRejectionEvent;
        } catch {
          continue; /* skip corrupted entries — parse errors are data-quality, not infra */
        }
        if (opts.guardId && parsed.guardId !== opts.guardId) continue;
        if (opts.ledgerId && parsed.ledgerId !== opts.ledgerId) continue;
        if (opts.threadId && parsed.threadId !== opts.threadId) continue;
        if (opts.catId && parsed.catId !== opts.catId) continue;
        if (opts.ownerUserId && parsed.ownerUserId !== opts.ownerUserId) continue;
        yield parsed;
      }
      if (raw.length < WINDOW_PAGE_SIZE) break;
    }
  }

  /**
   * Shared window fetch: consumes `iterateWindow` up to HARD_QUERY_CAP,
   * returning all matching events with an explicit `truncated` marker.
   */
  private async fetchWindow(
    opts: Omit<GuardRejectionQueryOpts, 'limit'>,
  ): Promise<{ events: GuardRejectionEvent[]; truncated: boolean }> {
    const events: GuardRejectionEvent[] = [];
    let truncated = false;
    for await (const event of this.iterateWindow(opts)) {
      if (events.length >= HARD_QUERY_CAP) {
        truncated = true;
        break;
      }
      events.push(event);
    }
    return { events, truncated };
  }
}
