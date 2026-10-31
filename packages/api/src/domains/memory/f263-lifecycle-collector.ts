// F263 Phase C: Lifecycle trace collector
//
// Hooks into RecallEvent persistence to produce:
// - C4: unmet demand traces (true_zero / null_count / not_written / parser_miss)
// - C3: first real verification events (zero-hit confirmation)
//
// Called after RecallEventCorrelator.persistBatch() with the finalized events.

import type { RecallEvent } from './f200-types.js';
import type { SourceFamily, UnmetDemandBucket } from './f263-lifecycle-types.js';
import type { LifecycleTraceStore } from './LifecycleTraceStore.js';

/** Operational outcome statuses that must NOT enter unmet demand bucketing. */
const OPERATIONAL_STATUSES: ReadonlySet<string> = new Set(['error', 'overflow']);

/**
 * Classify a RecallEvent's zero-hit status into the correct unmet demand bucket.
 *
 * Contract (AC-C4):
 * - true_zero: F200 observed resultCount=0 AND resultStatus='no_results'
 * - null_count: resultCount is null/undefined (field not present)
 * - not_written: resultStatus is 'legacy_unknown' or 'result_unmerged'
 * - parser_miss: resultStatus is 'parser_miss'
 * - returns null if the event has results (not an unmet demand)
 */
export function classifyUnmetDemand(event: RecallEvent): UnmetDemandBucket | null {
  // Has results → not unmet demand
  if (event.candidates.length > 0) return null;
  if (event.resultCount != null && event.resultCount > 0) return null;

  // Bucket by resultStatus
  const status = event.resultStatus;

  if (status === 'no_results' && event.resultCount === 0) {
    return 'true_zero';
  }

  if (status === 'parser_miss') {
    return 'parser_miss';
  }

  if (status === 'legacy_unknown' || status === 'result_unmerged') {
    return 'not_written';
  }

  // Error / overflow are operational outcomes, not unmet demand observations.
  // error = tool call failed; overflow = too many results (artifact-based).
  // Both can have null resultCount + empty candidates, but they must not
  // enter the null_count bucket (which tracks missing telemetry).
  if (OPERATIONAL_STATUSES.has(status as string)) return null;

  // resultCount is null and no other signal → null_count
  if (event.resultCount == null) {
    return 'null_count';
  }

  return null;
}

/**
 * Map RecallEvent toolName to SourceFamily.
 */
function toSourceFamily(toolName: string): SourceFamily {
  const map: Record<string, SourceFamily> = {
    search_evidence: 'search_evidence',
    graph_resolve: 'graph_resolve',
    list_recent: 'list_recent',
    session_bootstrap: 'session_bootstrap',
    cold_context: 'cold_context',
  };
  return map[toolName] ?? 'search_evidence';
}

/**
 * Collect lifecycle traces from finalized RecallEvents.
 *
 * Call this after persistBatch() in the recall correlation pipeline.
 * All produced traces are storable:false / indexable:false by definition
 * (the lifecycle_traces table enforces this structurally).
 *
 * Idempotency: each trace carries the RecallEvent's sourceEventId (generated
 * at correlator level from _toolUseId or invocationId:turnIndex). The
 * UNIQUE(source_event_id, kind) index + INSERT OR IGNORE ensures replays
 * of the same source event are silently skipped at both recall_events and
 * lifecycle_traces layers.
 */
export function collectLifecycleTraces(
  store: LifecycleTraceStore,
  recallEvents: RecallEvent[],
): { unmetDemandCount: number; verificationCount: number } {
  let unmetDemandCount = 0;
  let verificationCount = 0;

  for (const event of recallEvents) {
    const bucket = classifyUnmetDemand(event);
    if (bucket == null) continue;

    const sourceFamily = toSourceFamily(event.toolName);
    // Use the stable sourceEventId from the correlator (not a locally derived key)
    const sourceEventId = event.sourceEventId ?? null;

    // C4: Unmet demand trace
    store.append({
      kind: 'unmet_demand',
      category: bucket,
      sourceFamily,
      recallId: event.recallId,
      sourceEventId,
      threadId: event.threadId || null,
      queryText: event.query || null,
      payload: {
        toolName: event.toolName,
        mode: event.mode ?? null,
        scope: event.scope ?? null,
        resultStatus: event.resultStatus ?? null,
        resultCount: event.resultCount ?? null,
      },
      observedAt: event.timestamp,
    });
    unmetDemandCount++;

    // C3: Verification event — confirm the zero-hit observation
    // Only for true_zero: the other buckets are noise, not confirmed observations.
    if (bucket === 'true_zero') {
      store.append({
        kind: 'verification',
        sourceFamily,
        recallId: event.recallId,
        sourceEventId,
        threadId: event.threadId || null,
        targetAnchor: event.query ? `query:${event.query.slice(0, 200)}` : `tool:${event.toolName}`,
        claimKind: 'unmet-demand',
        checkSource: 'recall-correlation-zero-hit',
        verdict: 'confirmed',
        payload: {
          toolName: event.toolName,
          query: event.query,
          resultStatus: event.resultStatus,
        },
        observedAt: event.timestamp,
      });
      verificationCount++;
    }
  }

  return { unmetDemandCount, verificationCount };
}
