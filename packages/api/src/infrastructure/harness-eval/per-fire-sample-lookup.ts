/**
 * F192 Phase D — Per-fire sample drilldown helper.
 *
 * Verdict 2026-06-08-eval-a2a-c2-sample-evidence-build requires that
 * eval-artifact sample refs (HMAC ids + spanId/traceId) be drillable back to
 * the original turn for human classification of true no-pass vs false-positive.
 *
 * The helper provides that contract — bounded brute-force HMAC scan, no
 * persistent HMAC index. Fail-closed semantics: when lookup cannot be made
 * unambiguous, return `null` with an honest `status`, never guess.
 *
 * Authority boundary: F192 enrichment — no new data store. Caller injects
 * trace/message/invocation lookup hooks; helper does only the HMAC matching.
 */

import type { PerFireSample } from './c2-sample-evidence.js';
import { C2_SAMPLE_EVENT_NAME } from './c2-sample-evidence.js';
import type { EvalTraceSpan } from './telemetry-adapter.js';

export type DrillDownStatus =
  | 'hit'
  | 'span_not_found'
  | 'event_not_found_in_span'
  | 'thread_scope_missing'
  | 'message_lookup_unavailable'
  | 'message_not_found'
  | 'message_hash_mismatch'
  | 'multiple_candidates_fail_closed';

export interface DrillDownStatusByResource {
  message: DrillDownStatus;
  invocation: DrillDownStatus;
}

export interface DrillDownResult {
  span: EvalTraceSpan | null;
  /** Resolved per-fire sample reconstructed from span event attrs (mirrors what
   * `extractC2VerdictWithoutPassSamples` would have produced for this fire). */
  sample: PerFireSample | null;
  /** Raw message id (if HMAC scan resolved unambiguously). null when status != 'hit'. */
  messageId: string | null;
  /** Raw invocation id (if resolvable from same span context). */
  invocationId: string | null;
  status: DrillDownStatusByResource;
}

/** Injected dependency: resolve raw spanId/traceId to the stored span DTO. */
export interface DrillDownTraceLookup {
  getSpan: (params: { traceId: string; spanId: string }) => Promise<EvalTraceSpan | null> | EvalTraceSpan | null;
}

/** Injected dependency: enumerate candidate raw IDs for HMAC matching.
 *
 *  Implementation note: `listCandidateMessageIds` should be bounded — caller is
 *  expected to scope first by `threadIdHash` (HMAC-match the thread), then by
 *  recent N messages or time window within that thread. We do not enforce a
 *  window here because the appropriate bound depends on the store backend
 *  (Redis sorted set, in-memory ring, SQLite cursor).
 *
 *  Local R1 P1-3 (砚砚): `threadIdHash` is required in the scan opts so the
 *  caller cannot accidentally do a global time-window scan. Without it the
 *  helper would advertise a thread-scoped contract it cannot honor.
 */
export interface CandidateScanOpts {
  threadIdHash: string;
  aroundTimeMs: number;
  maxCandidates: number;
}

export interface DrillDownMessageLookup {
  listCandidateMessageIds: (opts: CandidateScanOpts) => Promise<string[]> | string[];
}

export interface DrillDownInvocationLookup {
  listCandidateInvocationIds: (opts: CandidateScanOpts) => Promise<string[]> | string[];
}

/** Caller provides the HMAC pseudonymization function (same one TelemetryRedactor uses). */
export type HmacFn = (raw: string) => string;

export interface DrillDownDeps {
  traceLookup: DrillDownTraceLookup;
  messageLookup?: DrillDownMessageLookup;
  invocationLookup?: DrillDownInvocationLookup;
  hmac: HmacFn;
  /** Default scan window cap (defaults to 500 — bounded brute-force per 砚砚 spec). */
  maxCandidates?: number;
  /**
   * F192 Phase D — eval:a2a 2026-06-10 build verdict: parameterize the event
   * name so the same helper can drilldown either C2 verdict-without-pass fires
   * (`c2.verdict_without_pass_fired`) or C2 void-hold fires (`c2.void_hold_fired`).
   * Defaults to `C2_SAMPLE_EVENT_NAME` (verdict-without-pass) for back-compat.
   */
  eventName?: string;
}

const DEFAULT_MAX_CANDIDATES = 500;

/**
 * Look up the original message + invocation for a per-fire sample ref.
 *
 * Steps:
 *  1. Fetch the span from traceStore by (traceId, spanId). null → `span_not_found`.
 *  2. Find the `c2.verdict_without_pass_fired` event on that span.
 *     Missing → `event_not_found_in_span` for both resources.
 *  3. For each of (message, invocation):
 *     a. If no lookup hook injected → `message_lookup_unavailable`.
 *     b. List candidate raw IDs in a bounded window around `event.timeMs`.
 *     c. HMAC each, compare to the event's HMAC id.
 *     d. 0 matches → `message_not_found`. ≥2 matches → `multiple_candidates_fail_closed`
 *        (never pick one arbitrarily — collision is a real signal). 1 match → `hit`.
 *
 * Returns explicit per-resource status so callers (and tests) can tell which
 * leg of the drilldown succeeded.
 */
export async function lookupByEvalSampleRef(
  params: { traceId: string; spanId: string },
  deps: DrillDownDeps,
): Promise<DrillDownResult> {
  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const span = await deps.traceLookup.getSpan(params);

  if (!span) {
    return {
      span: null,
      sample: null,
      messageId: null,
      invocationId: null,
      status: { message: 'span_not_found', invocation: 'span_not_found' },
    };
  }

  const eventName = deps.eventName ?? C2_SAMPLE_EVENT_NAME;
  const event = (span.events ?? []).find((e) => e.name === eventName);
  if (!event) {
    return {
      span,
      sample: null,
      messageId: null,
      invocationId: null,
      status: { message: 'event_not_found_in_span', invocation: 'event_not_found_in_span' },
    };
  }

  const attrs = event.attributes ?? {};
  const sample = buildSampleFromEvent(span, event);
  const messageIdHash = stringAttr(attrs, 'messageId') ?? '';
  const invocationIdHash = stringAttr(attrs, 'invocationId') ?? '';
  // Cloud R1 P2 fix: fail-closed when threadId attribute is absent on the event
  // (malformed trace / future emitter omission). The helper's contract requires
  // thread-scoped scan; defaulting to `''` would invite the caller's hook to do
  // a global scan (or return zero candidates against an empty-string thread key),
  // either way violating the contract while still showing as a "ran" lookup.
  const threadIdHashRaw = stringAttr(attrs, 'threadId');
  if (threadIdHashRaw == null) {
    return {
      span,
      sample,
      messageId: null,
      invocationId: null,
      status: { message: 'thread_scope_missing', invocation: 'thread_scope_missing' },
    };
  }
  const threadIdHash = threadIdHashRaw;
  const aroundTimeMs = event.timeMs;

  const messageResult = await resolveByHmac({
    targetHash: messageIdHash,
    lookup: deps.messageLookup,
    listCandidateIds: deps.messageLookup?.listCandidateMessageIds,
    threadIdHash,
    aroundTimeMs,
    maxCandidates,
    hmac: deps.hmac,
  });
  const invocationResult = await resolveByHmac({
    targetHash: invocationIdHash,
    lookup: deps.invocationLookup,
    listCandidateIds: deps.invocationLookup?.listCandidateInvocationIds,
    threadIdHash,
    aroundTimeMs,
    maxCandidates,
    hmac: deps.hmac,
  });

  return {
    span,
    sample,
    messageId: messageResult.id,
    invocationId: invocationResult.id,
    status: { message: messageResult.status, invocation: invocationResult.status },
  };
}

function stringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === 'string' ? v : null;
}

function buildSampleFromEvent(
  span: EvalTraceSpan,
  event: { timeMs: number; attributes?: Record<string, unknown> },
): PerFireSample {
  const attrs = event.attributes ?? {};
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    messageIdHash: stringAttr(attrs, 'messageId') ?? '',
    invocationIdHash: stringAttr(attrs, 'invocationId') ?? '',
    threadIdHash: stringAttr(attrs, 'threadId') ?? '',
    agentId: stringAttr(attrs, 'agent.id') ?? stringAttr(attrs, 'agentId') ?? '',
    threadSystemKind: stringAttr(attrs, 'thread.system_kind') ?? stringAttr(attrs, 'threadSystemKind') ?? '',
    trigger: stringAttr(attrs, 'trigger') ?? '',
    firedAt: new Date(event.timeMs).toISOString(),
  };
}

interface ResolveByHmacInput {
  targetHash: string;
  lookup: unknown;
  listCandidateIds: ((opts: CandidateScanOpts) => Promise<string[]> | string[]) | undefined;
  threadIdHash: string;
  aroundTimeMs: number;
  maxCandidates: number;
  hmac: HmacFn;
}

async function resolveByHmac(input: ResolveByHmacInput): Promise<{ id: string | null; status: DrillDownStatus }> {
  if (!input.lookup || !input.listCandidateIds) {
    return { id: null, status: 'message_lookup_unavailable' };
  }
  if (!input.targetHash) {
    return { id: null, status: 'message_hash_mismatch' };
  }
  const candidates = await input.listCandidateIds({
    threadIdHash: input.threadIdHash,
    aroundTimeMs: input.aroundTimeMs,
    maxCandidates: input.maxCandidates,
  });
  const matches: string[] = [];
  for (const raw of candidates) {
    if (input.hmac(raw) === input.targetHash) matches.push(raw);
    if (matches.length > 1) break; // early exit for collision detection
  }
  if (matches.length === 0) return { id: null, status: 'message_not_found' };
  if (matches.length > 1) return { id: null, status: 'multiple_candidates_fail_closed' };
  return { id: matches[0]!, status: 'hit' };
}
