/**
 * F254 FreshnessAttentionEventLog (Phase B — B0)
 *
 * Append-only event log for freshness attention events.
 * Communication channel between the MCP tool layer (B1/B2 notice delivery)
 * and the harness layer (B3/B4 re-invoke decisions).
 *
 * Uses Redis LIST per invocation (key: freshness:events:inv:{invocationId}) and
 * an owner-scoped 35-day replay index. Per-invocation logs retain seven days;
 * the wider index covers the maximum 31-day selector plus scheduling delay.
 *
 * Closed union type with kind discriminator (spec §B0a):
 *   held_decision | forward_decision | notice_attached | notice_implicit_acked |
 *   notice_deferred | reinvoke_triggered | reinvoke_skipped | queued_handled
 */

import { randomUUID } from 'node:crypto';
import type { CatId, QueueTargetOutcomeEvidenceRef } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  FreshnessAttentionEvent,
  FreshnessAttentionEventWindow,
  NoticeAttachedEvent,
  ProviderNoticeDeliveredEvent,
  ProviderNoticeEventBase,
  ProviderNoticeHandledEvent,
  ProviderNoticeSeenEvent,
} from './freshness-attention-event-types.js';

export type * from './freshness-attention-event-types.js';

// --- Constants ---

/** TTL for event log keys: 7 days in seconds */
const EVENT_LOG_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800
const PROVIDER_NATIVE_INDEX_KEY = 'freshness:events:provider-native';
/** Replay selectors are bounded to 31 days; keep four extra days for scheduling delay. */
const WINDOW_INDEX_RETENTION_MS = 35 * 24 * 60 * 60 * 1_000;
/** Do not certify the actively mutating tail of the event index as a settled replay window. */
const WINDOW_SETTLEMENT_DELAY_MS = 60_000;
const WINDOW_INDEX_KEY = 'freshness:events:window:v2';
const WINDOW_COVERAGE_STARTED_AT_KEY = 'freshness:events:window:v2:coverage-started-at';
const ADVANCE_WINDOW_COVERAGE_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]))
local candidate = tonumber(ARGV[1])
if not candidate then
  return redis.error_reply('invalid coverage candidate')
end
if not current or candidate > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return candidate
end
return current
`;

/** Shared by every log instance in this API process; startup reset is the durable restart fence. */
let processCoverageGapAt: number | undefined;

function recordProcessCoverageGap(timestamp: number): void {
  processCoverageGapAt = Math.max(processCoverageGapAt ?? 0, timestamp);
}

interface IndexedFreshnessEventV1 {
  schemaVersion: 1;
  eventId: string;
  /** Missing means the event cannot participate in an owner-scoped replay. */
  ownerUserId?: string;
  event: FreshnessAttentionEvent;
}

function exactReadCoversProviderNotice(
  notice: Pick<ProviderNoticeEventBase, 'frontier' | 'correlationMessageIds'>,
  exactIds: ReadonlySet<string>,
): boolean {
  const correlationIds = notice.correlationMessageIds ?? [notice.frontier];
  return correlationIds.length > 0 && correlationIds.every((messageId) => exactIds.has(messageId));
}

/** Redis key prefix for per-invocation event log */
function invocationKey(invocationId: string): string {
  return `freshness:events:inv:${invocationId}`;
}

// --- Event Log ---

export class FreshnessAttentionEventLog {
  constructor(
    private readonly redis: RedisClient,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Mark the first instant from which every append is eligible for the global
   * replay index. Startup calls this before accepting traffic. Advancing on every
   * restart deliberately invalidates windows that cross a crash, rollback, or
   * off-mode interval whose older binary may not have written the v2 index.
   */
  async initializeWindowedReplayCoverage(startedAt = this.now()): Promise<number> {
    try {
      const stored = Number(
        await this.redis.eval(ADVANCE_WINDOW_COVERAGE_LUA, 1, WINDOW_COVERAGE_STARTED_AT_KEY, String(startedAt)),
      );
      if (!Number.isFinite(stored) || stored < 0) throw new Error('invalid freshness replay coverage watermark');
      return stored;
    } catch (error) {
      recordProcessCoverageGap(startedAt);
      throw error;
    }
  }

  /**
   * Append an event to the invocation's event log.
   * Sets TTL on first write (idempotent — EXPIRE resets if already set).
   */
  async append(event: FreshnessAttentionEvent, scope: { ownerUserId: string }): Promise<void> {
    const key = invocationKey(event.invocationId);
    const serialized = JSON.stringify(event);
    const appendAttemptAt = this.now();
    const indexed: IndexedFreshnessEventV1 = {
      schemaVersion: 1,
      eventId: randomUUID(),
      ...(scope?.ownerUserId ? { ownerUserId: scope.ownerUserId } : {}),
      event,
    };
    try {
      const transaction = this.redis
        .multi()
        .rpush(key, serialized)
        // Resetting the TTL keeps the invocation-local diagnostic view alive
        // for seven days after its last event.
        .expire(key, EVENT_LOG_TTL_SECONDS)
        .zadd(WINDOW_INDEX_KEY, String(event.timestamp), JSON.stringify(indexed))
        .zremrangebyscore(WINDOW_INDEX_KEY, '-inf', String(appendAttemptAt - WINDOW_INDEX_RETENTION_MS));
      if (event.kind.startsWith('provider_')) {
        transaction
          .zadd(PROVIDER_NATIVE_INDEX_KEY, String(event.timestamp), serialized)
          .zremrangebyscore(PROVIDER_NATIVE_INDEX_KEY, '-inf', String(appendAttemptAt - EVENT_LOG_TTL_SECONDS * 1_000));
      }
      const results = await transaction.exec();
      if (!results) throw new Error('freshness event append transaction returned no result');
      for (const [error] of results) {
        if (error) throw error;
      }
    } catch (error) {
      recordProcessCoverageGap(Math.max(appendAttemptAt, event.timestamp));
      throw error;
    }
  }

  /**
   * Query all events for a given invocation, in append order.
   */
  async queryByInvocation(invocationId: string): Promise<FreshnessAttentionEvent[]> {
    const key = invocationKey(invocationId);
    const raw = await this.redis.lrange(key, 0, -1);
    return raw.map((s: string) => JSON.parse(s) as FreshnessAttentionEvent);
  }

  async queryProviderNativeBetween(startMs: number, endMs: number): Promise<FreshnessAttentionEvent[]> {
    const raw = await this.redis.zrangebyscore(PROVIDER_NATIVE_INDEX_KEY, String(startMs), `(${endMs}`);
    return raw.map((value: string) => JSON.parse(value) as FreshnessAttentionEvent);
  }

  /** Query the complete cross-invocation signal plane for one half-open window. */
  async queryWindowBetween(
    startMs: number,
    endMs: number,
    ownerUserId: string,
    options: { threadIds?: readonly string[] } = {},
  ): Promise<FreshnessAttentionEventWindow> {
    const sampledAt = this.now();
    const observedThroughMs = sampledAt - WINDOW_SETTLEMENT_DELAY_MS;
    const rawStartedAt = await this.redis.get(WINDOW_COVERAGE_STARTED_AT_KEY);
    const raw = await this.redis.zrangebyscore(WINDOW_INDEX_KEY, String(startMs), `(${endMs}`);
    const threadFilter = options.threadIds ? new Set(options.threadIds) : null;
    const indexed = raw
      .map(parseIndexedFreshnessEvent)
      .filter((item) => !threadFilter || threadFilter.has(item.event.threadId));
    const events = indexed.filter((item) => item.ownerUserId === ownerUserId).map((item) => item.event);
    if (rawStartedAt === null) {
      return {
        events,
        coverage: { status: 'unavailable', observedThroughMs, reason: 'coverage_not_initialized' },
      };
    }
    const initializedAt = Number(rawStartedAt);
    if (!Number.isFinite(initializedAt) || initializedAt < 0) {
      throw new Error('invalid freshness replay coverage watermark');
    }
    const completeFromMs = Math.max(
      initializedAt,
      sampledAt - WINDOW_INDEX_RETENTION_MS,
      processCoverageGapAt === undefined ? 0 : processCoverageGapAt + 1,
    );
    if (startMs < completeFromMs) {
      return {
        events,
        coverage: {
          status: 'incomplete',
          completeFromMs,
          observedThroughMs,
          reason:
            processCoverageGapAt !== undefined && startMs <= processCoverageGapAt
              ? 'event_append_gap'
              : 'window_starts_before_coverage',
        },
      };
    }
    if (endMs > observedThroughMs) {
      return {
        events,
        coverage: {
          status: 'incomplete',
          completeFromMs,
          observedThroughMs,
          reason: 'window_ends_after_observed_through',
        },
      };
    }
    if (indexed.some((item) => item.ownerUserId === undefined)) {
      return {
        events,
        coverage: {
          status: 'incomplete',
          completeFromMs,
          observedThroughMs,
          reason: 'unscoped_events_present',
        },
      };
    }
    return { events, coverage: { status: 'complete', completeFromMs, observedThroughMs } };
  }

  async markProviderNoticesSeen(input: {
    ownerUserId: string;
    invocationId: string;
    catId: CatId;
    exactMessageIds: readonly string[];
    evidenceKind: ProviderNoticeSeenEvent['evidenceKind'];
  }): Promise<number> {
    if (input.exactMessageIds.length === 0) return 0;
    const events = await this.queryByInvocation(input.invocationId);
    const exactIds = new Set(input.exactMessageIds);
    const delivered = events.filter(
      (event): event is ProviderNoticeDeliveredEvent =>
        event.kind === 'provider_notice_delivered' && event.catId === input.catId,
    );
    const seenIds = new Set(
      events
        .filter((event): event is ProviderNoticeSeenEvent => event.kind === 'provider_notice_seen')
        .map((event) => event.noticeId),
    );
    let marked = 0;
    for (const notice of delivered) {
      if (seenIds.has(notice.noticeId) || !exactReadCoversProviderNotice(notice, exactIds)) continue;
      await this.append(
        {
          ...notice,
          kind: 'provider_notice_seen',
          timestamp: this.now(),
          seenMessageIds: [...input.exactMessageIds],
          evidenceKind: input.evidenceKind,
        },
        { ownerUserId: input.ownerUserId },
      );
      marked++;
    }
    return marked;
  }

  async markProviderNoticesHandled(input: {
    ownerUserId: string;
    invocationId: string;
    catId: CatId;
    queueEntryId: string;
    messageIds: readonly string[];
    evidenceRef: QueueTargetOutcomeEvidenceRef;
  }): Promise<number> {
    const events = await this.queryByInvocation(input.invocationId);
    const messageIds = new Set(input.messageIds);
    const seen = events.filter(
      (event): event is ProviderNoticeSeenEvent => event.kind === 'provider_notice_seen' && event.catId === input.catId,
    );
    const handledIds = new Set(
      events
        .filter((event): event is ProviderNoticeHandledEvent => event.kind === 'provider_notice_handled')
        .map((event) => event.noticeId),
    );
    let marked = 0;
    for (const notice of seen) {
      if (handledIds.has(notice.noticeId) || !exactReadCoversProviderNotice(notice, messageIds)) continue;
      await this.append(
        {
          ...notice,
          kind: 'provider_notice_handled',
          timestamp: this.now(),
          queueEntryId: input.queueEntryId,
          evidenceRef: input.evidenceRef,
        },
        { ownerUserId: input.ownerUserId },
      );
      marked++;
    }
    return marked;
  }

  /**
   * Get unresolved notices for an invocation.
   * A notice is "unresolved" if it has been attached but NOT explicitly acked.
   *
   * `notice_deferred` does NOT resolve a notice — it means the cat was warned
   * at hold_ball time but chose to exit without reading. B3 should still
   * consider re-invoking for deferred notices (the cat never read the messages).
   * Only `notice_implicit_acked` (seenCursor caught up) truly resolves.
   *
   * This is the key projection for B3 (re-invoke trigger decision).
   */
  async getUnresolvedNotices(invocationId: string): Promise<NoticeAttachedEvent[]> {
    const events = await this.queryByInvocation(invocationId);

    // Only notice_implicit_acked resolves a notice.
    // notice_deferred = "cat was warned but didn't read" — NOT resolved.
    const resolvedIds = new Set<string>();
    for (const e of events) {
      if (e.kind === 'notice_implicit_acked') {
        for (const id of e.noticeIds) {
          resolvedIds.add(id);
        }
      }
    }

    // Return notices that haven't been resolved
    return events.filter((e): e is NoticeAttachedEvent => e.kind === 'notice_attached' && !resolvedIds.has(e.noticeId));
  }
}

function parseIndexedFreshnessEvent(raw: string): IndexedFreshnessEventV1 {
  const parsed = JSON.parse(raw) as Partial<IndexedFreshnessEventV1>;
  if (parsed.schemaVersion !== 1 || !parsed.eventId || !parsed.event) {
    throw new Error('invalid indexed freshness event');
  }
  return parsed as IndexedFreshnessEventV1;
}
