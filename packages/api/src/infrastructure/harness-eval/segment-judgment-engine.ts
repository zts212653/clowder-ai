/**
 * F257 Segment Judgment Engine — deterministic per-segment verdict producer.
 *
 * Consumes two data sources:
 *   1. HarnessLedgerRunSnapshot (guard rejection events, from snapshot provider)
 *   2. InjectionTraceStore.queryWindow (per-segment injection traces)
 *
 * Produces SegmentJudgment[] following frozen judgment-schema-v1 (§2).
 *
 * Verdict rules are DETERMINISTIC (no LLM) — the eval cat receives these
 * as precomputed evidence alongside the guard event snapshot.
 *
 * Correlation: threadId + catId + [timestamp ± W] (v1 = window, W = 120s).
 * correlationConfidence always 'window' in v1.
 *
 * Integration point: called after produceHarnessLedgerRunSnapshot(),
 * before eval cat invocation (trigger-now / eval-domain-daily).
 */

import type { InjectionTraceSummary, SegmentVerdict } from '@cat-cafe/shared';
import type { InjectionTraceStore } from '../../domains/prompt-hooks/InjectionTraceStore.js';
import { isFiredTraceSegment } from '../../domains/prompt-hooks/injection-trace-semantics.js';
import type { HarnessLedgerRunSnapshot } from './harness-ledger-snapshot-provider.js';

// ---------------------------------------------------------------------------
// Types (judgment schema v1 §2)
// ---------------------------------------------------------------------------

// SegmentVerdict vocabulary is canonical in @cat-cafe/shared (single source of truth
// for engine + Console). Re-exported here for existing consumers (e.g. SegmentJudgmentCache).
export type { SegmentVerdict };

export interface CountWithProvenance {
  value: number;
  how_counted: string;
}

export interface SegmentJudgment {
  judgmentId: string;
  segmentId: string;
  segmentVersion: number | null;
  window: { startMs: number; endMs: number };
  verdict: SegmentVerdict;
  evidence: {
    injectionCount: CountWithProvenance;
    violationCount: CountWithProvenance;
    denominatorKind: 'fired-count' | 'session-count' | 'none';
    eventRefs: string[];
    correlationConfidence: 'window' | 'exact';
  };
  pressure: {
    observabilityDeadline: string | null;
    nextRequiredAction: string | null;
  };
  producedBy: { domainId: string; runId: string; evalCat: string };
}

// ---------------------------------------------------------------------------
// Engine input
// ---------------------------------------------------------------------------

/** Raw guard rejection event for per-event correlation. */
export interface RawGuardEvent {
  eventId: string;
  guardId: string;
  threadId: string;
  catId: string;
  timestamp: number;
}

export interface JudgmentEngineInput {
  snapshot: HarnessLedgerRunSnapshot;
  evalCat: string;
  /** Thread IDs to scan for injection traces (from thread store or guard events). */
  threadIds: string[];
  /**
   * Raw guard events for per-event timestamp correlation.
   * When provided, enables per-segment violationCount via ±120s window join.
   * When absent, falls back to snapshot.totalEvents as aggregate (less precise).
   */
  rawGuardEvents?: RawGuardEvent[];
}

export interface JudgmentEngineDeps {
  traceStore: InjectionTraceStore;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Correlation window half-width (±120s). judgment schema v1 §1. */
const CORRELATION_WINDOW_MS = 120_000;
/** Max event refs per judgment (schema says "抽样上限 20"). */
const MAX_EVENT_REFS = 20;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce per-segment judgments from guard events + injection traces.
 *
 * Steps:
 *   1. Query injection traces for all threads in the window
 *   2. Collect all unique segments observed across traces
 *   3. For each segment: count injections, correlate guard events, apply verdict
 *   4. Return SegmentJudgment[]
 */
export async function produceSegmentJudgments(
  deps: JudgmentEngineDeps,
  input: JudgmentEngineInput,
): Promise<SegmentJudgment[]> {
  const { snapshot, evalCat, threadIds } = input;
  const { startMs, endMs } = snapshot.window;

  // 1. Collect all injection traces in the window across threads
  const allTraces: InjectionTraceSummary[] = [];
  for (const threadId of threadIds) {
    const traces = await deps.traceStore.queryWindow(threadId, startMs, endMs);
    allTraces.push(...traces);
  }

  if (allTraces.length === 0) {
    return []; // No traces = nothing to judge
  }

  // 2. Aggregate per-segment: injectionCount + observed versions
  const segmentStats = aggregateSegmentStats(allTraces);

  // 3. Build guard event index for correlation
  const guardEventIndex = buildGuardEventIndex(input.rawGuardEvents);

  // 4. For each segment, correlate and produce judgment
  const judgments: SegmentJudgment[] = [];
  let seq = 1;
  const datePrefix = snapshot.producedAt.slice(0, 10).replace(/-/g, '');

  for (const [, stats] of segmentStats.entries()) {
    // Correlate: find guard events whose timestamp is within ±120s
    // of any trace where this segment was fired
    const correlated = correlateGuardEvents(stats.firedTimestamps, guardEventIndex);

    const judgment = produceVerdict({
      judgmentId: `sj-${datePrefix}-${String(seq).padStart(3, '0')}`,
      segmentId: stats.segmentId,
      segmentVersion: stats.version,
      window: { startMs, endMs },
      injectionCount: stats.firedCount,
      violationCount: correlated.count,
      eventRefs: correlated.eventRefs,
      evalRunId: snapshot.evalRunId,
      evalCat,
    });

    judgments.push(judgment);
    seq++;
  }

  return judgments;
}

// ---------------------------------------------------------------------------
// Internal: per-segment aggregation
// ---------------------------------------------------------------------------

interface SegmentStats {
  segmentId: string;
  firedCount: number;
  /** Timestamps of traces where this segment was fired (for correlation). */
  firedTimestamps: Array<{ threadId: string; catId: string; timestamp: number }>;
  version: number | null;
}

/** IDs that represent v0 fallback data, not per-hook segments. */
const SKIP_SEGMENT_IDS = new Set(['per-turn-aggregate', 'session-init-pack-only']);

/** Composite key for per-version grouping (R7). */
function segmentVersionKey(segmentId: string, version: number | null): string {
  return version != null ? `${segmentId}::${version}` : segmentId;
}

/** @deprecated Legacy judgment compatibility only. New consumers use raw-trace semantics directly. */
export const isFired = isFiredTraceSegment;

function aggregateSegmentStats(traces: InjectionTraceSummary[]): Map<string, SegmentStats> {
  const stats = new Map<string, SegmentStats>();

  for (const trace of traces) {
    for (const seg of trace.segments) {
      if (SKIP_SEGMENT_IDS.has(seg.segmentId)) continue;

      // R7: group by (segmentId, version) composite key so traces from
      // different versions produce independent judgments instead of one
      // mixed-metric judgment. Traces without version fall back to bare segmentId.
      const key = segmentVersionKey(seg.segmentId, seg.version ?? null);
      let entry = stats.get(key);
      if (!entry) {
        entry = { segmentId: seg.segmentId, firedCount: 0, firedTimestamps: [], version: seg.version ?? null };
        stats.set(key, entry);
      }

      if (isFired(seg)) {
        entry.firedCount++;
        entry.firedTimestamps.push({
          threadId: trace.threadId,
          catId: trace.catId,
          timestamp: trace.timestamp,
        });
      }
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Internal: guard event correlation
// ---------------------------------------------------------------------------

interface GuardEventEntry {
  eventId: string;
  guardId: string;
  threadId: string;
  catId: string;
  timestamp: number;
}

function buildGuardEventIndex(rawEvents?: RawGuardEvent[]): GuardEventEntry[] {
  // Raw events carry full threadId/catId for v1 three-key correlation.
  // sampleAnchors lack threadId/catId and CANNOT satisfy the frozen v1 join
  // contract (threadId + catId + ±120s). Returning them with empty strings
  // would produce false attribution across threads/cats. When raw events are
  // absent, return empty → violationCount = 0 with explicit evidence gap.
  if (!rawEvents || rawEvents.length === 0) return [];
  return rawEvents.map((e) => ({
    eventId: e.eventId,
    guardId: e.guardId,
    threadId: e.threadId,
    catId: e.catId,
    timestamp: e.timestamp,
  }));
}

interface CorrelationResult {
  count: number;
  eventRefs: string[];
}

function correlateGuardEvents(
  firedTimestamps: Array<{ threadId: string; catId: string; timestamp: number }>,
  guardEvents: GuardEventEntry[],
): CorrelationResult {
  if (firedTimestamps.length === 0 || guardEvents.length === 0) {
    return { count: 0, eventRefs: [] };
  }

  // v1 three-key correlation (frozen schema §1):
  //   join = threadId + catId + [timestamp ± CORRELATION_WINDOW_MS]
  // All three must match. Guard events without threadId/catId never enter
  // the index (buildGuardEventIndex drops sampleAnchors).
  const matchedEventIds = new Set<string>();

  for (const guard of guardEvents) {
    for (const fired of firedTimestamps) {
      const sameThread = guard.threadId === fired.threadId;
      const sameCat = guard.catId === fired.catId;
      const withinWindow = Math.abs(guard.timestamp - fired.timestamp) <= CORRELATION_WINDOW_MS;
      if (sameThread && sameCat && withinWindow) {
        matchedEventIds.add(guard.eventId);
        break;
      }
    }
  }

  return {
    count: matchedEventIds.size,
    eventRefs: [...matchedEventIds].slice(0, MAX_EVENT_REFS),
  };
}

// ---------------------------------------------------------------------------
// Internal: verdict rules (judgment schema v1, deterministic)
// ---------------------------------------------------------------------------

interface VerdictInput {
  judgmentId: string;
  segmentId: string;
  segmentVersion: number | null;
  window: { startMs: number; endMs: number };
  injectionCount: number;
  violationCount: number;
  eventRefs: string[];
  evalRunId: string;
  evalCat: string;
}

function produceVerdict(input: VerdictInput): SegmentJudgment {
  const hasDenominator = input.injectionCount > 0;
  const denominatorKind: 'fired-count' | 'none' = hasDenominator ? 'fired-count' : 'none';

  // Verdict rules (v1, single-window deterministic):
  // - injectionCount > 0 → 'alive' (segment fires, violation rate computable)
  //   violationRate = 0% is a valid alive measurement, not unmeasurable.
  // - injectionCount == 0 → 'unmeasurable' (no denominator, cannot compute rate)
  // - 'dormant' requires consecutive 2 zero-fire periods — single window can't determine.
  //   Eval cat upgrades alive→dormant when it has cross-window history.
  const verdict: SegmentVerdict = hasDenominator ? 'alive' : 'unmeasurable';

  return {
    judgmentId: input.judgmentId,
    segmentId: input.segmentId,
    segmentVersion: input.segmentVersion,
    window: input.window,
    verdict,
    evidence: {
      injectionCount: {
        value: input.injectionCount,
        how_counted: 'injection-trace-store-queryWindow-fired-count',
      },
      violationCount: {
        value: input.violationCount,
        how_counted: 'guard-rejection-snapshot-window-correlation-120s',
      },
      denominatorKind,
      eventRefs: input.eventRefs,
      correlationConfidence: 'window',
    },
    pressure: {
      observabilityDeadline: null,
      nextRequiredAction: null,
    },
    producedBy: {
      domainId: 'eval:harness-ledger',
      runId: input.evalRunId,
      evalCat: input.evalCat,
    },
  };
}
