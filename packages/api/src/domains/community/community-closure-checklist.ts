/**
 * F168 Phase D D2 — Community closure checklist selector
 *
 * Pure function: given a projection snapshot, computes whether the case
 * is ready to close and what blockers remain.
 *
 * Closure invariant (P1#3): `fixed` → `closed` requires either:
 *   - A public comment was posted (lastPublicCommentAt ≠ null) = reported path
 *   - An explicit waiver is recorded (closureWaiver ≠ null) = waived path
 *
 * This selector surfaces that invariant as a checklist for the board UI.
 * It does NOT enforce the invariant (the state machine does that) — it
 * only REPORTS what's missing so the owner knows what to do.
 */

import type { CommunityClosureWaiver, CommunityObjectState } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClosureChecklistBlocker {
  readonly kind: 'fixed-not-reported' | 'not-in-closeable-state';
  readonly detail: string;
}

export interface ClosureChecklist {
  /** True if no blockers remain — the case can be closed. */
  readonly readyToClose: boolean;
  /** What's blocking closure (empty if readyToClose). */
  readonly blockers: readonly ClosureChecklistBlocker[];
  /** Whether a closure waiver is present (audit trail). */
  readonly waiverPresent: boolean;
}

export interface ClosureChecklistInput {
  readonly state: CommunityObjectState;
  readonly lastPublicCommentAt: number | null | undefined;
  readonly closureWaiver: CommunityClosureWaiver | null | undefined;
}

// ---------------------------------------------------------------------------
// States that are considered "closeable" (terminal or near-terminal)
// ---------------------------------------------------------------------------

/** States where the closure checklist is applicable. */
const CLOSEABLE_STATES = new Set<CommunityObjectState>(['fixed', 'reported', 'closed', 'declined']);

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

export function computeClosureChecklist(input: ClosureChecklistInput): ClosureChecklist {
  const { state, lastPublicCommentAt, closureWaiver } = input;

  const waiverPresent = closureWaiver != null;

  // Already closed — nothing to do
  if (state === 'closed') {
    return { readyToClose: true, blockers: [], waiverPresent };
  }

  // Declined — can close (decline is a terminal decision)
  if (state === 'declined') {
    return { readyToClose: true, blockers: [], waiverPresent };
  }

  // Not in a closeable state — the checklist is N/A
  if (!CLOSEABLE_STATES.has(state)) {
    return {
      readyToClose: false,
      blockers: [
        {
          kind: 'not-in-closeable-state',
          detail: `Case is in state "${state}" — must reach fixed/reported/declined before closure`,
        },
      ],
      waiverPresent,
    };
  }

  // reported state — public reply already happened
  if (state === 'reported') {
    return { readyToClose: true, blockers: [], waiverPresent };
  }

  // fixed state — check if reported or waived
  const hasPublicReply = lastPublicCommentAt != null;
  if (hasPublicReply || waiverPresent) {
    return { readyToClose: true, blockers: [], waiverPresent };
  }

  // fixed but no report and no waiver — closure invariant blocker
  return {
    readyToClose: false,
    blockers: [
      {
        kind: 'fixed-not-reported',
        detail: 'Fixed issue needs a public reply (case.reported) or explicit waiver (case.waived) before closing',
      },
    ],
    waiverPresent: false,
  };
}
