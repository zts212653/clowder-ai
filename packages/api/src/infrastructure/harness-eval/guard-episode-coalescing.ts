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
import { HARD_QUERY_CAP } from './guard-rejection-constants.js';

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
// Episode boundary tracker — single state machine (Fable ruling)
// ---------------------------------------------------------------------------

/** Minimum event shape needed by the boundary tracker. */
interface EpisodeStreamEvent {
  guardId: string;
  threadId: string;
  catId: string;
  timestamp: number;
}

/** Result of feeding one event to the boundary tracker. */
export interface BoundaryFeedResult {
  /** 'solo' = untrusted identity (own episode). 'start' = new run opened. 'extend' = existing run extended. */
  kind: 'solo' | 'start' | 'extend';
  /** Group key (guardId\0threadId\0catId). Undefined for 'solo'. */
  groupKey?: string;
  /** True when this event closed a previous run for the same key (gap exceeded). */
  closedPrevious: boolean;
}

/**
 * Episode boundary tracker — the SINGLE state machine for episode
 * accounting (Fable ruling: replaces both EpisodeStreamCounter and
 * coalescer's independent key/gap/trusted logic).
 *
 * Tracks open runs by group key and counts closed episodes. Accepts
 * events one at a time in timestamp order. `feed()` returns structured
 * boundary info so consumers (coalescer, pagewise counter) can react
 * without duplicating the key/gap/trusted semantics.
 */
export class EpisodeBoundaryTracker {
  private readonly openRunTs = new Map<string, number>();
  private _closedCount = 0;

  constructor(private readonly gapMs: number = EPISODE_GAP_MS) {}

  /**
   * Feed one event (must be in timestamp order within each group key).
   * Returns structured boundary info: kind + closedPrevious.
   */
  feed(event: EpisodeStreamEvent): BoundaryFeedResult {
    const trusted = isTrustedKey(event.guardId) && isTrustedKey(event.threadId) && isTrustedKey(event.catId);
    if (!trusted) {
      this._closedCount++;
      return { kind: 'solo', closedPrevious: false };
    }
    const key = `${event.guardId}\0${event.threadId}\0${event.catId}`;
    const prevTs = this.openRunTs.get(key);
    if (prevTs !== undefined && event.timestamp - prevTs <= this.gapMs) {
      this.openRunTs.set(key, event.timestamp);
      return { kind: 'extend', groupKey: key, closedPrevious: false };
    }
    const closedPrevious = prevTs !== undefined;
    if (closedPrevious) this._closedCount++;
    this.openRunTs.set(key, event.timestamp);
    return { kind: 'start', groupKey: key, closedPrevious };
  }

  get closedCount(): number {
    return this._closedCount;
  }

  get openRunCount(): number {
    return this.openRunTs.size;
  }

  /** Lower bound: closed episodes + open runs (each is ≥ 1 episode). */
  get lowerBound(): number {
    return this._closedCount + this.openRunTs.size;
  }
}

// ---------------------------------------------------------------------------
// Pagewise streaming counter (Fable ruling: consumes iterateWindow)
// ---------------------------------------------------------------------------

/**
 * Event source for pagewise episode counting — implemented by
 * GuardRejectionEventLog (structural typing, no import cycle).
 */
export interface PagewiseEventSource {
  iterateWindow(
    opts: { since: number; until?: number; guardId?: string; ownerUserId?: string },
    stats?: { pagesFetched: number },
  ): AsyncGenerator<GuardRejectionEvent>;
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
  /** Events observed but excluded by eventFilter (e.g. ineligible skip reasons). */
  skippedByFilter?: number;
}

/**
 * Pagewise streaming episode counter: consumes `iterateWindow` from an
 * event source, counting episodes via `EpisodeBoundaryTracker`. Stops
 * I/O as soon as `k` episodes are established — returning from the
 * `for await` loop terminates the generator, halting further Redis reads.
 *
 * Counting uses the LOWER BOUND level (closed + open runs), so a new
 * distinct-key event immediately contributes without waiting for its
 * run to close.
 */
export async function countEpisodesPagewise(
  source: PagewiseEventSource,
  opts: { since: number; until: number; guardId?: string; ownerUserId: string },
  k: number,
  gapMs: number = EPISODE_GAP_MS,
  /**
   * Optional per-event eligibility filter. Events that fail the filter are
   * still counted as `rawEventsSeen` (they were scanned from Redis) but are
   * NOT fed to the episode tracker — they don't form or extend episodes.
   *
   * Use case: skip-reason eligibility (dedup_active events are informational,
   * not harmful rejections — they must not contribute to the 3/7d threshold).
   *
   * Default: all events are eligible (backward compatible).
   */
  eventFilter?: (event: GuardRejectionEvent) => boolean,
): Promise<PagewiseEpisodeResult> {
  const stats = { pagesFetched: 0 };
  const tracker = new EpisodeBoundaryTracker(gapMs);
  let rawEventsSeen = 0;
  let skippedByFilter = 0;

  for await (const event of source.iterateWindow(opts, stats)) {
    rawEventsSeen++;
    if (rawEventsSeen > HARD_QUERY_CAP) {
      return {
        episodeCount: Math.min(tracker.lowerBound, k),
        isLowerBound: true,
        rawEventsSeen,
        pagesFetched: stats.pagesFetched,
        earlyStopReason: 'hard_cap',
        ...(skippedByFilter > 0 ? { skippedByFilter } : {}),
      };
    }
    // Eligibility filter: non-eligible events are observed but don't form episodes.
    if (eventFilter && !eventFilter(event)) {
      skippedByFilter++;
      continue;
    }
    tracker.feed(event);
    if (tracker.lowerBound >= k) {
      return {
        episodeCount: k,
        isLowerBound: true,
        rawEventsSeen,
        pagesFetched: stats.pagesFetched,
        earlyStopReason: 'threshold_met',
        ...(skippedByFilter > 0 ? { skippedByFilter } : {}),
      };
    }
  }

  return {
    episodeCount: tracker.lowerBound,
    isLowerBound: false,
    rawEventsSeen,
    pagesFetched: stats.pagesFetched,
    ...(skippedByFilter > 0 ? { skippedByFilter } : {}),
  };
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
 * Delegates to `EpisodeBoundaryTracker` for all key/gap/trusted
 * semantics (Fable ruling: single state machine, zero independent logic).
 */
export function coalesceGuardEpisodes(events: GuardRejectionEvent[], gapMs: number = EPISODE_GAP_MS): GuardEpisode[] {
  // Stable total order: timestamp asc, tie-break by eventId (per-event coordinate).
  const sorted = [...events].sort(
    (a, b) => a.timestamp - b.timestamp || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );

  const tracker = new EpisodeBoundaryTracker(gapMs);
  const episodes: GuardEpisode[] = [];
  /** groupKey → open run of chained events (chronological). */
  const openRuns = new Map<string, GuardRejectionEvent[]>();

  for (const event of sorted) {
    const result = tracker.feed(event);
    if (result.kind === 'solo') {
      episodes.push(buildEpisode([event]));
    } else if (result.kind === 'start') {
      if (result.closedPrevious) {
        episodes.push(buildEpisode(openRuns.get(result.groupKey!)!));
      }
      openRuns.set(result.groupKey!, [event]);
    } else {
      // 'extend' — append to open run
      openRuns.get(result.groupKey!)!.push(event);
    }
  }
  for (const run of openRuns.values()) episodes.push(buildEpisode(run));

  // Deterministic output order independent of grouping traversal.
  episodes.sort((a, b) => a.startMs - b.startMs || (a.episodeId < b.episodeId ? -1 : 1));
  return episodes;
}
