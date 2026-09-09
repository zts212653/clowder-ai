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

interface ReviewDecisionTransitionResult {
  readonly states: Readonly<Record<string, ActiveReviewDecisionState>> | undefined;
  readonly appliedTransitionReviewIds: ReadonlySet<string>;
}

function transitionStates(
  current: Readonly<Record<string, ActiveReviewDecisionState>> | undefined,
  update: ReviewDecisionStateUpdate,
): ReviewDecisionTransitionResult {
  if (update.kind === 'initialize_if_absent') {
    return {
      states: current ?? { ...update.states },
      appliedTransitionReviewIds: new Set(),
    };
  }
  // An absent map is the legacy migration marker. A transition derived from a newer schema
  // snapshot cannot complete that migration implicitly; the next full poll owns initialization.
  if (current === undefined) {
    return { states: undefined, appliedTransitionReviewIds: new Set() };
  }

  let changed = false;
  const next = { ...current };
  const appliedTransitionReviewIds = new Set<string>();
  for (const transition of update.transitions) {
    const currentState = next[transition.reviewId] ?? null;
    if (currentState !== transition.expectedState) continue;
    if (transition.nextState === null) {
      if (currentState !== null) {
        delete next[transition.reviewId];
        changed = true;
        appliedTransitionReviewIds.add(transition.reviewId);
      }
    } else if (currentState !== transition.nextState) {
      next[transition.reviewId] = transition.nextState;
      changed = true;
      appliedTransitionReviewIds.add(transition.reviewId);
    }
  }
  return {
    states: changed ? next : current,
    appliedTransitionReviewIds,
  };
}

/**
 * Apply source-derived review transitions to the latest CAS candidate, never to admission state.
 *
 * The receipt is also event authority: a mutable GitHub review revision may cross its numeric
 * frontier only when the transition derived from that revision actually changed this candidate.
 */
export function applyReviewDecisionStateUpdateWithReceipt(
  state: AutomationState | undefined,
  update: ReviewDecisionStateUpdate | undefined,
): {
  readonly state: AutomationState | undefined;
  readonly appliedTransitionReviewIds: ReadonlySet<string>;
} {
  if (!update) return { state, appliedTransitionReviewIds: new Set() };
  const prState = (state ?? {}) as PrAutomationState;
  const current = prState.review?.activeDecisionStatesByReviewId;
  const result = transitionStates(current, update);
  if (result.states === current) {
    return { state, appliedTransitionReviewIds: result.appliedTransitionReviewIds };
  }
  return {
    state: {
      ...prState,
      review: {
        ...prState.review,
        activeDecisionStatesByReviewId: result.states,
      },
    },
    appliedTransitionReviewIds: result.appliedTransitionReviewIds,
  };
}

export function applyReviewDecisionStateUpdate(
  state: AutomationState | undefined,
  update: ReviewDecisionStateUpdate | undefined,
): AutomationState | undefined {
  return applyReviewDecisionStateUpdateWithReceipt(state, update).state;
}
