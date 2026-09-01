import type { FreshnessClosureAggregate } from '@cat-cafe/shared';
import { assertFreshnessClosureNotTerminal, buildFreshnessClosureAttempt } from './FreshnessClosureStateMachine.js';

/**
 * Stop startup recovery before a new model invocation is claimed.
 * Pending custody keeps aggregate evidence without fabricating an attempt;
 * running custody records the real crashed invocation as failed.
 */
export function blockFreshnessClosureRecovery(
  closure: FreshnessClosureAggregate,
  input: { evidenceRefs: string[]; now: number },
): FreshnessClosureAggregate {
  assertFreshnessClosureNotTerminal(closure);
  if (closure.status !== 'pending' && closure.status !== 'running') {
    throw new Error('only a pending or running freshness closure may block startup recovery');
  }
  if (input.evidenceRefs.length === 0) throw new Error('startup recovery block requires evidence');
  const evidenceRefs = [...new Set(input.evidenceRefs)].slice(-16);
  const attempts =
    closure.status === 'running' && closure.activeAttempt
      ? [
          ...closure.attempts,
          buildFreshnessClosureAttempt(closure, {
            invocationId: closure.activeAttempt.invocationId,
            draftContent: closure.latestDraft.content,
            observedRawFrontierMessageId: closure.observedRawFrontierMessageId,
            outcome: 'failed',
            evidenceRefs,
            now: input.now,
          }),
        ]
      : closure.attempts;
  return {
    ...closure,
    status: 'blocked',
    activeAttempt: undefined,
    blockedReason: 'startup_recovery_requires_explicit_retry',
    blockedEvidenceRefs: evidenceRefs,
    attempts,
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}

export function recoverFreshnessClosureAttempt(
  closure: FreshnessClosureAggregate,
  input: { evidenceRef: string; now: number },
): FreshnessClosureAggregate {
  if (closure.status !== 'running' || !closure.activeAttempt) {
    throw new Error('only a running freshness closure attempt may be recovered');
  }
  if (!input.evidenceRef) throw new Error('recovery requires evidence');
  return {
    ...closure,
    status: 'pending',
    activeAttempt: undefined,
    attempts: [
      ...closure.attempts,
      buildFreshnessClosureAttempt(closure, {
        invocationId: closure.activeAttempt.invocationId,
        draftContent: closure.latestDraft.content,
        observedRawFrontierMessageId: closure.observedRawFrontierMessageId,
        outcome: 'failed',
        evidenceRefs: [input.evidenceRef],
        now: input.now,
      }),
    ],
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}

export function retryFreshnessClosure(
  closure: FreshnessClosureAggregate,
  input: { actorId: string; evidenceRef: string; now: number },
): FreshnessClosureAggregate {
  if (closure.status !== 'blocked') throw new Error('only a blocked freshness closure may be retried');
  if (!input.actorId || !input.evidenceRef) throw new Error('retry requires actor and evidence');
  return {
    ...closure,
    status: 'pending',
    blockedReason: undefined,
    blockedEvidenceRefs: undefined,
    automaticSuccessorAttemptCount: 0,
    retryEpoch: closure.retryEpoch + 1,
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}
