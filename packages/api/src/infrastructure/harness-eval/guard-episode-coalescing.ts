/**
 * F257 V2/Phase B — canonical guard-rejection episode coalescer.
 *
 * PR #41 verdict (eval:harness-ledger, 2026-07-19-harness-ledger-burst-coalescing-fix-c2):
 * four hold_ball 429s within 7.044s were counted as four independent 3-per-7d
 * escalation incidents — raw request count is NOT distinct incident count.
 *
 * This module is the SINGLE coalescing implementation (sol scope ruling,
 * msg 0001784468875582): both the real-time threshold path
 * (guard-threshold-escalation) and the snapshot/bundle path
 * (harness-ledger-snapshot-provider → generator adapter) must call it.
 * Two implementations would reintroduce accounting drift.
 *
 * Contract:
 * - Group key: guardId + threadId + catId. ALL THREE must be trusted
 *   non-empty values — an event with an untrusted key forms its own episode
 *   and never co-mingles (prevents unknown-identity mis-merges).
 * - Stable total order: timestamp asc, tie-broken by eventId asc.
 *   eventId is the per-raw-rejection coordinate; episodeId is a DERIVED
 *   coordinate — the two must never be interchanged.
 * - Chaining: within a group, an event whose gap to the previous event is
 *   ≤ EPISODE_GAP_MS extends the current episode (gap-based, matching
 *   "rapid retry" semantics — a fixed time bucket would split long chains).
 * - Deterministic: same input set (any order) → identical episode list,
 *   so historical windows are replayable and bundles independently
 *   recheckable.
 *
 * EPISODE_GAP_MS = 60s covers the known 1s/2s/4s retry backoff envelope
 * plus scheduling jitter (sol parameter ruling). V2 deliberately ships NO
 * per-guard/operator config surface — revisit only with committed episode
 * evidence (V3+).
 */

import { createHash } from 'node:crypto';
import type { GuardRejectionEvent } from './GuardRejectionEventLog.js';
import { EVENTS_ZSET, HARD_QUERY_CAP } from './guard-rejection-constants.js';

/** Adjacent-event gap (ms) at or under which retries chain into one episode. */
export const EPISODE_GAP_MS = 60_000;

/** Max anchors carried per episode (first/last always included). */
const EPISODE_ANCHOR_LIMIT = 3;

/** Metadata-only pointer to a raw rejection event (no raw payload). */
export interface EpisodeAnchor {
  eventId: string;
  kind: string;
  guardId: string;
  timestamp: number;
}

/** A coalesced run of rapid same-guard/thread/cat rejections. */
export interface GuardEpisode {
  /** Derived coordinate (deterministic hash) — never a raw eventId. */
  episodeId: string;
  guardId: string;
  threadId: string;
  catId: string;
  startMs: number;
  endMs: number;
  /** Raw rejection events coalesced into this episode (preserved, per verdict). */
  rawEventCount: number;
  /** First/last (+1 interior) event anchors — enable independent span recheck. */
  sampleAnchors: EpisodeAnchor[];
}

/** A key is trusted only when it is a non-empty, non-placeholder string. */
function isTrustedKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== 'unknown';
}

function toAnchor(e: GuardRejectionEvent): EpisodeAnchor {
  return { eventId: e.eventId, kind: e.kind, guardId: e.guardId, timestamp: e.timestamp };
}

/** Build the episode record from a chronologically sorted event run. */
function buildEpisode(run: GuardRejectionEvent[]): GuardEpisode {
  const first = run[0];
  const last = run[run.length - 1];
  const anchors: EpisodeAnchor[] =
    run.length <= EPISODE_ANCHOR_LIMIT ? run.map(toAnchor) : [toAnchor(first), toAnchor(run[1]), toAnchor(last)];
  const episodeId = `ep-${createHash('sha256')
    .update(`${first.guardId}|${first.threadId}|${first.catId}|${first.timestamp}|${first.eventId}`)
    .digest('hex')
    .slice(0, 16)}`;
  return {
    episodeId,
    guardId: first.guardId,
    threadId: first.threadId,
    catId: first.catId,
    startMs: first.timestamp,
    endMs: last.timestamp,
    rawEventCount: run.length,
    sampleAnchors: anchors,
  };
}

// ---------------------------------------------------------------------------
// Shared streaming episode state machine (sol R6 P2-2)
// ---------------------------------------------------------------------------

/** Minimum event shape needed by the streaming counter. */
interface EpisodeStreamEvent {
  guardId: string;
  threadId: string;
  catId: string;
  timestamp: number;
}

/**
 * Streaming episode boundary detector — shared primitive for both the
 * pagewise threshold counter and any future streaming consumers.
 *
 * Tracks open runs by group key and counts closed episodes. Accepts
 * events one at a time in timestamp order. The `lowerBound` property
 * gives the minimum number of distinct episodes at any point during
 * the scan (closed episodes + open runs each worth ≥ 1 episode).
 *
 * Uses the same key/gap/trusted semantics as `coalesceGuardEpisodes`.
 */
export class EpisodeStreamCounter {
  private readonly openRunTs = new Map<string, number>();
  private closedCount = 0;

  constructor(private readonly gapMs: number = EPISODE_GAP_MS) {}

  /**
   * Feed one event (must be in timestamp order within each group key).
   * Returns the current lower bound of total episodes.
   */
  feed(event: EpisodeStreamEvent): number {
    const trusted = isTrustedKey(event.guardId) && isTrustedKey(event.threadId) && isTrustedKey(event.catId);
    if (!trusted) {
      this.closedCount++;
      return this.lowerBound;
    }
    const key = `${event.guardId}\0${event.threadId}\0${event.catId}`;
    const prevTs = this.openRunTs.get(key);
    if (prevTs !== undefined && event.timestamp - prevTs <= this.gapMs) {
      this.openRunTs.set(key, event.timestamp);
    } else {
      if (prevTs !== undefined) this.closedCount++;
      this.openRunTs.set(key, event.timestamp);
    }
    return this.lowerBound;
  }

  /** Lower bound: closed episodes + open runs (each is ≥ 1 episode). */
  get lowerBound(): number {
    return this.closedCount + this.openRunTs.size;
  }
}

// ---------------------------------------------------------------------------
// Pagewise streaming counter (sol R5 P2-1 + R6 P2-1 early-stop fix)
// ---------------------------------------------------------------------------

/** Redis surface needed by the pagewise counter. */
export interface PagewiseRedis {
  zrangebyscore(key: string, min: number, max: number, ...args: unknown[]): Promise<string[]>;
}

/** Result of a pagewise threshold check with explicit provenance. */
export interface PagewiseEpisodeResult {
  /** Episode count — exact if `!isLowerBound`, at least this many otherwise. */
  episodeCount: number;
  /** True when early-stopped at k OR scan reached hard cap. */
  isLowerBound: boolean;
  /**
   * Matching events scanned. When `isLowerBound` is true, this is a scan
   * lower bound (remaining window events were not fetched), NOT the
   * total events in the window.
   */
  rawEventsSeen: number;
  /** Redis page calls made (the perf metric — should be 1-2 for typical thresholds). */
  pagesFetched: number;
  /** Why the count stopped early, if it did. */
  earlyStopReason?: 'threshold_met' | 'hard_cap';
}

const PAGE_SIZE = 1000;

/**
 * Pagewise streaming episode counter: reads Redis pages one at a time,
 * counting episodes via `EpisodeStreamCounter` as events arrive in
 * timestamp order. Stops I/O as soon as `k` episodes are established —
 * counting occurs at the LOWER BOUND level (closed + open runs), so a
 * new distinct-key event immediately contributes to the count without
 * waiting for its run to close.
 *
 * ZRANGEBYSCORE returns events in score (timestamp) order, matching the
 * sort prerequisite for gap-based coalescing. Same-timestamp tie-breaking
 * differs from the in-memory sort (insertion order vs eventId lex), but
 * this doesn't affect gap calculations (gap=0 always chains).
 *
 * Redis constants (EVENTS_ZSET, HARD_QUERY_CAP) imported from
 * guard-rejection-constants.ts — single source shared with EventLog.
 */
export async function countEpisodesPagewise(
  redis: PagewiseRedis,
  opts: { since: number; until: number; guardId?: string },
  k: number,
  gapMs: number = EPISODE_GAP_MS,
): Promise<PagewiseEpisodeResult> {
  const upperBound = opts.until - 1;
  const counter = new EpisodeStreamCounter(gapMs);
  let rawEventsSeen = 0;
  let pagesFetched = 0;

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const raw = await redis.zrangebyscore(EVENTS_ZSET, opts.since, upperBound, 'LIMIT', offset, PAGE_SIZE);
    pagesFetched++;

    for (const s of raw) {
      let parsed: GuardRejectionEvent;
      try {
        parsed = JSON.parse(s) as GuardRejectionEvent;
      } catch {
        continue;
      }
      if (opts.guardId && parsed.guardId !== opts.guardId) continue;
      rawEventsSeen++;

      if (rawEventsSeen > HARD_QUERY_CAP) {
        return {
          episodeCount: Math.min(counter.lowerBound, k),
          isLowerBound: true,
          rawEventsSeen,
          pagesFetched,
          earlyStopReason: 'hard_cap',
        };
      }

      const lb = counter.feed(parsed);
      if (lb >= k) {
        return {
          episodeCount: k,
          isLowerBound: true,
          rawEventsSeen,
          pagesFetched,
          earlyStopReason: 'threshold_met',
        };
      }
    }

    if (raw.length < PAGE_SIZE) break;
  }

  return { episodeCount: counter.lowerBound, isLowerBound: false, rawEventsSeen, pagesFetched };
}

// ---------------------------------------------------------------------------
// Full coalescer (snapshot/bundle path — needs complete episode objects)
// ---------------------------------------------------------------------------

/**
 * Coalesce raw guard-rejection events into distinct episodes.
 *
 * Pure and deterministic — input order does not affect the output
 * (events are stably re-sorted internally; output is ordered by
 * startMs asc, episodeId as tie-break).
 *
 * Uses the same key/gap/trusted semantics as `EpisodeStreamCounter`
 * but builds full `GuardEpisode` objects with anchors and hashes
 * (needed by the snapshot/bundle path).
 */
export function coalesceGuardEpisodes(events: GuardRejectionEvent[], gapMs: number = EPISODE_GAP_MS): GuardEpisode[] {
  // Stable total order: timestamp asc, tie-break by eventId (per-event coordinate).
  const sorted = [...events].sort(
    (a, b) => a.timestamp - b.timestamp || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );

  const episodes: GuardEpisode[] = [];
  /** groupKey → open run of chained events (chronological). */
  const openRuns = new Map<string, GuardRejectionEvent[]>();

  for (const event of sorted) {
    const trusted = isTrustedKey(event.guardId) && isTrustedKey(event.threadId) && isTrustedKey(event.catId);
    if (!trusted) {
      // Untrusted identity: solo episode, never merged — not even with other
      // untrusted events sharing the same placeholder values.
      episodes.push(buildEpisode([event]));
      continue;
    }
    const key = `${event.guardId}\0${event.threadId}\0${event.catId}`;
    const run = openRuns.get(key);
    if (run && event.timestamp - run[run.length - 1].timestamp <= gapMs) {
      run.push(event);
    } else {
      if (run) episodes.push(buildEpisode(run));
      openRuns.set(key, [event]);
    }
  }
  for (const run of openRuns.values()) episodes.push(buildEpisode(run));

  // Deterministic output order independent of grouping traversal.
  episodes.sort((a, b) => a.startMs - b.startMs || (a.episodeId < b.episodeId ? -1 : 1));
  return episodes;
}
