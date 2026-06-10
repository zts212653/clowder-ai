/**
 * F192 Phase D — C2 per-fire sample evidence extractor.
 *
 * Verdict 2026-06-08-eval-a2a-c2-sample-evidence-build: labeled aggregate counters
 * (`{agent_id, thread_system_kind, trigger}`) tell us how many C2 verdict-without-pass
 * fires happened but not which messages they were. Per-fire samples close that gap:
 * route-serial emits a `c2.verdict_without_pass_fired` span event at the same point
 * as the counter `add`, carrying raw IDs that RedactingSpanProcessor HMACs into
 * `messageId/invocationId/threadId` (Class C) before the event reaches LocalTraceStore.
 *
 * This extractor consumes those redacted span events and produces ordered, capped
 * samples for attribution evidence and drilldown.
 *
 * Authority boundary: F192 enrichment layer — no new data store, no schema migration
 * to F153/ADR-032. Reads only what `/api/telemetry/traces` already exposes.
 */

import type { EvalTraceSpan } from './telemetry-adapter.js';

export const C2_SAMPLE_EVENT_NAME = 'c2.verdict_without_pass_fired';

export interface PerFireSample {
  // Primary raw locators — OTel standard, never HMAC'd (Class D passthrough)
  traceId: string;
  spanId: string;
  // Secondary correlation — Class C, HMAC'd by RedactingSpanProcessor.
  // Field names end in `Hash` to make the redaction explicit in the artifact
  // (a reviewer reading `messageId` would assume raw — `messageIdHash` cannot
  // be misread).
  messageIdHash: string;
  invocationIdHash: string;
  threadIdHash: string;
  // Labels — Class D passthrough (allowlist metric attributes)
  agentId: string;
  threadSystemKind: string;
  trigger: string;
  // Derived from OTel `event.timeMs` (never runtime `Date.now()` — single
  // source of truth, no drift between counter time and event time).
  firedAt: string; // ISO 8601 UTC
}

export interface PerFireSampleCap {
  /** Hard cap on total samples returned across all triggers. */
  total: number;
  /** Hard cap on samples per `trigger` bucket. */
  perTrigger: number;
}

export const DEFAULT_C2_SAMPLE_CAP: PerFireSampleCap = { total: 10, perTrigger: 5 };

/**
 * Extract `c2.verdict_without_pass_fired` per-fire samples from a span set.
 *
 * Ordering: `firedAt desc → spanId asc` (most recent first, deterministic tiebreak).
 * Capping (砚砚 sanity check, strict interpretation of "先每个 trigger bucket 至多 5"):
 *   1. Per-trigger cap is a hard ceiling — at most `cap.perTrigger` samples
 *      from any single trigger; later fires within an over-cap bucket are dropped.
 *   2. Total cap is a separate hard ceiling — at most `cap.total` overall.
 *   3. Both caps applied during a single newest-first pass; no overflow promotion.
 *
 * Why strict per-trigger: one noisy trigger (e.g. a regex hot-spot) must not
 * starve other buckets of evidence slots. Low-volume scenarios still get full
 * coverage (06-08: 3 triggers × 1 fire = 3 samples ≤ both caps).
 */
export function extractC2VerdictWithoutPassSamples(
  spans: ReadonlyArray<EvalTraceSpan>,
  cap: PerFireSampleCap = DEFAULT_C2_SAMPLE_CAP,
): PerFireSample[] {
  const samples: PerFireSample[] = [];
  for (const span of spans) {
    for (const event of span.events ?? []) {
      if (event.name !== C2_SAMPLE_EVENT_NAME) continue;
      const attrs = event.attributes ?? {};
      // Defensive parse — required fields must be strings; absent/wrong type → skip
      const messageIdHash = stringAttr(attrs, 'messageId');
      const invocationIdHash = stringAttr(attrs, 'invocationId');
      const threadIdHash = stringAttr(attrs, 'threadId');
      const agentId = stringAttr(attrs, 'agent.id') ?? stringAttr(attrs, 'agentId');
      const threadSystemKind = stringAttr(attrs, 'thread.system_kind') ?? stringAttr(attrs, 'threadSystemKind');
      const trigger = stringAttr(attrs, 'trigger');
      // local R1 P1-3 fix (砚砚): threadId is required for drilldown — without it the
      // helper has no scope to limit message HMAC scan; surfacing samples with empty
      // threadIdHash would advertise a join key we can't honor. Skip the row instead.
      if (messageIdHash == null || trigger == null || threadIdHash == null) continue;
      samples.push({
        traceId: span.traceId,
        spanId: span.spanId,
        messageIdHash,
        invocationIdHash: invocationIdHash ?? '',
        threadIdHash,
        agentId: agentId ?? '',
        threadSystemKind: threadSystemKind ?? '',
        trigger,
        firedAt: new Date(event.timeMs).toISOString(),
      });
    }
  }
  // Sort: firedAt desc → spanId asc
  samples.sort((a, b) => {
    if (a.firedAt !== b.firedAt) return a.firedAt < b.firedAt ? 1 : -1;
    return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0;
  });
  return capByTriggerThenTotal(samples, cap);
}

function stringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === 'string' ? v : null;
}

function capByTriggerThenTotal(sorted: ReadonlyArray<PerFireSample>, cap: PerFireSampleCap): PerFireSample[] {
  const counts: Record<string, number> = Object.create(null);
  const result: PerFireSample[] = [];
  for (const s of sorted) {
    if (result.length >= cap.total) break; // total cap (hard)
    const c = counts[s.trigger] ?? 0;
    if (c >= cap.perTrigger) continue; // per-trigger cap (hard) — overflow discarded, not promoted
    counts[s.trigger] = c + 1;
    result.push(s);
  }
  return result;
}

/** Bucket per-fire samples by trigger for finding-level rendering. */
export function groupSamplesByTrigger(samples: ReadonlyArray<PerFireSample>): Record<string, PerFireSample[]> {
  const out: Record<string, PerFireSample[]> = {};
  for (const s of samples) {
    (out[s.trigger] ??= []).push(s);
  }
  return out;
}
