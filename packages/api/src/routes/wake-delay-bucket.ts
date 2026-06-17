/**
 * F192 Phase D — eval:a2a 2026-06-12 build verdict: bucket a hold task's
 * remaining wake-delay into a stable trigger category for C1 zombie-hold
 * per-fire sample evidence.
 *
 * Mechanical 4-bucket classification (no semantic interpretation):
 *   - `prior_overdue`  — prior.fireAt < now  (scheduler stuck or rapid back-to-back)
 *   - `prior_imminent` — prior was about to fire (<60s)  (likely interrupted)
 *   - `prior_short`    — prior was 1-5min from firing
 *   - `prior_long`     — prior was ≥5min from firing (likely real intent change)
 *
 * Bucket ids are stable wire-format strings consumed by attribution / dashboards;
 * renaming is a breaking change.
 */

export const WAKE_DELAY_BUCKETS = ['prior_overdue', 'prior_imminent', 'prior_short', 'prior_long'] as const;
export type WakeDelayBucket = (typeof WAKE_DELAY_BUCKETS)[number];

const IMMINENT_MS = 60_000;
const SHORT_MS = 5 * 60_000;

/**
 * Bucket the remaining wake-delay (`fireAt - now`) into a stable trigger id.
 *
 * Boundary discipline (砚砚 sanity check, mechanical):
 *   - `delta <  0`           → `prior_overdue`  (boundary inclusive of 0 on next bucket)
 *   - `delta <  60_000`      → `prior_imminent` (sub-minute)
 *   - `delta <  300_000`     → `prior_short`    (sub-5-min, excluding sub-1-min)
 *   - `delta >= 300_000`     → `prior_long`
 *
 * Boundary cases (delta = 0, delta = 60000, delta = 300000) attribute to the
 * higher bucket — sharp threshold, no double-counting.
 */
export function bucketWakeDelay(priorFireAtMs: number, nowMs: number): WakeDelayBucket {
  const delta = priorFireAtMs - nowMs;
  if (delta < 0) return 'prior_overdue';
  if (delta < IMMINENT_MS) return 'prior_imminent';
  if (delta < SHORT_MS) return 'prior_short';
  return 'prior_long';
}
