/**
 * InjectionTraceStore — F237 Phase 2-E (AC-P2-8/8a/9)
 *
 * Dual-layer persistence for prompt injection traces:
 *   Layer 1: InjectionTraceSummary — persistent (TTL=0, LL-048)
 *            Compact per-turn record: which hooks fired/skipped, aggregate stats.
 *            Data substrate for Phase 3 eval and long-term trend analysis.
 *   Layer 2: InjectionTraceDetail — short TTL (default 7 days)
 *            Full TraceEvent records with content hashes and durations.
 *            For debugging "what exactly happened on turn N?"
 *
 * Why dual-layer: full TraceEvent records are expensive to store indefinitely
 * and rarely needed after the immediate debugging window. The summary layer
 * captures structural signal needed for eval correlation and trend analysis.
 */

import type {
  InjectionTraceDetail,
  InjectionTraceSummary,
  StageDeliveryDecision,
  TraceEvent,
  TraceEventSummary,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

// ---------------------------------------------------------------------------
// Redis key schema
// ---------------------------------------------------------------------------

const SUMMARY_PREFIX = 'injection-trace-summary:';
const DETAIL_PREFIX = 'injection-trace-detail:';
const INDEX_PREFIX = 'injection-trace-index:';

function summaryKey(threadId: string, turnId: string): string {
  return `${SUMMARY_PREFIX}${threadId}:${turnId}`;
}

function detailKey(threadId: string, turnId: string): string {
  return `${DETAIL_PREFIX}${threadId}:${turnId}`;
}

function indexKey(threadId: string): string {
  return `${INDEX_PREFIX}${threadId}`;
}

// ---------------------------------------------------------------------------
// Default TTL for detail layer (7 days in seconds)
// ---------------------------------------------------------------------------

const DEFAULT_DETAIL_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800

// ---------------------------------------------------------------------------
// Pure helpers: build summary from pipeline output
// ---------------------------------------------------------------------------

/** Convert full TraceEvents to compact summary entries. */
export function toSummaryEntries(events: readonly TraceEvent[]): TraceEventSummary[] {
  return events.map((e) => {
    const entry: TraceEventSummary = { hookId: e.hookId, status: e.status };
    if (e.status === 'fired') {
      entry.version = e.version;
      entry.tokenEstimate = e.tokenEstimate;
    }
    if (e.status === 'observed') {
      entry.tokenEstimate = e.tokenEstimate;
    }
    if (e.status === 'skipped') {
      entry.reasonCode = e.reasonCode;
    }
    return entry;
  });
}

export interface BuildSummaryInput {
  turnId: string;
  sessionId: string;
  threadId: string;
  catId: string;
  events: readonly TraceEvent[];
  delivery: StageDeliveryDecision[];
  durationMs: number;
}

/** Build a complete InjectionTraceSummary from pipeline output. Pure function. */
export function buildTraceSummary(input: BuildSummaryInput): InjectionTraceSummary {
  const hooks = toSummaryEntries(input.events);
  const fired = hooks.filter((h) => h.status === 'fired');
  const skipped = hooks.filter((h) => h.status === 'skipped');
  const totalTokens = fired.reduce((sum, h) => sum + (h.tokenEstimate ?? 0), 0);

  return {
    turnId: input.turnId,
    sessionId: input.sessionId,
    threadId: input.threadId,
    catId: input.catId,
    timestamp: Date.now(),
    hooks,
    delivery: input.delivery,
    totalTokens,
    totalHooksFired: fired.length,
    totalHooksSkipped: skipped.length,
    totalDurationMs: input.durationMs,
  };
}

// ---------------------------------------------------------------------------
// InjectionTraceStore
// ---------------------------------------------------------------------------

export class InjectionTraceStore {
  private readonly detailTtl: number;

  constructor(
    private readonly redis: RedisClient,
    options?: { detailTtlSeconds?: number },
  ) {
    this.detailTtl = options?.detailTtlSeconds ?? DEFAULT_DETAIL_TTL_SECONDS;
  }

  // -- Persist (AC-P2-8) ----------------------------------------------------

  async persist(summary: InjectionTraceSummary, detail: InjectionTraceDetail): Promise<void> {
    const sKey = summaryKey(summary.threadId, summary.turnId);
    const dKey = detailKey(detail.threadId, detail.turnId);
    const iKey = indexKey(summary.threadId);

    // Summary: TTL=0 (persistent, LL-048)
    await this.redis.set(sKey, JSON.stringify(summary));

    // Detail: TTL=7d (configurable)
    await this.redis.set(dKey, JSON.stringify(detail), 'EX', this.detailTtl);

    // Index: sorted set (score = timestamp) for listSummaries
    await this.redis.zadd(iKey, summary.timestamp, summary.turnId);
  }

  // -- Read (AC-P2-9) -------------------------------------------------------

  async getSummary(threadId: string, turnId: string): Promise<InjectionTraceSummary | null> {
    const raw = await this.redis.get(summaryKey(threadId, turnId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InjectionTraceSummary;
    } catch {
      return null;
    }
  }

  async getDetail(threadId: string, turnId: string): Promise<InjectionTraceDetail | null> {
    const raw = await this.redis.get(detailKey(threadId, turnId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InjectionTraceDetail;
    } catch {
      return null;
    }
  }

  // -- Query (AC-P2-9: "which hooks fired per turn per thread") -------------

  async listTurnIds(
    threadId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ turnIds: string[]; total: number }> {
    const iKey = indexKey(threadId);
    const total = await this.redis.zcard(iKey);
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    // Reverse chronological (newest first)
    const turnIds = await this.redis.zrevrange(iKey, offset, offset + limit - 1);
    return { turnIds, total };
  }

  async listSummaries(
    threadId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ summaries: InjectionTraceSummary[]; total: number }> {
    const { turnIds, total } = await this.listTurnIds(threadId, options);
    const summaries: InjectionTraceSummary[] = [];

    for (const turnId of turnIds) {
      const summary = await this.getSummary(threadId, turnId);
      if (summary) summaries.push(summary);
    }

    return { summaries, total };
  }

  // -- Cleanup (for tests / admin) ------------------------------------------

  async deleteTurn(threadId: string, turnId: string): Promise<void> {
    await this.redis.del(summaryKey(threadId, turnId));
    await this.redis.del(detailKey(threadId, turnId));
    await this.redis.zrem(indexKey(threadId), turnId);
  }
}
