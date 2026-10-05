/**
 * Event-wait wakes built through the REAL outcome producer (`transitionWaitState`), so a test
 * that depends on the `outcomeId` format fails when the producer drifts instead of passing on a
 * hand-typed string.
 */
import assert from 'node:assert/strict';
import { createWaitContinuationCarrier } from '@cat-cafe/shared';
import { transitionWaitState } from '../../dist/domains/ball-custody/wait-state-machine.js';

function activeAwait(subjectRef) {
  return {
    v: 1,
    generation: 4,
    subjectRef,
    ownerFence: { kind: 'containing_task', generation: 4 },
    baseline: { capturedAt: 100, headSha: 'aaaa1111', review: { decisionCursor: 30 } },
    continuation: {
      when: [{ kind: 'pr_head_changed' }],
      // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this continuation field `then`.
      then: 'Re-lock the exact HEAD.',
    },
    expiresAt: 10_000,
    createdAt: 100,
  };
}

const TRANSITIONS = {
  matched: { type: 'predicates_matched', generation: 4, at: 500, matched: [{ kind: 'pr_head_changed', delta: 'x' }] },
  subject_terminal: { type: 'subject_terminal', generation: 4, at: 500, subjectState: 'closed' },
  expired: { type: 'expired', generation: 4, at: 500 },
  user_cancel: { type: 'user_cancel', generation: 4, at: 500, actor: { kind: 'user', userId: 'user1' } },
  owner_changed: { type: 'owner_changed', generation: 4, at: 500 },
  superseded: { type: 'superseded', generation: 4, at: 500 },
};

export function eventWaitWake(waitContinuationCarrier, { holderCatId, subjectKey }) {
  return { kind: 'structured', protocol: 'event_wait', subjectKey, holderCatId, waitContinuationCarrier };
}

/** The event_wait wake that a real wait outcome with this reason produces. */
export function realWaitWake(reason, { holderCatId, subjectKey, subjectRef = 'pr:zts212653/cat-cafe#3300' }) {
  const result = transitionWaitState({ await: activeAwait(subjectRef) }, TRANSITIONS[reason]);
  assert.equal(result.applied, true, `${reason} must be a real applied transition`);
  return eventWaitWake(createWaitContinuationCarrier('wait-1', result.state.waitOutcome), { holderCatId, subjectKey });
}

/** A wake around an arbitrary outcomeId, for shapes the real producer never emits. */
export function wakeWithOutcomeId(outcomeId, { holderCatId, subjectKey }) {
  return eventWaitWake(
    { v: 1, waitId: 'wait-1', outcomeId, ownerFence: { kind: 'containing_task', generation: 4 } },
    { holderCatId, subjectKey },
  );
}
