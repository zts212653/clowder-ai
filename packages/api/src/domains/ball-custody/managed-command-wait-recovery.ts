import { createModuleLogger } from '../../infrastructure/logger.js';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import { readManagedJobRecovery } from '../managed-job/managed-job-recovery-ledger.js';
import type { ManagedCommandWaitProcessResult } from './ManagedCommandWakeRecoveryEngine.js';
import { resolveManagedCommandJob } from './managed-command-job-reference.js';
import {
  type ManagedCommandWaitRecoveryFact,
  type ManagedCommandWaitRecoveryOutcome,
  planManagedCommandWaitRecovery,
} from './managed-command-wait-recovery-state.js';
import {
  type ManagedCommandWakeRecoveryDeps,
  type ManagedCommandWakeRecoveryResult,
  readManagedCommandWakeProjection,
} from './managed-command-wake-lifecycle.js';

const log = createModuleLogger('ball-custody/managed-wait-recovery');

function generation(task: DynamicTaskDef): number {
  const lifecycle = task.params.holdLifecycle as Record<string, unknown> | undefined;
  const awaiting = lifecycle?.await as Record<string, unknown> | undefined;
  return typeof awaiting?.generation === 'number' ? awaiting.generation : 0;
}

function consumptionMatches(task: DynamicTaskDef, fact: ManagedCommandWaitRecoveryFact): boolean {
  const command = readManagedCommandWakeProjection(task);
  if (!command?.messageId) return true;
  const ref = fact.consumption;
  return (
    !!ref &&
    ref.ownerTaskId === task.id &&
    ref.sourceMessageId === command.messageId &&
    ref.threadId === task.deliveryThreadId &&
    ref.userId === task.params.triggerUserId &&
    `hold-ball:${ref.catId}` === task.createdBy &&
    ref.generation === generation(task)
  );
}

/** Recovery facts and consumption fencing remain owned by this exact wait row, independent of the job producer. */
export async function processManagedCommandWait(
  deps: ManagedCommandWakeRecoveryDeps,
  taskId: string,
  run: () => Promise<ManagedCommandWaitProcessResult>,
  now: number,
  force: boolean,
): Promise<ManagedCommandWakeRecoveryResult> {
  const store = deps.dynamicTaskStore;
  const snapshot = store.getManagedCommandRecoveryState?.(taskId);
  if (!snapshot || !store.updateManagedCommandRecoveryState) return (await run()).result;
  const task = store.getById(taskId);
  if (!task) return 'missing';
  const command = readManagedCommandWakeProjection(task);
  const mayRecheckDisposition =
    snapshot.fact.disposition &&
    force &&
    command?.messageId &&
    Boolean(await deps.messageStore.getById?.(command.messageId));
  if (snapshot.fact.disposition && !mayRecheckDisposition) {
    const { notification: _legacyNotification, ...fact } = snapshot.fact as ManagedCommandWaitRecoveryFact & {
      notification?: unknown;
    };
    store.updateManagedCommandRecoveryState(taskId, snapshot.revision, { ...fact, nextAttemptAt: null });
    return 'pending';
  }
  if (snapshot.fact.claim && snapshot.fact.claim.expiresAt > now) return 'pending';
  let outcome: ManagedCommandWaitRecoveryOutcome | undefined;
  if (snapshot.fact.claim) outcome = { kind: 'retryable_error', reason: 'wait_observation_interrupted' };
  else if (!command) outcome = { kind: 'permanent_error', reason: 'invalid_managed_wait' };
  else if (!consumptionMatches(task, snapshot.fact))
    outcome = { kind: 'permanent_error', reason: 'wait_source_generation_mismatch' };
  const lifecycle = task.params.holdLifecycle as Record<string, unknown> | undefined;
  if (
    command?.state === 'consumed' ||
    command?.state === 'cancelled' ||
    (command?.state === 'not_started' && command.admissionFactAppended)
  )
    outcome = { kind: 'settled' };
  let revision = snapshot.revision;
  let result: ManagedCommandWakeRecoveryResult = 'pending';
  const { claim: _claim, ...current } = snapshot.fact;
  if (!outcome) {
    if (
      !store.updateManagedCommandRecoveryState(taskId, revision, {
        ...current,
        claim: { expiresAt: now + 10_000 },
        nextAttemptAt: now + 10_000,
      })
    )
      return 'pending';
    revision++;
    try {
      const producer =
        command?.state === 'command_running' && (command.jobId || command.durableJob)
          ? resolveManagedCommandJob(task)
          : null;
      if (command?.state === 'not_started' || (command?.admissionFact && !command.admissionFactAppended))
        outcome = { kind: 'retryable_error', reason: 'admission_visibility_failed' };
      else if (command?.state === 'command_running' && (command.jobId || command.durableJob) && !producer)
        outcome = { kind: 'retryable_error', reason: 'persistent_job_lookup_unavailable' };
      else if (producer && readManagedJobRecovery(producer)?.recovery.disposition)
        outcome = { kind: 'waiting', parkReason: 'producer_parked', notifyOwner: false };
      else if (lifecycle?.status !== 'active') outcome = { kind: 'waiting' };
      else {
        const processed = await run();
        outcome = processed.outcome;
        result = processed.result;
      }
    } catch (err) {
      outcome = { kind: 'retryable_error', reason: 'wait_observation_failed' };
      log.warn({ err, taskId }, 'Managed wait observation failed');
    }
  }
  const next = planManagedCommandWaitRecovery(current, outcome, taskId, now);
  store.updateManagedCommandRecoveryState(taskId, revision, next);
  return outcome.kind === 'settled' ? 'recovered' : result;
}
