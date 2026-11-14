import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import { readDurableGateRecord } from '../managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../managed-job/ManagedJobService.js';
import { readManagedJobRecovery } from '../managed-job/managed-job-recovery-ledger.js';
import { durableManagedGateConsumerLines, projectDurableManagedGateConsumer } from './durable-managed-gate-consumer.js';
import {
  cancelDurableManagedGateJob,
  inspectDurableManagedGateJob,
  validateDurableManagedGateJob,
} from './durable-managed-gate-job.js';
import { resolveManagedCommandJob } from './managed-command-job-reference.js';
import { recoverManagedCommandProduction } from './managed-command-production-recovery.js';
import type {
  ManagedCommandWakeRecoveryDeps,
  ManagedCommandWakeRecoveryResult,
  ManagedCommandWakeRecoveryStats,
  RecordManagedCommandCompletionInput,
} from './managed-command-wake-lifecycle.js';
import {
  parseRetiredManagedCommandWakeTask,
  readManagedCommandWakeProjection,
} from './managed-command-wake-task-projection.js';

/** Reconcile producer truth and its exact original wait; receiver ownership stays in ball custody. */
export async function reconcileManagedCommandProducers(
  deps: ManagedCommandWakeRecoveryDeps,
  tasks: DynamicTaskDef[],
  now: () => number,
  recorders: {
    normal(input: RecordManagedCommandCompletionInput): Promise<ManagedCommandWakeRecoveryResult>;
    retired(input: RecordManagedCommandCompletionInput): Promise<ManagedCommandWakeRecoveryResult>;
  },
): Promise<ManagedCommandWakeRecoveryStats> {
  let recovered = 0;
  let pending = 0;
  // Action Plane reconciles EVERY producer, even if its F167 carrier was force-reset or already consumed.
  const service = new ManagedJobService();
  const dueJobs = service.recoveryDueJobs(now());
  const jobs = await service.reconcile([], now());
  const observed = new Map(jobs.map(({ job, inspection }) => [job.jobId, inspection]));
  const allTasks = new Map(tasks.map((task) => [task.id, task]));
  const producers = new Map([...dueJobs, ...jobs.map(({ job }) => job)].map((job) => [job.jobId, job]));
  for (const job of producers.values()) {
    // Due producers can reach their exact wait even when that wait's fallback is not due yet.
    const task = allTasks.get(job.originTaskId) ?? deps.dynamicTaskStore.getById(job.originTaskId);
    if (task) allTasks.set(task.id, task);
    await recoverManagedCommandProduction(deps, job, now());
  }
  const running = [...allTasks.values()].flatMap((task) => {
    const command = readManagedCommandWakeProjection(task);
    if (!command || command.state !== 'command_running') return [];
    const durableJob = resolveManagedCommandJob(task);
    const receiver = deps.dynamicTaskStore.getManagedCommandRecoveryState?.(task.id)?.fact;
    if (receiver?.disposition && receiver.reasonCode !== 'producer_parked') return [];
    if (durableJob && readManagedJobRecovery(durableJob)?.recovery.disposition) return [];
    return durableJob ? [{ task, durableJob, command }] : [];
  });
  for (const { task, durableJob, command } of running) {
    if (!validateDurableManagedGateJob(durableJob, task.id)) {
      pending += 1;
      continue;
    }
    const lifecycle = task.params.holdLifecycle;
    if (
      lifecycle &&
      typeof lifecycle === 'object' &&
      !Array.isArray(lifecycle) &&
      (lifecycle as Record<string, unknown>).status === 'cancel_requested'
    ) {
      const cancellation = lifecycle as Record<string, unknown>;
      cancelDurableManagedGateJob(durableJob, {
        cancelledBy:
          typeof cancellation.cancelledBy === 'string' ? cancellation.cancelledBy : 'persisted_hold_cancellation',
        reason: 'explicit_hold_cancel',
        now: now(),
      });
    }
    const inspection =
      readDurableGateRecord(durableJob)?.state === 'terminal'
        ? inspectDurableManagedGateJob(durableJob, { now: now() })
        : (observed.get(durableJob.jobId) ?? inspectDurableManagedGateJob(durableJob, { now: now() }));
    if (!('result' in inspection)) {
      pending += 1;
      continue;
    }
    const consumerLines = durableManagedGateConsumerLines(
      projectDurableManagedGateConsumer(durableJob, command.command, inspection.result, {
        ...(command.cwd ? { candidateRoot: command.cwd } : {}),
        controllerRoot: process.env.CAT_CAFE_RUNTIME_ROOT?.trim() || process.cwd(),
      }),
    );
    const completion = {
      taskId: task.id,
      wakeContent:
        `持球唤醒（命令完成）：退出码 ${inspection.result.exitCode}${inspection.result.timedOut ? '（超时）' : ''}\n` +
        (inspection.result.tailOutput ?? inspection.state) +
        (consumerLines.length > 0 ? `\n${consumerLines.join('\n')}` : ''),
      result: inspection.result,
    };
    const result = parseRetiredManagedCommandWakeTask(task)
      ? await recorders.retired(completion)
      : await recorders.normal(completion);
    if (result === 'recovered') recovered += 1;
    else if (result === 'pending') pending += 1;
  }
  return { scanned: running.length, recovered, pending };
}
