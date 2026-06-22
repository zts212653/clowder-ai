/**
 * D0.1 — Narrator eligibility gate (F168 Phase D prerequisite)
 *
 * Pure function: decides whether a narrator should be spawned for a
 * community case. Blocks the auto path for 453 legacy `case.bootstrap`
 * records that have never received post-bootstrap external activity,
 * preventing a narrator storm when the auto-Reconciler first runs.
 *
 * Invariants:
 *  - INV-D0.1: auto path blocks pure bootstrap legacy cases
 *  - INV-D0.2: manual dispatch always allowed (user explicitly clicks)
 *  - INV-D0.3: new wake-worthy external activity unfreezes bootstrap cases for auto
 *
 * "Wake-worthy" activity = excludes silent events (issue.labeled, maintainer
 * OWNER/MEMBER comments) per community-delivery-policy.ts. The caller must
 * compute this timestamp from events — do NOT pass the projection's broad
 * `lastExternalActivityAt` which includes silent activity.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NarratorTriggerSource = 'manual' | 'auto-reconciler';

export interface NarratorEligibilityInput {
  triggerSource: NarratorTriggerSource;
  /**
   * Timestamp of the last wake-worthy external activity, or null if none.
   *
   * "Wake-worthy" means activity that would trigger `wake-owner` in the
   * delivery policy — i.e., NOT issue.labeled, NOT OWNER/MEMBER comments.
   * The projection's `lastExternalActivityAt` is too broad (it includes
   * silent events). The caller must filter events through the delivery
   * policy or equivalent logic before passing this value.
   */
  lastWakeActivityAt: number | null;
  /** Timestamp of the case.bootstrap event, or null if case is non-bootstrap. */
  bootstrapAt: number | null;
}

export type NarratorEligibilityResult = { ok: true } | { ok: false; reason: 'legacy-bootstrap' };

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export function shouldSpawnNarratorForCase(input: NarratorEligibilityInput): NarratorEligibilityResult {
  const { triggerSource, lastWakeActivityAt, bootstrapAt } = input;

  // Non-bootstrap case → always eligible
  if (bootstrapAt === null) {
    return { ok: true };
  }

  // Manual dispatch → always eligible (user explicitly requested)
  if (triggerSource === 'manual') {
    return { ok: true };
  }

  // Auto path + bootstrap case: block unless post-bootstrap wake-worthy activity
  if (lastWakeActivityAt === null || lastWakeActivityAt <= bootstrapAt) {
    return { ok: false, reason: 'legacy-bootstrap' };
  }

  // Bootstrap case with genuine post-bootstrap wake-worthy activity → eligible
  return { ok: true };
}
