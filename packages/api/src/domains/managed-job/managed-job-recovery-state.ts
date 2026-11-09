import type { DurableManagedGateJob } from './managed-job-types.js';

export const MANAGED_JOB_RECOVERY_INTERVAL_MS = 30_000;
export const MANAGED_JOB_RECOVERY_MAX_ERRORS = 5;

export type ManagedJobRecoveryOutcome =
  | { kind: 'waiting' }
  | { kind: 'retryable_error'; reason: string }
  | { kind: 'permanent_error'; reason: string }
  | { kind: 'stale' }
  | { kind: 'settled' };

export interface ManagedJobRecoveryFact {
  readonly version: 1;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly disposition?: 'parked' | 'interrupted' | 'needs_attention';
  readonly reasonCode?: string;
  readonly recheck?: { readonly kind: 'observe_original_job'; readonly jobId: string };
  readonly observedRevision?: number;
  readonly claim?: { readonly expiresAt: number };
  readonly notification?: {
    readonly key: string;
    readonly reasonCode: string;
    readonly attempts: number;
    readonly deliveredAt?: number;
  };
  readonly wakeIntent?: {
    readonly key: string;
    readonly terminalEpoch: number;
    readonly status: 'pending' | 'delivered' | 'not_applicable';
    readonly messageId?: string;
    readonly deliveredAt?: number;
    readonly ownerWaitRef?: string;
  };
}

export function initialManagedJobRecovery(nextAttemptAt: number | null): ManagedJobRecoveryFact {
  return { version: 1, attempts: 0, nextAttemptAt };
}

export function parseManagedJobRecovery(serialized: string): ManagedJobRecoveryFact {
  const value = JSON.parse(serialized) as ManagedJobRecoveryFact;
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    (value.nextAttemptAt !== null && !Number.isFinite(value.nextAttemptAt))
  )
    throw new Error('managed_job_invalid_recovery_fact');
  return value;
}

export function managedJobWakeIntentKey(job: DurableManagedGateJob, terminalEpoch: number): string {
  const target = job.wakeTarget;
  return `${job.jobId}:${terminalEpoch}:${JSON.stringify([target.userId, target.threadId, target.catId])}`;
}

/** This is called in the business terminal transaction, never from a read-side projection. */
export function terminalManagedJobRecovery(
  job: DurableManagedGateJob,
  terminalEpoch: number,
  now: number,
  previous: ManagedJobRecoveryFact,
): ManagedJobRecoveryFact {
  // Alpha subscriptions own their own outcome handoff; they are not command holds.
  if (job.consumer) return { ...previous, nextAttemptAt: null };
  return {
    ...previous,
    version: 1,
    attempts: 0,
    disposition: undefined,
    reasonCode: undefined,
    claim: undefined,
    nextAttemptAt: now,
    wakeIntent: { key: managedJobWakeIntentKey(job, terminalEpoch), terminalEpoch, status: 'pending' },
  };
}

export function recoveryForManagedJobWrite(
  job: DurableManagedGateJob,
  state: unknown,
  revision: number,
  now: number,
  previous: ManagedJobRecoveryFact,
  changed: boolean,
): ManagedJobRecoveryFact {
  if (state === 'terminal') return terminalManagedJobRecovery(job, revision, now, previous);
  if (previous.disposition && !changed) return previous;
  const { claim: _claim, ...current } = previous;
  return {
    ...current,
    ...(changed ? { attempts: 0, disposition: undefined, reasonCode: undefined } : {}),
    nextAttemptAt: changed ? now : now + MANAGED_JOB_RECOVERY_INTERVAL_MS,
  };
}

/** Normal waiting and contention never consume the error budget. Parked jobs keep their business state. */
export function applyManagedJobRecoveryOutcome(
  current: ManagedJobRecoveryFact,
  outcome: ManagedJobRecoveryOutcome,
  jobId: string,
  now: number,
): ManagedJobRecoveryFact {
  if (outcome.kind === 'stale') return current;
  if (outcome.kind === 'settled') return { ...current, nextAttemptAt: null };
  if (outcome.kind === 'waiting') return { ...current, nextAttemptAt: now + MANAGED_JOB_RECOVERY_INTERVAL_MS };
  const attempts = current.attempts + (outcome.kind === 'retryable_error' ? 1 : 0);
  if (outcome.kind === 'permanent_error' || attempts >= MANAGED_JOB_RECOVERY_MAX_ERRORS) {
    const disposition = outcome.kind === 'permanent_error' ? 'needs_attention' : 'parked';
    return {
      ...current,
      attempts,
      disposition,
      reasonCode: outcome.reason,
      recheck: { kind: 'observe_original_job', jobId },
      nextAttemptAt: now,
      notification: current.notification ?? {
        key: `managed-job-recovery:${jobId}:${outcome.reason}`,
        reasonCode: outcome.reason,
        attempts: 0,
      },
    };
  }
  return { ...current, attempts, nextAttemptAt: now + Math.min(300_000, 1000 * 2 ** attempts) };
}
