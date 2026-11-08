import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import { ManagedJobService } from '../managed-job/ManagedJobService.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import { readManagedCommandWakeProjection } from './managed-command-wake-task-projection.js';

/** Legacy descriptors are read in place; new carriers hold only an Action Plane reference. */
export function resolveManagedCommandJob(task: DynamicTaskDef): DurableManagedGateJob | undefined {
  const command = readManagedCommandWakeProjection(task);
  if (!command) return undefined;
  const job = command.jobId ? new ManagedJobService().resolve(command.jobId) : command.durableJob;
  return job && managedCommandJobMatchesTask(task, job) ? job : undefined;
}

/** Same owner association for an already-loaded worker snapshot and the synchronous mutation path. */
export function managedCommandJobMatchesTask(task: DynamicTaskDef, job: DurableManagedGateJob): boolean {
  return (
    job.originTaskId === task.id &&
    job.wakeTarget.threadId === task.deliveryThreadId &&
    job.wakeTarget.userId === task.params.triggerUserId &&
    task.createdBy === `hold-ball:${job.wakeTarget.catId}`
  );
}
