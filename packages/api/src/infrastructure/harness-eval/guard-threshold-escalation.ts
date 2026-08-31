/**
 * F257 sub-item 2: Guard threshold escalation — immediate eval trigger.
 *
 * When a guard accumulates ≥ ESCALATION_THRESHOLD distinct EPISODES within
 * ESCALATION_WINDOW_DAYS, triggers an immediate eval:harness-ledger
 * invocation instead of waiting for the weekly cron ceiling.
 *
 * V2/Phase B (PR #41 verdict, burst-coalescing fix): the threshold unit is
 * coalesced episodes, not raw events. Rapid same-guard/thread/cat retries
 * (adjacent gap ≤ 60s) are ONE incident — see guard-episode-coalescing.ts,
 * the canonical coalescer shared with the snapshot/bundle path.
 *
 * Design decisions:
 * - **Event-driven**: hooks into GuardRejectionEventLog.postAppendHook —
 *   fires on every event append, not on a polling interval.
 * - **Dedup via Redis**: a per-guard escalation key with TTL prevents
 *   re-triggering on the 4th, 5th, … event in the same window.
 *   Sol R3 P1-1 / Fable ruling: two claim namespaces — confirmed (7d TTL)
 *   vs uncertainty-probe (1h TTL). Truncation-only claims don't suppress
 *   real harm.
 * - **Fail-open**: escalation failures never affect the business path
 *   (the hook is already wrapped in try/catch in the event log).
 * - **Reuses manual trigger path**: calls handleTriggerNow() to produce
 *   snapshot → deliver → invoke eval cat (single invocation path, no drift).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { GuardRejectionEvent } from './GuardRejectionEventLog.js';
import { countEpisodesPagewise, type PagewiseEventSource } from './guard-episode-coalescing.js';
import type { TriggerNowInput, TriggerNowSkipped, TriggerNowSuccess } from './manual-trigger/trigger-now.js';
import type { HandlerError } from './manual-trigger/types.js';
import { isEscalationEligible } from './skip-reason-eligibility.js';

/** Narrowed result type matching handleTriggerNow's return union. */
export type TriggerEvalResult = TriggerNowSuccess | TriggerNowSkipped | HandlerError;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum distinct episodes for a single guard to trigger immediate eval.
 * Unit is EPISODES (coalesced incidents), not raw events — PR #41 verdict.
 */
export const ESCALATION_THRESHOLD = 3;

/** Window in days over which events are counted toward the threshold. */
export const ESCALATION_WINDOW_DAYS = 7;

/** Redis key prefix for per-guard confirmed-harm escalation dedup (7d TTL). */
const DEDUP_KEY_PREFIX = 'guard-rejection:escalated:';

/** Redis key prefix for uncertainty-probe claims (Fable ruling: separate namespace). */
const UNCERTAINTY_KEY_PREFIX = 'guard-rejection:uncertainty:';

/** Dedup TTL matches the escalation window so keys auto-expire. */
const DEDUP_TTL_SECONDS = ESCALATION_WINDOW_DAYS * 24 * 3600;

/**
 * Sol R3 P1-1 / Fable ruling: TTL for uncertainty-probe claims.
 * 1 hour — matches hold_ball window magnitude (Fable parameter ruling).
 * Prevents eval storm from consecutive cap events (NX blocks within window)
 * but auto-expires so confirmed threshold claims are never suppressed.
 */
export const UNCERTAINTY_PROBE_TTL_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Escalation result (for testing / observability)
// ---------------------------------------------------------------------------

export interface EscalationCheckResult {
  checked: true;
  guardId: string;
  /** Backward-compat alias of rawEventCount (pre-episode consumers). */
  count: number;
  /**
   * Raw rejection events scanned. When `rawEventCountIsLowerBound` is true,
   * this is events seen before early-stop, NOT the total window count.
   */
  rawEventCount: number;
  /** True when pagewise scan early-stopped — rawEventCount is a scan lower bound. */
  rawEventCountIsLowerBound?: boolean;
  /**
   * Coalesced distinct episodes in window. When `episodeCountIsLowerBound`
   * is true, this is at-least-k (early-stopped or hard-cap hit), NOT exact.
   */
  episodeCount: number;
  /** True when episodeCount is a lower bound (early-stop or hard cap). */
  episodeCountIsLowerBound?: boolean;
  /** Redis pages fetched (perf metric — threshold check should be 1-2). */
  pagesFetched?: number;
  /** sol R2 P2: window hit the hard cap — counts are lower bounds; thresholdMet is conservative-true. */
  truncated?: boolean;
  /**
   * Sol R3 P1-1 / Fable ruling: escalation kind distinguishes confirmed
   * (episodeCount ≥ threshold) from uncertainty_probe (truncation-only).
   * Probe claims use a short-TTL separate key that doesn't block future
   * confirmed escalations. Present only when thresholdMet is true.
   */
  escalationKind?: 'confirmed' | 'uncertainty_probe';
  thresholdMet: boolean;
  alreadyEscalated: boolean;
  escalated: boolean;
  /** Claim won but trigger failed → claim released so next event can retry. */
  claimReleased?: boolean;
  triggerResult?: TriggerEvalResult;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface GuardThresholdEscalationDeps {
  redis: RedisClient;
  /** Event source for pagewise episode counting (Fable ruling: restore EventLog dep). */
  guardRejectionLog: PagewiseEventSource;
  /**
   * Trigger function — typically a partial application of handleTriggerNow
   * with all deps pre-bound. Returns narrowed result so we can distinguish
   * success (keep 7d claim) from failure (release claim for retry).
   */
  triggerEval: (input: TriggerNowInput) => Promise<TriggerEvalResult>;
}

// ---------------------------------------------------------------------------
// Claim lifecycle helper
// ---------------------------------------------------------------------------

/**
 * Attempt to release escalation claim so the next event can retry.
 * Returns `true` only when DEL succeeds. On DEL failure, the 7-day TTL
 * backstop auto-expires the claim — bounded degradation, not permanent.
 */
async function releaseClaim(redis: RedisClient, dedupKey: string, guardId: string): Promise<boolean> {
  try {
    await redis.del(dedupKey);
    return true;
  } catch (err) {
    console.warn(`[F257] escalation claim DEL failed for guard=${guardId}, 7d TTL backstop active`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Check whether a guard has crossed the escalation threshold and, if so,
 * trigger an immediate eval:harness-ledger invocation.
 *
 * Deduplication: a Redis key `guard-rejection:escalated:<guardId>` with
 * TTL = ESCALATION_WINDOW_DAYS prevents re-escalation on subsequent events
 * from the same guard within the same window.
 *
 * @returns Result indicating what happened (for tests/observability).
 */
export async function checkGuardThreshold(
  event: GuardRejectionEvent,
  deps: GuardThresholdEscalationDeps,
): Promise<EscalationCheckResult> {
  const { guardId } = event;
  const windowMs = ESCALATION_WINDOW_DAYS * 24 * 3600 * 1000;
  const since = event.timestamp - windowMs;

  // Step 1: pagewise streaming episode count (sol R5 P2-1).
  // Pages through Redis directly, counting episodes as events arrive in
  // timestamp order. Stops I/O once ESCALATION_THRESHOLD episodes are found —
  // a 10k-event window typically resolves in 1-2 page calls for k=3.
  // +1 because the query uses half-open [since, until) interval
  // (upperBound = until - 1). Without +1 the just-appended event at event.timestamp
  // is excluded and the threshold fires one episode late.
  //
  // Sol verdict 2026-07-21 (dedup_active false-escalation): eligibility filter
  // excludes informational skip reasons (e.g. dedup_active) from episode counting.
  // Events are still scanned (rawEventsSeen) but don't form episodes. Unknown
  // reasons default to eligible (fail-closed — new reasons escalate until classified).
  const pagewiseResult = await countEpisodesPagewise(
    deps.guardRejectionLog,
    { since, until: event.timestamp + 1, guardId, ownerUserId: event.ownerUserId },
    ESCALATION_THRESHOLD,
    undefined, // gapMs — use default
    (e) => isEscalationEligible(e.normalizedReason),
  );
  const { episodeCount, isLowerBound, rawEventsSeen: rawEventCount, pagesFetched } = pagewiseResult;
  const truncated = pagewiseResult.earlyStopReason === 'hard_cap';
  if (truncated) {
    console.warn(`[F257] escalation window truncated at hard cap for guard=${guardId}; episodeCount is a lower bound`);
  }
  // Sol R2 P1-1: truncation = incomplete scan → always conservative-true.
  // The eligibility filter correctly excludes informational events (e.g.
  // dedup_active) from episode counting in the SCANNED portion, but
  // truncation means the unscanned tail may contain eligible episodes.
  // A mixed window (10k dedup_active then 3 depth) would produce
  // episodeCount=0 with skippedByFilter>0 — the R1 approach of
  // `!skippedByFilter` silently chose false-negative for that case.
  // Conservative-true on truncation: false positive (one eval run where
  // eval cat sees all-informational byReason) is bounded and acceptable;
  // false negative (missed harmful pattern in tail) is a safety gap.
  const meetsThreshold = episodeCount >= ESCALATION_THRESHOLD || truncated;
  if (!meetsThreshold) {
    return {
      checked: true,
      guardId,
      count: rawEventCount,
      rawEventCount,
      ...(isLowerBound ? { rawEventCountIsLowerBound: true } : {}),
      episodeCount,
      ...(isLowerBound ? { episodeCountIsLowerBound: true } : {}),
      ...(pagesFetched ? { pagesFetched } : {}),
      ...(truncated ? { truncated } : {}),
      thresholdMet: false,
      alreadyEscalated: false,
      escalated: false,
    };
  }

  // Step 2: atomic claim via SET NX EX — only one concurrent caller wins.
  // Pattern: ApiInstanceLease / RedisDeliveryDedup / RedisProposalStore (codebase prior art).
  // NX = set-if-not-exists; EX = TTL in seconds.
  //
  // Sol R3 P1-1: separate claim lifecycle for confirmed vs uncertain escalation.
  // Problem: truncation-only conservative-true claimed the 7d dedup key,
  // suppressing subsequent real 3×depth episodes for the entire window.
  // Fix: two claim namespaces with different TTLs.
  //
  // Confirmed (episodeCount ≥ threshold): 7d TTL on primary key — prevents
  //   redundant eval for an already-identified harmful pattern.
  // Uncertainty-probe (truncated, episodeCount < threshold): 1h TTL on
  //   separate key (Fable ruling: matches hold_ball window magnitude) —
  //   prevents eval storm from consecutive cap events but does NOT block
  //   future confirmed escalations (different key namespace).
  //
  // Sol R3 constraints:
  // 1. dedup-only cap → one uncertain eval (short-TTL claim fires trigger) ✓
  // 2. Subsequent 3 real eligible episodes → second trigger (different key) ✓
  // 3. Consecutive cap events → no eval storm (uncertainty_probe NX blocks within 1h) ✓
  // 4. Only confirmed eligible threshold → 7d claim ✓
  const isConfirmed = episodeCount >= ESCALATION_THRESHOLD;
  const escalationKind = isConfirmed ? ('confirmed' as const) : ('uncertainty_probe' as const);
  const confirmedDedupKey = `${DEDUP_KEY_PREFIX}${event.ownerUserId}:${guardId}`;
  let dedupKey: string;
  let claimTtl: number;

  if (isConfirmed) {
    dedupKey = confirmedDedupKey;
    claimTtl = DEDUP_TTL_SECONDS;
  } else {
    // Uncertain path: if confirmed key already exists, real harm was already
    // escalated — uncertain eval is redundant. GET is non-atomic with the
    // subsequent SET, but harmless: worst case is one extra uncertain eval
    // if a confirmed claim races in between.
    const existingConfirmed = await deps.redis.get(confirmedDedupKey);
    if (existingConfirmed !== null) {
      return {
        checked: true,
        guardId,
        count: rawEventCount,
        rawEventCount,
        ...(isLowerBound ? { rawEventCountIsLowerBound: true } : {}),
        episodeCount,
        ...(isLowerBound ? { episodeCountIsLowerBound: true } : {}),
        ...(pagesFetched ? { pagesFetched } : {}),
        ...(truncated ? { truncated } : {}),
        escalationKind,
        thresholdMet: true,
        alreadyEscalated: true,
        escalated: false,
      };
    }
    dedupKey = `${UNCERTAINTY_KEY_PREFIX}${event.ownerUserId}:${guardId}`;
    claimTtl = UNCERTAINTY_PROBE_TTL_SECONDS;
  }

  const claimValue = JSON.stringify({
    escalatedAt: event.timestamp,
    count: rawEventCount,
    ...(isLowerBound ? { rawEventCountIsLowerBound: true } : {}),
    episodeCount,
    ...(isLowerBound ? { episodeCountIsLowerBound: true } : {}),
    triggeredBy: event.eventId,
    escalationKind,
  });
  const claimed = await deps.redis.set(dedupKey, claimValue, 'EX', claimTtl, 'NX');
  if (claimed !== 'OK') {
    // Another concurrent caller already claimed — dedup.
    return {
      checked: true,
      guardId,
      count: rawEventCount,
      rawEventCount,
      ...(isLowerBound ? { rawEventCountIsLowerBound: true } : {}),
      episodeCount,
      ...(isLowerBound ? { episodeCountIsLowerBound: true } : {}),
      ...(pagesFetched ? { pagesFetched } : {}),
      ...(truncated ? { truncated } : {}),
      escalationKind,
      thresholdMet: true,
      alreadyEscalated: true,
      escalated: false,
    };
  }

  // Step 3: trigger eval:harness-ledger via the manual trigger path.
  // Invariant: ALL paths that don't confirm dispatch attempt to release claim.
  // handleTriggerNow can fail two ways:
  //   a) resolved 503/skipped (non-throw) — checked in Step 4
  //   b) reject/throw (transport error, Redis inside handler, messageStore.append)
  // Both must release the claim to prevent 7-day silent suppression.
  let triggerResult: TriggerEvalResult | undefined;
  try {
    triggerResult = await deps.triggerEval({
      domainId: 'eval:harness-ledger',
      userId: event.ownerUserId,
      // Sol R1 P2-1: server-injected source thread (Fable ruling).
      sourceThreadId: event.threadId,
      // Sol R4 P1-1 / Fable ruling: propagate escalation kind to snapshot + bundle.
      escalationKind,
    });
  } catch {
    // triggerEval rejected — release claim so next event can retry.
    const released = await releaseClaim(deps.redis, dedupKey, guardId);
    return {
      checked: true,
      guardId,
      count: rawEventCount,
      rawEventCount,
      ...(isLowerBound ? { rawEventCountIsLowerBound: true } : {}),
      episodeCount,
      ...(isLowerBound ? { episodeCountIsLowerBound: true } : {}),
      ...(pagesFetched ? { pagesFetched } : {}),
      ...(truncated ? { truncated } : {}),
      escalationKind,
      thresholdMet: true,
      alreadyEscalated: false,
      escalated: false,
      claimReleased: released,
    };
  }

  // Step 4: verify trigger actually dispatched (dispatched/enqueued).
  // Only { ok: true, invocationTriggered: true } confirms eval cat was invoked.
  const dispatched = 'ok' in triggerResult && triggerResult.ok === true && 'invocationTriggered' in triggerResult;

  if (!dispatched) {
    const released = await releaseClaim(deps.redis, dedupKey, guardId);
    return {
      checked: true,
      guardId,
      count: rawEventCount,
      rawEventCount,
      ...(isLowerBound ? { rawEventCountIsLowerBound: true } : {}),
      episodeCount,
      ...(isLowerBound ? { episodeCountIsLowerBound: true } : {}),
      ...(pagesFetched ? { pagesFetched } : {}),
      ...(truncated ? { truncated } : {}),
      escalationKind,
      thresholdMet: true,
      alreadyEscalated: false,
      escalated: false,
      claimReleased: released,
      triggerResult,
    };
  }

  return {
    checked: true,
    guardId,
    count: rawEventCount,
    rawEventCount,
    ...(isLowerBound ? { rawEventCountIsLowerBound: true } : {}),
    episodeCount,
    ...(isLowerBound ? { episodeCountIsLowerBound: true } : {}),
    ...(pagesFetched ? { pagesFetched } : {}),
    ...(truncated ? { truncated } : {}),
    escalationKind,
    thresholdMet: true,
    alreadyEscalated: false,
    escalated: true,
    triggerResult,
  };
}

// ---------------------------------------------------------------------------
// Hook factory — creates the postAppendHook for GuardRejectionEventLog
// ---------------------------------------------------------------------------

/**
 * Create a post-append hook that checks guard thresholds on every event.
 * Wire this into GuardRejectionEventLog.setPostAppendHook() at bootstrap.
 *
 * The hook is fire-and-forget: starts the async check but doesn't await it
 * (the event log's append path must not block on escalation).
 */
export function createThresholdEscalationHook(
  deps: GuardThresholdEscalationDeps,
): (event: GuardRejectionEvent) => void {
  return (event: GuardRejectionEvent) => {
    // Fire-and-forget — errors are swallowed by the event log's try/catch.
    void checkGuardThreshold(event, deps).catch(() => {});
  };
}
