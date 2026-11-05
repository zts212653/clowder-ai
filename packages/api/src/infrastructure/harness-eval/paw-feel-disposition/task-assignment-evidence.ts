import {
  ownerTruthRefV1Schema,
  type PawFeelDispositionProjection,
  type PawFeelRepairBinding,
  type PawFeelRepairRequest,
} from '@cat-cafe/shared';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStore.js';
import { isOrdinaryImplementTask } from '../../../domains/cats/services/stores/ports/TaskStoreContract.js';

export async function resolveTaskRepairAssignment(
  tasks: Pick<ITaskStore, 'get'>,
  request: Extract<PawFeelRepairRequest, { kind: 'task_assignment' }>,
  userId?: string,
) {
  const task = await tasks.get(request.taskId);
  if (!task || !isOrdinaryImplementTask(task)) throw new Error('repair binding requires an ordinary Task');
  if (!userId || task.userId !== userId) throw new Error('repair Task tenant mismatch');
  if (!task.ownerCatId) throw new Error('repair Task has no named owner');
  if ((task.ownerRevision ?? 0) !== request.expectedOwnerRevision)
    throw new Error('repair Task assignment revision changed');
  if (task.status === 'done') throw new Error('repair Task is done');
  return {
    ownerCatId: task.ownerCatId,
    taskId: task.id,
    repairBinding: {
      kind: 'task_assignment' as const,
      taskId: task.id,
      ownerRevision: request.expectedOwnerRevision,
      taskThreadId: task.threadId,
    },
    custodyEvidenceRef: `task:${task.id}:assignment:${request.expectedOwnerRevision}`,
  };
}

export async function currentTaskRepairAssignment(
  tasks: Pick<ITaskStore, 'get'>,
  binding: Extract<PawFeelRepairBinding, { kind: 'task_assignment' }>,
  projection: PawFeelDispositionProjection,
) {
  const task = await tasks.get(binding.taskId);
  if (
    !task ||
    !isOrdinaryImplementTask(task) ||
    !task.userId ||
    !task.ownerCatId ||
    projection.taskId !== binding.taskId ||
    task.ownerCatId !== projection.ownerCatId ||
    task.threadId !== binding.taskThreadId ||
    (task.ownerRevision ?? 0) !== binding.ownerRevision ||
    projection.custodyEvidenceRef !== `task:${task.id}:assignment:${binding.ownerRevision}`
  )
    throw new Error('repair Task assignment identity changed');
  return task;
}

export function taskRepairTerminalRef(task: { id: string; updatedAt: number }) {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F310',
    ownerStateRef: `task-terminal:${task.id}`,
    version: String(task.updatedAt),
  });
}
