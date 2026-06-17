/**
 * Community Ops State Machine (F168 Phase A — Task 3)
 *
 * Pure function — no IO, no Redis, no side-effects.
 * The transition table is explicit (no if-chains). Callers are responsible
 * for persisting state changes to the CommunityObjectStore.
 *
 * Closure invariant (P1#3 from codex review, Phase A must enforce):
 *   `fixed` → `closed` requires EITHER:
 *     - snapshot.lastPublicCommentAt != null  (case.reported path)
 *     - snapshot.closureWaiver != null         (explicit waiver)
 *   Violation → { ok: false, reason: 'closure_invariant' }
 *
 * case.waived: does NOT change state — it is a projection side-effect event.
 *   The payload must contain { reason, actor, evidence }.
 *
 * case.bootstrap: synthetic migration event — exempt from closure invariant
 *   (historical data). Uses payload.mappedState as the target state.
 */

import type { CommunityEvent, CommunityObjectProjection, CommunityObjectState } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { ok: true; next: CommunityObjectState }
  | { ok: false; reason: 'closure_invariant' | 'invalid_transition' };

/** Subset of projection needed for guard evaluation. */
type TransitionSnapshot = Pick<CommunityObjectProjection, 'lastPublicCommentAt' | 'closureWaiver'>;

// ---------------------------------------------------------------------------
// Transition table (explicit, not if-chains)
// ---------------------------------------------------------------------------

/**
 * Maps event kind → (currentState → targetState | null)
 * null means "not a valid transition from this state".
 * '*' means "valid from any state".
 */
type StateMatcher = '*' | Set<CommunityObjectState>;

interface TransitionRule {
  from: StateMatcher;
  to: CommunityObjectState | 'WAIVED' | 'BOOTSTRAP';
}

const TRANSITION_TABLE: Record<string, TransitionRule> = {
  // P1-5 fix: "opened" events (plan: 仅当无既有状态) only valid from 'new'
  // This prevents webhook retries from resetting an already-routed/fixed case.
  // issue.reopened intentionally uses '*' — it is an explicit user re-open action.
  'issue.opened': { from: new Set<CommunityObjectState>(['new']), to: 'new' },
  'pr.opened': { from: new Set<CommunityObjectState>(['new']), to: 'new' },
  'pr.ready_for_review': { from: new Set<CommunityObjectState>(['new']), to: 'new' },
  'issue.reopened': { from: '*', to: 'new' },

  'case.triaged': { from: '*', to: 'triaged' },
  'case.routed': { from: '*', to: 'routed' },
  'case.declined': { from: '*', to: 'declined' },
  'case.reported': { from: '*', to: 'reported' },

  // F168 Phase B: owner declares "waiting for external response"
  // Valid from in_progress, routed (primary post-accept workflow — Cloud R6 P1-1), or
  // awaiting_external (idempotent re-declare).
  'case.awaiting_external': {
    from: new Set<CommunityObjectState>(['in_progress', 'awaiting_external', 'routed']),
    to: 'awaiting_external',
  },

  'pr.merged': { from: '*', to: 'fixed' },
  'pr.closed': { from: '*', to: 'closed' },
  'issue.closed': { from: '*', to: 'closed' },

  // Waived: no state change, but validates payload
  'case.waived': { from: '*', to: 'WAIVED' },

  // Bootstrap: state comes from payload.mappedState
  'case.bootstrap': { from: '*', to: 'BOOTSTRAP' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWaiverPayloadValid(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.reason === 'string' &&
    payload.reason.length > 0 &&
    typeof payload.actor === 'string' &&
    payload.actor.length > 0 &&
    typeof payload.evidence === 'string' &&
    payload.evidence.length > 0
  );
}

function isBootstrapPayloadValid(
  payload: Record<string, unknown>,
): payload is { mappedState: CommunityObjectState; originalState: string } {
  const VALID_STATES: CommunityObjectState[] = [
    'new',
    'triaged',
    'routed',
    'in_progress',
    'awaiting_external',
    'needs_info',
    'fixed',
    'reported',
    'closed',
    'declined',
  ];
  return typeof payload.mappedState === 'string' && VALID_STATES.includes(payload.mappedState as CommunityObjectState);
}

// ---------------------------------------------------------------------------
// Main pure function
// ---------------------------------------------------------------------------

/** OWNER and MEMBER are the two GitHub associations treated as "maintainer" for delivery policy. */
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER']);

export function transition(
  current: CommunityObjectState,
  event: CommunityEvent,
  snapshot: TransitionSnapshot,
): TransitionResult {
  // ─── F168 Phase B: informational events in awaiting_external ────────────
  // When the owner has declared they're waiting for an external response and
  // a new activity arrives, automatically restore state based on who acted:
  //   - External actor (not OWNER/MEMBER) → in_progress (wake owner)
  //   - Maintainer (OWNER/MEMBER)         → stay in awaiting_external (silent)
  //
  // From any other state, informational events are not state-changing — the
  // projector handles them as lastExternalActivityAt updates only.
  if (event.classification === 'informational') {
    if (current === 'awaiting_external') {
      const payload = event.payload as Record<string, unknown>;
      const authorAssociation = typeof payload.authorAssociation === 'string' ? payload.authorAssociation : undefined;
      // Cloud R9 P2: treat missing authorAssociation as "not an external respondent".
      // Label/unlabeled events carry no authorAssociation in GitHubRepoWebhookHandler —
      // they are silent metadata and must NOT wake the owner. Only a confirmed external
      // actor (authorAssociation present and not OWNER/MEMBER) triggers in_progress.
      const isExternalRespondent = authorAssociation !== undefined && !MAINTAINER_ASSOCIATIONS.has(authorAssociation);
      return { ok: true, next: isExternalRespondent ? 'in_progress' : 'awaiting_external' };
    }
    // From any other state: informational event has no state transition
    return { ok: false, reason: 'invalid_transition' };
  }

  const rule = TRANSITION_TABLE[event.kind];

  // Unknown event kind
  if (!rule) {
    return { ok: false, reason: 'invalid_transition' };
  }

  // Validate that the current state is allowed (always '*' in table above)
  // — kept explicit for future partial-from restrictions.
  if (rule.from !== '*') {
    const allowed = rule.from as Set<CommunityObjectState>;
    if (!allowed.has(current)) {
      return { ok: false, reason: 'invalid_transition' };
    }
  }

  // ─── Special cases ──────────────────────────────────────────────────────

  // case.waived: validate payload, do not change state
  if (rule.to === 'WAIVED') {
    if (!isWaiverPayloadValid(event.payload)) {
      return { ok: false, reason: 'invalid_transition' };
    }
    return { ok: true, next: current };
  }

  // case.bootstrap: exempt from closure invariant, state from payload
  if (rule.to === 'BOOTSTRAP') {
    if (!isBootstrapPayloadValid(event.payload)) {
      return { ok: false, reason: 'invalid_transition' };
    }
    return { ok: true, next: event.payload.mappedState as CommunityObjectState };
  }

  const targetState = rule.to as CommunityObjectState;

  // ─── Closure invariant guard ─────────────────────────────────────────────
  // fixed → closed requires reported evidence OR an explicit waiver.
  if (current === 'fixed' && targetState === 'closed') {
    const hasReported = snapshot.lastPublicCommentAt !== null;
    const hasWaiver = snapshot.closureWaiver !== null;
    if (!hasReported && !hasWaiver) {
      return { ok: false, reason: 'closure_invariant' };
    }
  }

  return { ok: true, next: targetState };
}
