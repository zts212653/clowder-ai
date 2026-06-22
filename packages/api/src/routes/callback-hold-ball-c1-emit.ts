/**
 * F167 C1 — per-prior-cancellation telemetry emitter.
 *
 * Extracted from `callback-hold-ball-routes.ts` to keep the route file under
 * the 350-line cap (砚砚 PR #2368 R1 P1 #3). The emitter is the bucket-routing
 * core for F192 verdict `2026-06-18-eval-a2a-c1-zombie-hold-semantics-fix`:
 * each prior pending hold cancelled by a new hold registration is graded by
 * `bucketWakeDelay()` and routed to one of two metric + span-event surfaces:
 *
 *   - `prior_overdue` / `prior_imminent` → `c1HoldZombieCount` +
 *     `c1.hold_zombie_fired` on span `cat_cafe.a2a.c1.hold_zombie_sample`
 *     (actionable: scheduler stuck or wake interrupted within 60s)
 *   - `prior_short` / `prior_long`       → `c1HoldReplacementCount` +
 *     `c1.hold_replacement_fired` on span
 *     `cat_cafe.a2a.c1.hold_replacement_sample` (benign single-slot churn per
 *     F167 Phase G KD-23)
 *
 * Per-fire sample span starts + immediately ends so RedactingSpanProcessor
 * (onEnd hook) HMAC-pseudonymizes the Class C ids (messageId / invocationId /
 * threadId) before LocalTraceStore stores them. priorTaskId / newTaskId are
 * NOT in the Class C allowlist — pre-hashed with explicit `Hash` suffix in
 * the attr keys, mirroring PerFireSample schema's messageIdHash convention.
 */

import { trace } from '@opentelemetry/api';
import {
  C1_HOLD_REPLACEMENT_EVENT_NAME,
  C1_HOLD_ZOMBIE_EVENT_NAME,
} from '../infrastructure/harness-eval/c1-hold-sample-evidence.js';
import { AGENT_ID, THREAD_SYSTEM_KIND, TRIGGER } from '../infrastructure/telemetry/genai-semconv.js';
import { hmacId } from '../infrastructure/telemetry/hmac.js';
import { c1HoldReplacementCount, c1HoldZombieCount } from '../infrastructure/telemetry/instruments.js';
import { bucketWakeDelay, type WakeDelayBucket } from './wake-delay-bucket.js';

export interface EmitC1HoldCancellationParams {
  readonly priorTaskId: string;
  readonly priorFireAtMs: number;
  readonly cancelNowMs: number;
  readonly newTaskId: string;
  readonly catId: string;
  readonly threadId: string;
  readonly threadSystemKind: string;
  readonly invocationId: string;
}

export interface EmitC1HoldCancellationResult {
  readonly wakeBucket: WakeDelayBucket;
  readonly isTrueZombie: boolean;
}

/**
 * Emit the counter + per-fire sample span event for a single prior-hold
 * cancellation. Returns the bucket + classification for the caller's log line.
 * Sample-span emission is best-effort — any throw inside the OTel tracer is
 * swallowed (telemetry must not impact the user-facing hold registration).
 */
export function emitC1HoldCancellation(params: EmitC1HoldCancellationParams): EmitC1HoldCancellationResult {
  const wakeBucket = bucketWakeDelay(params.priorFireAtMs, params.cancelNowMs);
  const isTrueZombie = wakeBucket === 'prior_overdue' || wakeBucket === 'prior_imminent';
  const labels: Record<string, string> = {
    [AGENT_ID]: params.catId,
    [THREAD_SYSTEM_KIND]: params.threadSystemKind,
    [TRIGGER]: wakeBucket,
  };
  if (isTrueZombie) {
    c1HoldZombieCount.add(1, labels);
  } else {
    c1HoldReplacementCount.add(1, labels);
  }
  const sampleSpanName = isTrueZombie
    ? 'cat_cafe.a2a.c1.hold_zombie_sample'
    : 'cat_cafe.a2a.c1.hold_replacement_sample';
  const sampleEventName = isTrueZombie ? C1_HOLD_ZOMBIE_EVENT_NAME : C1_HOLD_REPLACEMENT_EVENT_NAME;
  try {
    const sampleSpan = trace.getTracer('cat-cafe-api', '0.1.0').startSpan(sampleSpanName);
    sampleSpan.addEvent(sampleEventName, {
      messageId: params.priorTaskId,
      invocationId: params.invocationId,
      threadId: params.threadId,
      [AGENT_ID]: params.catId,
      [THREAD_SYSTEM_KIND]: params.threadSystemKind,
      [TRIGGER]: wakeBucket,
      priorTaskIdHash: hmacId(params.priorTaskId),
      newTaskIdHash: hmacId(params.newTaskId),
    });
    sampleSpan.end();
  } catch {
    /* best-effort sample emission */
  }
  return { wakeBucket, isTrueZombie };
}
