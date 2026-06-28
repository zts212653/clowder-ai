/**
 * F192 Phase D — C1 hold per-fire sample evidence (split per
 * verdict `2026-06-18-eval-a2a-c1-zombie-hold-semantics-fix` from砚砚).
 *
 * History: PR #2244 (verdict `2026-06-12-eval-a2a-c1-zombie-hold-samples-build`)
 * shipped a single extractor for `c1.zombie_hold_fired` covering all
 * single-slot replacement cancellations. The 2026-06-18 eval then showed
 * 3/4 fires were `prior_long` and 1/4 `prior_short` (i.e. benign replacement
 * churn), with `prior_overdue`/`prior_imminent` (true zombies) at 0. The
 * single counter was conflating actionable zombie suppression with expected
 * single-slot churn. Split:
 *
 *   - `c1.hold_zombie_count` + `c1.hold_zombie_fired`
 *     (wake-delay bucket `prior_overdue` / `prior_imminent` — actionable)
 *   - `c1.hold_replacement_count` + `c1.hold_replacement_fired`
 *     (wake-delay bucket `prior_short` / `prior_long` — benign churn)
 *
 * Both event payloads share the same schema as the legacy `c1.zombie_hold_fired`:
 *   - threadId / invocationId — HMAC pseudonymized by RedactingSpanProcessor (Class C)
 *   - priorTaskIdHash / newTaskIdHash — manually HMAC-hashed by route handler
 *     (taskId is not in the Class C allowlist; `Hash` suffix makes the redaction
 *     explicit in the artifact)
 *   - AGENT_ID / THREAD_SYSTEM_KIND — Class D semconv labels (passthrough)
 *   - TRIGGER — wake-delay bucket id from `bucketWakeDelay()`. Each extractor
 *     only sees its allowed subset, so trigger never crosses the actionable /
 *     benign boundary.
 *
 * Discipline single-sourced via `extractPerFireSamples` generic helper.
 *
 * Authority boundary: F192 enrichment layer — no new data store. Reads only what
 * `/api/telemetry/traces` exposes after RedactingSpanProcessor pseudonymizes ids.
 *
 * No legacy alias for `c1.zombie_hold_fired`: producer migrated atomically in
 * the same PR, and historical eval bundles in `docs/harness-feedback/bundles/`
 * are frozen evidence of the pre-split state — leave them in place.
 */

import type { PerFireSample, PerFireSampleCap } from './c2-sample-evidence.js';
import { DEFAULT_C2_SAMPLE_CAP, extractPerFireSamples } from './c2-sample-evidence.js';
import type { EvalTraceSpan } from './telemetry-adapter.js';

export const C1_HOLD_ZOMBIE_EVENT_NAME = 'c1.hold_zombie_fired';
export const C1_HOLD_REPLACEMENT_EVENT_NAME = 'c1.hold_replacement_fired';

/**
 * Shared cap (re-exported from C2). Same numbers; both C1 sub-extractors
 * inherit identical per-trigger / total bounds.
 */
export const DEFAULT_C1_HOLD_SAMPLE_CAP: PerFireSampleCap = DEFAULT_C2_SAMPLE_CAP;

/**
 * F192 Phase D R1 P1-1 fix (砚砚): C1-specific extra hashed attrs that must
 * survive into the attribution artifact / YAML render. These are emitted on
 * the span event by `callback-hold-ball-routes.ts` and were previously lost
 * by the generic extractor's fixed-shape parse. Both zombie and replacement
 * extractors share the same key set since the underlying span payload is
 * identical (route emits the same attrs at the cancellation point).
 */
export const C1_HOLD_EXTRA_ATTR_KEYS: readonly string[] = ['priorTaskIdHash', 'newTaskIdHash'];

/**
 * Extract `c1.hold_zombie_fired` per-fire samples — true-zombie cancellations
 * only (wake-delay bucket `prior_overdue` or `prior_imminent`).
 */
export function extractC1HoldZombieSamples(
  spans: ReadonlyArray<EvalTraceSpan>,
  cap: PerFireSampleCap = DEFAULT_C1_HOLD_SAMPLE_CAP,
): PerFireSample[] {
  return extractPerFireSamples(spans, C1_HOLD_ZOMBIE_EVENT_NAME, cap, C1_HOLD_EXTRA_ATTR_KEYS);
}

/**
 * Extract `c1.hold_replacement_fired` per-fire samples — benign single-slot
 * replacement churn (wake-delay bucket `prior_short` or `prior_long`).
 */
export function extractC1HoldReplacementSamples(
  spans: ReadonlyArray<EvalTraceSpan>,
  cap: PerFireSampleCap = DEFAULT_C1_HOLD_SAMPLE_CAP,
): PerFireSample[] {
  return extractPerFireSamples(spans, C1_HOLD_REPLACEMENT_EVENT_NAME, cap, C1_HOLD_EXTRA_ATTR_KEYS);
}
