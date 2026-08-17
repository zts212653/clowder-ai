import type { UnifiedAwaitStateV1 } from './github-wait.js';

export const SCHEDULER_WAIT_PREDICATE_KINDS = ['timer_elapsed', 'managed_command_completed'] as const;

export type SchedulerWaitPredicateKind = (typeof SCHEDULER_WAIT_PREDICATE_KINDS)[number];

export type SchedulerWaitPredicate =
  | { readonly kind: 'timer_elapsed' }
  | { readonly kind: 'managed_command_completed' };

export type SchedulerWaitSubjectRef = `timer:${string}` | `command:${string}`;

export type SchedulerWaitBaseline =
  | {
      readonly kind: 'timer';
      readonly capturedAt: number;
      readonly fireAt: number;
    }
  | {
      readonly kind: 'managed_command';
      readonly capturedAt: number;
      readonly deadlineAt: number;
    };

/**
 * Phase-D projection of timer/managed-command waits into the F280 logical
 * contract. Scheduler execution remains owned by DynamicTask/ManagedRunner;
 * this value only records the typed condition and its canonical owner fence.
 */
export type SchedulerAwaitStateV1 = UnifiedAwaitStateV1<
  SchedulerWaitSubjectRef,
  SchedulerWaitBaseline,
  SchedulerWaitPredicate
> & {
  readonly provenance: 'explicit_registration';
};
