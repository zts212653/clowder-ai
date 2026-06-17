/**
 * F192 Phase D — C2 void-hold per-fire sample evidence extractor.
 *
 * Verdict 2026-06-10-eval-a2a-c2-void-hold-samples-build: labeled aggregate counters
 * (`{agent_id, thread_system_kind, trigger}`) tell us how many C2 void-hold-hint fires
 * happened but not which messages they were. Per-fire samples close that gap:
 * route-serial emits a `c2.void_hold_fired` span event at the same point as the
 * counter `add`, carrying raw IDs that RedactingSpanProcessor HMACs into
 * `messageId/invocationId/threadId` (Class C) before the event reaches LocalTraceStore.
 *
 * Parallel to `c2-sample-evidence.ts` (which handles `verdict_without_pass` fires).
 * Shares the same wire shape and capping discipline via `extractPerFireSamples`.
 *
 * Authority boundary: F192 enrichment layer — no new data store, no schema migration
 * to F153/ADR-032. Reads only what `/api/telemetry/traces` already exposes.
 */

import type { PerFireSample, PerFireSampleCap } from './c2-sample-evidence.js';
import { DEFAULT_C2_SAMPLE_CAP, extractPerFireSamples } from './c2-sample-evidence.js';
import type { EvalTraceSpan } from './telemetry-adapter.js';

export const C2_VOID_HOLD_EVENT_NAME = 'c2.void_hold_fired';

/** Re-export the shared cap default so void-hold callers don't need to import from two files. */
export const DEFAULT_C2_VOID_HOLD_SAMPLE_CAP: PerFireSampleCap = DEFAULT_C2_SAMPLE_CAP;

/**
 * Extract `c2.void_hold_fired` per-fire samples from a span set.
 *
 * Identical shape and discipline to `extractC2VerdictWithoutPassSamples`:
 * same `PerFireSample` schema (HMAC ids, semconv labels, trigger), same
 * ordering (firedAt desc → spanId asc), same capping (per-trigger then total).
 *
 * Trigger values are HOLD_PATTERN ids defined in `void-hold-detect.ts`
 * (e.g. `cn_chiqiu`, `en_hold_ball_underscore`, `mcp_tool_name`) — see
 * `HOLD_PATTERN_IDS` for the stable allowlist.
 */
export function extractC2VoidHoldSamples(
  spans: ReadonlyArray<EvalTraceSpan>,
  cap: PerFireSampleCap = DEFAULT_C2_VOID_HOLD_SAMPLE_CAP,
): PerFireSample[] {
  return extractPerFireSamples(spans, C2_VOID_HOLD_EVENT_NAME, cap);
}
