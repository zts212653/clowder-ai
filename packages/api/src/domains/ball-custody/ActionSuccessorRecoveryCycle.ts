import type { ActionSuccessorDispatchRecoveryStats } from './ActionSuccessorDispatchRecovery.js';
import type { ActionSuccessorRecoveryStats } from './ActionSuccessorRecoverySweep.js';
import type { TaskActionRecoveryStats } from './TaskActionSuccessorLifecycle.js';

type RecoveryCycleResult = readonly [
  ActionSuccessorRecoveryStats,
  ActionSuccessorDispatchRecoveryStats,
  TaskActionRecoveryStats | undefined,
];

/** The timer owns one complete cycle, including task completion reconciliation.
 * A fast failure must not release the cycle while its sibling still performs IO. */
export function createActionSuccessorRecoveryCycle(deps: {
  recoverReturns: () => Promise<ActionSuccessorRecoveryStats>;
  recoverDispatches: () => Promise<ActionSuccessorDispatchRecoveryStats>;
  reconcileDoneTasks: () => Promise<TaskActionRecoveryStats> | undefined;
}): () => Promise<RecoveryCycleResult | undefined> {
  let inFlight: Promise<RecoveryCycleResult> | undefined;
  return () => {
    if (inFlight) return Promise.resolve(undefined);
    const cycle = Promise.allSettled([
      Promise.resolve().then(deps.recoverReturns),
      Promise.resolve().then(deps.recoverDispatches),
      Promise.resolve().then(deps.reconcileDoneTasks),
    ])
      .then(([returns, dispatches, tasks]): RecoveryCycleResult => {
        const errors = [returns, dispatches, tasks].flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (returns.status === 'rejected' || dispatches.status === 'rejected' || tasks.status === 'rejected') {
          throw new AggregateError(errors, 'ActionSuccessor recovery cycle failed');
        }
        return [returns.value, dispatches.value, tasks.value];
      })
      .finally(() => {
        if (inFlight === cycle) inFlight = undefined;
      });
    inFlight = cycle;
    return cycle;
  };
}
