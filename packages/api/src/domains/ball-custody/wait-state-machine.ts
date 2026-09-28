import type {
  AwaitStateV1,
  GitHubWaitMatchedDelta,
  WaitOutcomeV1,
  WaitTerminationActor,
  WaitTerminationReason,
} from '@cat-cafe/shared';
import { parseWaitOwnerFence } from '@cat-cafe/shared';

export interface WaitRuntimeState {
  readonly await?: AwaitStateV1;
  readonly waitOutcome?: WaitOutcomeV1;
}

export type WaitTransitionEvent =
  | {
      readonly type: 'predicates_matched';
      readonly generation: number;
      readonly at: number;
      readonly matched: readonly GitHubWaitMatchedDelta[];
      /**
       * #1392 AC-1: how the lifecycle wants the next generation handled. Omitted keeps the
       * single-fire transition. `renew` carries the gap-free baseline N+1 starts from;
       * `rearm_failed` means that baseline could not be built.
       */
      readonly renewal?: WaitRenewalInstruction;
    }
  | {
      readonly type: 'subject_terminal';
      readonly generation: number;
      readonly at: number;
      readonly subjectState: 'merged' | 'closed';
      /** What the same observation matched; the terminal outcome carries it instead of dropping it. */
      readonly matched?: readonly GitHubWaitMatchedDelta[];
    }
  | {
      readonly type: 'expired' | 'owner_changed' | 'superseded';
      readonly generation: number;
      readonly at: number;
    }
  | {
      readonly type: 'user_cancel';
      readonly generation: number;
      readonly at: number;
      readonly actor: Extract<WaitTerminationActor, { kind: 'user' | 'cat' }>;
    };

export type WaitRenewalInstruction =
  | {
      readonly kind: 'renew';
      readonly baseline: AwaitStateV1['baseline'];
      /**
       * The registered continuation N+1 carries. The lifecycle may override `then` for a single
       * delivery (the review-loop brake's "pause once"); without this the override would be
       * copied into every later generation.
       */
      readonly continuation?: AwaitStateV1['continuation'];
    }
  | { readonly kind: 'rearm_failed' };

export type WaitTransitionResult =
  | { readonly applied: true; readonly state: WaitRuntimeState }
  | {
      readonly applied: false;
      readonly reason: 'generation_inactive' | 'empty_match';
      readonly state: WaitRuntimeState;
    };

function outcomeId(subjectRef: string, generation: number, reason: WaitTerminationReason): string {
  return `wait:${subjectRef}:g${generation}:${reason}`;
}

function terminalize(
  current: WaitRuntimeState,
  active: AwaitStateV1,
  input: {
    readonly reason: WaitTerminationReason;
    readonly at: number;
    readonly actor?: WaitTerminationActor;
    readonly matched?: readonly GitHubWaitMatchedDelta[];
    readonly subjectState?: 'merged' | 'closed';
  },
): WaitTransitionResult {
  // #1392 AC-2: expiry is a terminal outcome the owner hears about, never a silent disconnect.
  const delivery =
    input.reason === 'matched' || input.reason === 'subject_terminal' || input.reason === 'expired'
      ? 'pending'
      : 'not_applicable';
  const waitOutcome: WaitOutcomeV1 = {
    v: 1,
    outcomeId: outcomeId(active.subjectRef, active.generation, input.reason),
    generation: active.generation,
    subjectRef: active.subjectRef,
    ownerFence: active.ownerFence,
    reason: input.reason,
    at: input.at,
    delivery,
    actor: input.actor ?? { kind: 'system' },
    ...(input.matched?.length ? { matched: input.matched } : {}),
    ...(delivery === 'pending' ? { nextStep: active.continuation.then } : {}),
    ...(input.subjectState ? { terminalSubjectState: input.subjectState } : {}),
  };
  return {
    applied: true,
    state: {
      ...current,
      await: undefined,
      waitOutcome,
    },
  };
}

/**
 * #1392 AC-2: whether an await has passed its deadline. `expiresAt` is optional, and omitted
 * means no time-based termination at all.
 *
 * Every caller must ask this one function. Comparing against `active.expiresAt` directly is
 * wrong in both directions once the field can be absent: `at >= undefined` and
 * `at < undefined` are BOTH false, so one call site silently reads "not expired" while another
 * silently reads "expired-or-matched" — and the second skipped the collector patch on every quiet
 * poll with nothing woken to reveal it.
 */
export function isAwaitExpired(active: { readonly expiresAt?: number }, at: number): boolean {
  return active.expiresAt !== undefined && at >= active.expiresAt;
}

/**
 * #1392 AC-1: consume generation N, and — unless the wait is single-fire — install N+1 in the
 * same transition. There is no intermediate state in which N is consumed and nothing is armed,
 * so an outcome can never claim tracking continues when it does not.
 */
function consumeMatch(
  current: WaitRuntimeState,
  active: AwaitStateV1,
  event: Extract<WaitTransitionEvent, { type: 'predicates_matched' }>,
): WaitTransitionResult {
  const consumed = terminalize(current, active, { reason: 'matched', at: event.at, matched: event.matched });
  const outcome = consumed.state.waitOutcome;
  if (active.autoRenew === false || !event.renewal || !outcome) return consumed;

  if (event.renewal.kind === 'rearm_failed') {
    return { applied: true, state: { ...consumed.state, waitOutcome: { ...outcome, renewal: 'rearm_failed' } } };
  }

  const generation = active.generation + 1;
  const next = {
    ...active,
    generation,
    ownerFence: { kind: 'containing_task', generation },
    continuation: event.renewal.continuation ?? active.continuation,
    baseline: event.renewal.baseline,
    createdAt: event.at,
  } as AwaitStateV1;
  return {
    applied: true,
    state: { ...consumed.state, await: next, waitOutcome: { ...outcome, renewal: 'rearmed' } },
  };
}

/**
 * #1392 D4 (accepted in #1474): the two events carrying a fact the clock must not overwrite.
 *
 * A subject that reached its terminal state and an owner who explicitly cancelled are the answers the
 * wait existed to deliver. Judging the deadline first rewrote both to `expired`, and because the
 * expiry branch built its outcome without an actor, a cancel also lost its canceller to the
 * `system` fallback in `terminalize`. Routing both past the guard restores the typed reason and the
 * operator in one move.
 *
 * The boundary is deliberately narrow. Only the still-active generation named by this very transition
 * is affected — a mismatched or already-terminalized generation is rejected above this point, so no
 * persisted outcome is ever rewritten. An ordinary late `predicates_matched` still expires and is
 * still not renewed: relevance observed after the deadline is a guess, while a close, a merge or a
 * cancel is settled.
 */
const TERMINAL_FACT_EVENTS: ReadonlySet<WaitTransitionEvent['type']> = new Set(['subject_terminal', 'user_cancel']);

export function transitionWaitState(current: WaitRuntimeState, event: WaitTransitionEvent): WaitTransitionResult {
  const active = current.await;
  if (!active || active.generation !== event.generation) {
    return { applied: false, reason: 'generation_inactive', state: current };
  }

  if (!TERMINAL_FACT_EVENTS.has(event.type) && isAwaitExpired(active, event.at)) {
    // #1392 AC-2: a deadline ends tracking, not the poll it is noticed in. What that poll observed may
    // predate the deadline, and nothing polls this wait again, so it is delivered with the expiry.
    const matched = 'matched' in event ? event.matched : undefined;
    return terminalize(current, active, {
      reason: 'expired',
      at: event.at,
      ...(matched ? { matched } : {}),
    });
  }

  switch (event.type) {
    case 'predicates_matched':
      if (event.matched.length === 0) {
        return { applied: false, reason: 'empty_match', state: current };
      }
      return consumeMatch(current, active, event);
    case 'subject_terminal':
      return terminalize(current, active, {
        reason: 'subject_terminal',
        at: event.at,
        subjectState: event.subjectState,
        ...(event.matched ? { matched: event.matched } : {}),
      });
    case 'user_cancel':
      return terminalize(current, active, {
        reason: 'user_cancel',
        at: event.at,
        actor: event.actor,
      });
    case 'expired':
    case 'owner_changed':
    case 'superseded':
      return terminalize(current, active, { reason: event.type, at: event.at });
  }
}

export function markWaitOutcomeDelivered(current: WaitRuntimeState, outcomeId: string): WaitRuntimeState {
  if (current.waitOutcome?.outcomeId !== outcomeId || current.waitOutcome.delivery !== 'pending') {
    return current;
  }
  return {
    ...current,
    waitOutcome: {
      ...current.waitOutcome,
      delivery: 'delivered',
    },
  };
}

export function markWaitOutcomeLegacyUnfenced(current: WaitRuntimeState, outcomeId: string): WaitRuntimeState {
  if (
    current.waitOutcome?.outcomeId !== outcomeId ||
    current.waitOutcome.delivery !== 'pending' ||
    parseWaitOwnerFence(current.waitOutcome.ownerFence)
  ) {
    return current;
  }
  return {
    ...current,
    waitOutcome: {
      ...current.waitOutcome,
      delivery: 'legacy_unfenced',
    },
  };
}
