/**
 * F192 Phase D — C1 zombie-hold per-fire sample evidence extractor.
 *
 * Verdict 2026-06-12-eval-a2a-c1-zombie-hold-samples-build (PR #2244): labeled
 * aggregate counter `c1.zombie_hold_count` shows 5/7 replacements (71.4%) on the
 * 2026-06-12 F167 eval but doesn't tell which cancellations were "true zombies"
 * vs "intentional renewals" with extended wake delays.
 *
 * `callback-hold-ball-routes.ts` emits a `c1.zombie_hold_fired` span event at the
 * single-slot replacement point (same point as the counter `add`), carrying:
 *   - threadId / invocationId — HMAC pseudonymized by RedactingSpanProcessor (Class C)
 *   - priorTaskIdHash / newTaskIdHash — manually HMAC-hashed by route handler
 *     (taskId is not in the Class C allowlist; `Hash` suffix makes the redaction
 *     explicit in the artifact)
 *   - AGENT_ID / THREAD_SYSTEM_KIND — Class D semconv labels (passthrough)
 *   - TRIGGER — wake-delay bucket id from `bucketWakeDelay()`
 *     (`prior_overdue` / `prior_imminent` / `prior_short` / `prior_long`)
 *
 * Parallel to `c2-void-hold-sample-evidence.ts` and `c2-sample-evidence.ts`.
 * Discipline single-sourced via `extractPerFireSamples` generic helper.
 *
 * Authority boundary: F192 enrichment layer — no new data store. Reads only what
 * `/api/telemetry/traces` exposes after RedactingSpanProcessor pseudonymizes ids.
 */

import type { PerFireSample, PerFireSampleCap } from './c2-sample-evidence.js';
import { DEFAULT_C2_SAMPLE_CAP, extractPerFireSamples } from './c2-sample-evidence.js';
import type { EvalTraceSpan } from './telemetry-adapter.js';

export const C1_ZOMBIE_HOLD_EVENT_NAME = 'c1.zombie_hold_fired';

/** Re-export shared cap so C1 callers don't need to import from two files. */
export const DEFAULT_C1_ZOMBIE_HOLD_SAMPLE_CAP: PerFireSampleCap = DEFAULT_C2_SAMPLE_CAP;

/**
 * Extract `c1.zombie_hold_fired` per-fire samples from a span set.
 *
 * Identical shape and discipline to `extractC2VerdictWithoutPassSamples`:
 * same `PerFireSample` schema, same ordering (firedAt desc → spanId asc), same
 * capping (per-trigger then total).
 *
 * Trigger values are wake-delay bucket ids from `wake-delay-bucket.ts`. The C1
 * extractor's PerFireSample.trigger therefore differs in vocabulary from the C2
 * extractor (which uses HOLD_PATTERN ids / verdict keywords), but the
 * `trigger` field name is shared — attribution renders both under one schema.
 *
 * Note: `messageIdHash` is required by the shared extractor (fail-closed parse,
 * per 砚砚 R1 P1-3). For C1 the route handler emits the prior-task id under
 * `messageId` to satisfy that contract — drilldown will not resolve a chat
 * message (no message exists for a hold-ball POST), but the spanId/traceId pair
 * still anchors the fire row for human classification. The honest mapping is:
 *   - `messageIdHash` = HMAC(priorTaskId)   — semantically "what got cancelled"
 *   - additional event attrs `priorTaskIdHash` / `newTaskIdHash` carry the same
 *     information explicitly; `messageIdHash` is a contract-shaped duplicate.
 */
/**
 * F192 Phase D R1 P1-1 fix (砚砚): C1-specific extra hashed attrs that must
 * survive into the attribution artifact / YAML render. These are emitted on the
 * span event by `callback-hold-ball-routes.ts` and were previously lost by the
 * generic extractor's fixed-shape parse.
 */
export const C1_ZOMBIE_HOLD_EXTRA_ATTR_KEYS: readonly string[] = ['priorTaskIdHash', 'newTaskIdHash'];

export function extractC1ZombieHoldSamples(
  spans: ReadonlyArray<EvalTraceSpan>,
  cap: PerFireSampleCap = DEFAULT_C1_ZOMBIE_HOLD_SAMPLE_CAP,
): PerFireSample[] {
  return extractPerFireSamples(spans, C1_ZOMBIE_HOLD_EVENT_NAME, cap, C1_ZOMBIE_HOLD_EXTRA_ATTR_KEYS);
}
