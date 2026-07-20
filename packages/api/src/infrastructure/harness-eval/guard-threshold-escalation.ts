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
 * - **Fail-open**: escalation failures never affect the business path
 *   (the hook is already wrapped in try/catch in the event log).
 * - **Reuses manual trigger path**: calls handleTriggerNow() to produce
 *   snapshot → deliver → invoke eval cat (single invocation path, no drift).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { GuardRejectionEvent } from './GuardRejectionEventLog.js';
import { countEpisodesPagewise } from './guard-episode-coalescing.js';
import type { TriggerNowInput, TriggerNowSkipped, TriggerNowSuccess } from './manual-trigger/trigger-now.js';
import type { HandlerError } from './manual-trigger/types.js';

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

/** Redis key prefix for per-guard escalation dedup. */
const DEDUP_KEY_PREFIX = 'guard-rejection:escalated:';

/** Dedup TTL matches the escalation window so keys auto-expire. */
const DEDUP_TTL_SECONDS = ESCALATION_WINDOW_DAYS * 24 * 3600;

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
  const pagewiseResult = await countEpisodesPagewise(
    deps.redis,
    { since, until: event.timestamp + 1, guardId },
    ESCALATION_THRESHOLD,
  );
  const { episodeCount, isLowerBound, rawEventsSeen: rawEventCount, pagesFetched } = pagewiseResult;
  const truncated = pagewiseResult.earlyStopReason === 'hard_cap';
  if (truncated) {
    console.warn(`[F257] escalation window truncated at hard cap for guard=${guardId}; episodeCount is a lower bound`);
  }
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
  // NX = set-if-not-exists; EX = TTL in seconds (matches ESCALATION_WINDOW_DAYS).
  // Atomicity eliminates the GET→SET→EXPIRE race where two fire-and-forget
  // appends both read empty and both trigger.
  const dedupKey = `${DEDUP_KEY_PREFIX}${guardId}`;
  const claimValue = JSON.stringify({
    escalatedAt: event.timestamp,
    count: rawEventCount,
    ...(isLowerBound ? { rawEventCountIsLowerBound: true } : {}),
    episodeCount,
    ...(isLowerBound ? { episodeCountIsLowerBound: true } : {}),
    triggeredBy: event.eventId,
  });
  const claimed = await deps.redis.set(dedupKey, claimValue, 'EX', DEDUP_TTL_SECONDS, 'NX');
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
      userId: `threshold-escalation:${guardId}`,
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
