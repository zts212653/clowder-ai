/**
 * F174 Phase D1 — central recorder for callback auth failures.
 *
 * AC-D1: emit OTel counter `cat_cafe.callback_auth.failures{tool, cat, reason}`
 * AC-D2: cover all 5 reasons (expired/invalid_token/unknown_invocation/
 *        missing_creds/stale_invocation)
 * AC-D3: feed in-memory snapshot to `/api/debug/callback-auth`
 *
 * F174 Phase D2a — dashboard prep:
 *   - byCat counter (per-cat failure totals, mirrors toolCounts)
 *   - 24h rolling window via per-hour ring buffer (24 buckets)
 *   - recent24h section in snapshot for the dashboard card consumer
 *
 * All 401 emission sites in routes/ funnel through `recordCallbackAuthFailure`
 * so observability is uniform regardless of which hook detected the failure.
 */

import type { CallbackAuthFailureReason } from '@cat-cafe/shared';
import { AGENT_ID, CALLBACK_REASON, CALLBACK_TOOL } from '../infrastructure/telemetry/genai-semconv.js';
import { callbackAuthFailures } from '../infrastructure/telemetry/instruments.js';

const RECENT_SAMPLES_CAP = 100;
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_HOURS = 24;

interface FailureSample {
  at: number;
  reason: CallbackAuthFailureReason;
  tool: string;
  catId?: string;
}

const ZERO_REASON_COUNTS: Record<CallbackAuthFailureReason, number> = {
  expired: 0,
  invalid_token: 0,
  unknown_invocation: 0,
  missing_creds: 0,
  stale_invocation: 0,
  agent_key_expired: 0,
  agent_key_revoked: 0,
  agent_key_unknown: 0,
  agent_key_scope_mismatch: 0,
};

let reasonCounts: Record<CallbackAuthFailureReason, number> = { ...ZERO_REASON_COUNTS };
let toolCounts: Record<string, number> = {};
let byCat: Record<string, number> = {};
let recentSamples: FailureSample[] = [];
let totalFailures = 0;
const startedAt = Date.now();

// F174 Phase F (AC-F3): per-tool counter for legacy body/query fallback hits.
let legacyFallbackByTool: Record<string, number> = {};
let legacyFallbackTotal = 0;

// F174 D2b-2 rev3: "unread notification" timestamp. HubButton badge uses
// `unviewedFailures24h` (failures since lastViewedAt within 24h) instead of
// totalFailures24h, so the badge clears when user actually looks at the
// observability/callback-auth subtab. Single-user MVP: module-global; when
// F077 multi-user lands this needs to key by userId. 0 = never viewed (badge
// shows all 24h failures).
let lastViewedAt = 0;

/**
 * F174 Phase D2a — 24h ring buffer. Each bucket holds aggregated counts for
 * one hour. The bucket index is `floor(timestampMs / HOUR_MS) % WINDOW_HOURS`,
 * with a stored `hourId` to detect stale slots that need clearing on read/write.
 */
interface HourBucket {
  hourId: number; // floor(at / HOUR_MS) — strictly increasing
  total: number;
  byReason: Record<CallbackAuthFailureReason, number>;
  byTool: Record<string, number>;
  byCat: Record<string, number>;
}

function freshBucket(hourId: number): HourBucket {
  return {
    hourId,
    total: 0,
    byReason: { ...ZERO_REASON_COUNTS },
    byTool: {},
    byCat: {},
  };
}

let buckets: HourBucket[] = Array.from({ length: WINDOW_HOURS }, () => freshBucket(-1));

/**
 * Test-only clock injection. Set to a fixed timestamp (ms) to drive
 * `Date.now()`-equivalent reads through this module deterministically.
 * Pass null to revert to wall clock.
 */
let nowOverride: number | null = null;
function now(): number {
  return nowOverride ?? Date.now();
}

export function __setNowForTest(value: number | null): void {
  nowOverride = value;
}

export interface CallbackAuthFailureRecord {
  reason: CallbackAuthFailureReason;
  tool: string;
  catId?: string;
}

export function recordCallbackAuthFailure(record: CallbackAuthFailureRecord): void {
  reasonCounts[record.reason] = (reasonCounts[record.reason] ?? 0) + 1;
  toolCounts[record.tool] = (toolCounts[record.tool] ?? 0) + 1;
  if (record.catId) {
    byCat[record.catId] = (byCat[record.catId] ?? 0) + 1;
  }
  totalFailures += 1;

  const at = now();
  recentSamples.push({ at, reason: record.reason, tool: record.tool, catId: record.catId });
  if (recentSamples.length > RECENT_SAMPLES_CAP) {
    recentSamples.splice(0, recentSamples.length - RECENT_SAMPLES_CAP);
  }

  // 24h ring buffer: clear stale slot if rotated past, then accumulate.
  const hourId = Math.floor(at / HOUR_MS);
  const slot = hourId % WINDOW_HOURS;
  const safeIdx = ((slot % WINDOW_HOURS) + WINDOW_HOURS) % WINDOW_HOURS;
  if (buckets[safeIdx].hourId !== hourId) {
    buckets[safeIdx] = freshBucket(hourId);
  }
  const bucket = buckets[safeIdx];
  bucket.total += 1;
  bucket.byReason[record.reason] = (bucket.byReason[record.reason] ?? 0) + 1;
  bucket.byTool[record.tool] = (bucket.byTool[record.tool] ?? 0) + 1;
  if (record.catId) {
    bucket.byCat[record.catId] = (bucket.byCat[record.catId] ?? 0) + 1;
  }

  // OTel counter export — allowlist-filtered attributes (cat may be undefined
  // for panel/anonymous requests; OTel SDK drops undefined values).
  const attributes: Record<string, string> = {
    [CALLBACK_REASON]: record.reason,
    [CALLBACK_TOOL]: record.tool,
  };
  if (record.catId) attributes[AGENT_ID] = record.catId;
  callbackAuthFailures.add(1, attributes);
}

export interface Recent24hAggregate {
  totalFailures: number;
  byReason: Record<CallbackAuthFailureReason, number>;
  byTool: Record<string, number>;
  byCat: Record<string, number>;
}

export interface CallbackAuthFailureSnapshot {
  reasonCounts: Record<CallbackAuthFailureReason, number>;
  toolCounts: Record<string, number>;
  /** F174 Phase D2a: per-cat failure counts (lifetime). */
  byCat: Record<string, number>;
  recentSamples: FailureSample[];
  totalFailures: number;
  startedAt: number;
  uptimeMs: number;
  /** F174 Phase D2a: rolling 24h window aggregate. */
  recent24h: Recent24hAggregate;
  /** F174 Phase F (AC-F3): legacy body/query fallback usage per tool. */
  legacyFallbackHits: {
    byTool: Record<string, number>;
    total: number;
  };
  /** F174 D2b-2 rev3: timestamp of last `mark-viewed`. 0 if never viewed. */
  lastViewedAt: number;
  /**
   * F174 D2b-2 rev3: count of failures within last 24h that occurred AFTER
   * lastViewedAt. Drives the HubButton "unread badge" — clears to 0 when user
   * opens observability/callback-auth subtab (frontend triggers POST mark-viewed).
   * Capped by recentSamples size (RECENT_SAMPLES_CAP = 100); badge UI further
   * caps display at "99+".
   */
  unviewedFailures24h: number;
}

function computeRecent24h(): Recent24hAggregate {
  const at = now();
  const currentHourId = Math.floor(at / HOUR_MS);
  const minHourId = currentHourId - (WINDOW_HOURS - 1);
  const agg: Recent24hAggregate = {
    totalFailures: 0,
    byReason: { ...ZERO_REASON_COUNTS },
    byTool: {},
    byCat: {},
  };
  for (const bucket of buckets) {
    if (bucket.hourId < minHourId || bucket.hourId > currentHourId) continue;
    agg.totalFailures += bucket.total;
    for (const reason of Object.keys(bucket.byReason) as CallbackAuthFailureReason[]) {
      agg.byReason[reason] += bucket.byReason[reason];
    }
    for (const [tool, count] of Object.entries(bucket.byTool)) {
      agg.byTool[tool] = (agg.byTool[tool] ?? 0) + count;
    }
    for (const [cat, count] of Object.entries(bucket.byCat)) {
      agg.byCat[cat] = (agg.byCat[cat] ?? 0) + count;
    }
  }
  return agg;
}

function computeUnviewedFailures24h(): number {
  const at = now();
  const minAt = at - 24 * HOUR_MS;
  const cutoff = Math.max(lastViewedAt, minAt);
  let count = 0;
  for (const sample of recentSamples) {
    // Cloud Codex P2 #1425 round 5: use `>=` instead of strict `>`. With
    // Date.now() ms granularity, a failure recorded in the same ms as
    // lastViewedAt/viewedUpTo can't reliably be classified as "in the
    // snapshot user saw" — strict `>` would drop it (treat as viewed),
    // potentially losing unread notifications under bursty traffic.
    // Safe-side bias: count same-ms failures as unviewed (occasional
    // over-count by 1 is acceptable; missing a notification is not).
    if (sample.at >= cutoff) count += 1;
  }
  return count;
}

export function getCallbackAuthFailureSnapshot(): CallbackAuthFailureSnapshot {
  return {
    reasonCounts: { ...reasonCounts },
    toolCounts: { ...toolCounts },
    byCat: { ...byCat },
    recentSamples: [...recentSamples],
    totalFailures,
    startedAt,
    uptimeMs: now() - startedAt,
    recent24h: computeRecent24h(),
    legacyFallbackHits: {
      byTool: { ...legacyFallbackByTool },
      total: legacyFallbackTotal,
    },
    lastViewedAt,
    unviewedFailures24h: computeUnviewedFailures24h(),
  };
}

/**
 * F174 D2b-2 rev3: mark callback-auth telemetry as viewed at `at` (ms).
 * Called from POST /api/debug/callback-auth/mark-viewed when user opens the
 * observability/callback-auth subtab. Implements the "unread → viewed → cleared"
 * notification mental model — badge clears on view, only re-appears on new
 * failures after this timestamp.
 *
 * Cloud Codex P2 #1425 round 2: enforce monotonic watermark — a delayed/stale
 * mark-viewed request (e.g. tab/panel that loaded a much older snapshot) must
 * NOT move lastViewedAt backwards, otherwise failures previously cleared would
 * re-appear as unviewed when a fresher poll lands. Caller-provided `at` is
 * upper-bounded by the route handler (clamped to <= now); this function guards
 * the lower bound (never decreases).
 */
export function markCallbackAuthViewed(at: number = now()): void {
  if (at > lastViewedAt) {
    lastViewedAt = at;
  }
}

export function getCallbackAuthLastViewedAt(): number {
  return lastViewedAt;
}

/**
 * F174 Phase F (AC-F3): record a hit on the legacy body/query credentials
 * fallback path. Called from preHandler when headers were absent but legacy
 * fields succeeded. Tracks deprecation usage so we know when the compat path
 * is safe to delete (zero hits across a release window).
 */
export function recordLegacyFallbackHit(record: { tool: string }): void {
  legacyFallbackByTool[record.tool] = (legacyFallbackByTool[record.tool] ?? 0) + 1;
  legacyFallbackTotal += 1;
}

export function getLegacyFallbackHitCount(): number {
  return legacyFallbackTotal;
}

/** Test-only — reset internal counters between cases. NEVER call from prod code. */
export function resetCallbackAuthFailureForTest(): void {
  reasonCounts = { ...ZERO_REASON_COUNTS };
  toolCounts = {};
  byCat = {};
  recentSamples = [];
  totalFailures = 0;
  legacyFallbackByTool = {};
  legacyFallbackTotal = 0;
  lastViewedAt = 0;
  buckets = Array.from({ length: WINDOW_HOURS }, () => freshBucket(-1));
  // Cloud Codex P2 (PR #1393): also clear the injected clock so a previous
  // __setNowForTest(...) doesn't leak frozen time into a later test that
  // only calls reset. Restores wall-clock behavior.
  nowOverride = null;
}

/** Test-only — reset just the legacy fallback counters. */
export function resetLegacyFallbackHitsForTest(): void {
  legacyFallbackByTool = {};
  legacyFallbackTotal = 0;
}
