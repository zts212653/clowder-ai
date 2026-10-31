import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import { ManagedJobService } from '../managed-job/ManagedJobService.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import { readManagedCommandWakeProjection } from './managed-command-wake-task-projection.js';

/** Legacy descriptors are read in place; new carriers hold only an Action Plane reference. */
export function resolveManagedCommandJob(task: DynamicTaskDef): DurableManagedGateJob | undefined {
  const command = readManagedCommandWakeProjection(task);
  if (!command) return undefined;
  if (!command.jobId) return command.durableJob;
  const job = new ManagedJobService().resolve(command.jobId);
  return job &&
    job.originTaskId === task.id &&
    job.wakeTarget.threadId === task.deliveryThreadId &&
    task.createdBy === `hold-ball:${job.wakeTarget.catId}`
    ? job
    : undefined;
}
