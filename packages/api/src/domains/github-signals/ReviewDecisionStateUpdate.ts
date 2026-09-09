import type { AutomationState, PrAutomationState } from '@cat-cafe/shared';

export type ActiveReviewDecisionState = 'APPROVED' | 'CHANGES_REQUESTED';

export interface ReviewDecisionStateTransition {
  readonly reviewId: string;
  readonly expectedState: ActiveReviewDecisionState | null;
  readonly nextState: ActiveReviewDecisionState | null;
}

/**
 * A collector may describe either the one-time legacy snapshot or changes derived from an
 * already-persisted snapshot. It must never carry a replacement map: overlapping polls can
 * finish out of order, so a delayed full snapshot would restore a verdict a newer poll removed.
 */
export type ReviewDecisionStateUpdate =
  | {
      readonly kind: 'initialize_if_absent';
      readonly states: Readonly<Record<string, ActiveReviewDecisionState>>;
    }
  | {
      readonly kind: 'transitions';
      readonly transitions: readonly ReviewDecisionStateTransition[];
    };

function transitionStates(
  current: Readonly<Record<string, ActiveReviewDecisionState>> | undefined,
  update: ReviewDecisionStateUpdate,
): Readonly<Record<string, ActiveReviewDecisionState>> | undefined {
  if (update.kind === 'initialize_if_absent') {
    return current ?? { ...update.states };
  }
  // An absent map is the legacy migration marker. A transition derived from a newer schema
  // snapshot cannot complete that migration implicitly; the next full poll owns initialization.
  if (current === undefined) return undefined;

  let changed = false;
  const next = { ...current };
  for (const transition of update.transitions) {
    const currentState = next[transition.reviewId] ?? null;
    if (currentState !== transition.expectedState) continue;
    if (transition.nextState === null) {
      if (currentState !== null) {
        delete next[transition.reviewId];
        changed = true;
      }
    } else if (currentState !== transition.nextState) {
      next[transition.reviewId] = transition.nextState;
      changed = true;
    }
  }
  return changed ? next : current;
}

/** Apply source-derived review transitions to the latest CAS candidate, never to admission state. */
export function applyReviewDecisionStateUpdate(
  state: AutomationState | undefined,
  update: ReviewDecisionStateUpdate | undefined,
): AutomationState | undefined {
  if (!update) return state;
  const prState = (state ?? {}) as PrAutomationState;
  const current = prState.review?.activeDecisionStatesByReviewId;
  const next = transitionStates(current, update);
  if (next === current) return state;
  return {
    ...prState,
    review: {
      ...prState.review,
      activeDecisionStatesByReviewId: next,
    },
  };
}
