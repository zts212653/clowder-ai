import type { QuotaFacet } from '@cat-cafe/shared';
import type { QuotaSummaryPlatform } from '../../routes/quota.js';

/**
 * F300 Task 1.5 -- turn a quota owner's reading into the facet's typed answer.
 *
 * This is a projection, not a second reading: no probing, no caching, no
 * thresholds of our own beyond turning the owner's numbers into the four typed
 * answers the facet allows. A failed probe stays a failed probe.
 *
 * What it deliberately does not do is decide *whose* reading it is. The F051
 * summary is per platform and carries no account, so a cat's registered client
 * (openai -> codex) proves nothing about which account or pool its invocation
 * actually draws on. The self facet therefore reports quota as unknown until an
 * owner exposes a reading attributed to the account bound to that invocation
 * (#4545 review R3); this function is what that attributed reading will be
 * projected through.
 */

/** Above this, the pool is effectively gone. */
const EXHAUSTED_PERCENT = 100;
/** Below exhausted but close enough that the next long task may not finish. */
const LOW_PERCENT = 90;

export function quotaFacetFromPlatform(platform: QuotaSummaryPlatform | undefined): QuotaFacet {
  if (!platform) return 'unknown';
  if (platform.status === 'pending') return 'unknown';

  const observedAt = platform.lastChecked ? Date.parse(platform.lastChecked) : Number.NaN;
  const utilization = platform.utilizationPercent;

  // `status` is a risk label, not a probe outcome: the owner returns 'error' for
  // any utilization at or above 95 (`quota.ts` statusFromUtilization). So a
  // reading is what decides here, and 'error' with an actual number is the most
  // important reading there is -- reporting that as an unreachable owner would
  // drop exactly the "you are out of budget" signal this exists to carry.
  if (typeof utilization === 'number' && Number.isFinite(observedAt)) {
    return {
      status: quotaStatusFor(utilization, platform.status),
      poolRef: poolRefFor(platform.id),
      sourceRef: sourceRefFor(platform.id),
      observedAt,
    };
  }

  // No number at all. Now 'error' really does mean the probe could not read the
  // owner, and a warning without a figure is still a warning.
  if (platform.status === 'error') return 'owner_unreachable';
  if (platform.status === 'warn' && Number.isFinite(observedAt)) {
    return { status: 'low', poolRef: poolRefFor(platform.id), sourceRef: sourceRefFor(platform.id), observedAt };
  }
  return 'unknown';
}

function quotaStatusFor(utilization: number, ownerStatus: QuotaSummaryPlatform['status']): 'ok' | 'low' | 'exhausted' {
  if (utilization >= EXHAUSTED_PERCENT) return 'exhausted';
  if (utilization >= LOW_PERCENT) return 'low';
  // The owner can flag risk for reasons the percentage alone does not show.
  return ownerStatus === 'ok' ? 'ok' : 'low';
}

function poolRefFor(id: string): string {
  return `quota_platform:${id}`;
}

function sourceRefFor(id: string): string {
  return `/api/quota#platforms.${id}`;
}
