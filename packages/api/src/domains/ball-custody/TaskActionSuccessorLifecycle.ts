import type { TaskItem, UpdateTaskInput } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { ActionSuccessorCompletionService } from './ActionSuccessorCompletionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

const log = createModuleLogger('ball-custody/task-action-successor-lifecycle');

export interface TaskActionRecoveryStats {
  scanned: number;
  attempted: number;
  committed: number;
  skipped: number;
  errored: number;
}

function taskSubjectRef(taskId: string): string {
  return `subject:task:${taskId}`;
}

function taskDoneEvidenceRef(task: TaskItem): string {
  return `task:${task.id}:done:${task.updatedAt}`;
}

export class TaskActionSuccessorLifecycle {
  constructor(
    private readonly deps: {
      leaseStore: Pick<ActionSuccessorLeaseStore, 'getByIdentity' | 'listActiveTaskLeases'>;
      completionService: Pick<ActionSuccessorCompletionService, 'complete'>;
    },
  ) {}

  async assertUpdateAllowed(task: TaskItem, input: UpdateTaskInput): Promise<void> {
    const ownerChanges = input.ownerCatId !== undefined && input.ownerCatId !== task.ownerCatId;
    const threadChanges = input.threadId !== undefined && input.threadId !== task.threadId;
    if ((ownerChanges || threadChanges) && (await this.getActiveLease(task))) {
      throw new Error('cannot change owner or thread while an active task action lease exists');
    }
  }

  async assertDeleteAllowed(task: TaskItem): Promise<void> {
    if (await this.getActiveLease(task)) {
      throw new Error('cannot delete a task while an active task action lease exists');
    }
  }

  async completeStatusTransition(_before: TaskItem, updated: TaskItem): Promise<boolean> {
    if (updated.status !== 'done') return false;
    return this.completeDoneTask(updated);
  }

  async completeDoneTask(task: TaskItem): Promise<boolean> {
    if (task.status !== 'done') return false;
    const lease = await this.getActiveLease(task);
    if (!lease) return false;
    const ownerCatId = this.assertLeaseMatchesTask(lease, task);
    return this.completeLease(lease, task, ownerCatId);
  }

  async reconcileDoneTasks(taskStore: Pick<ITaskStore, 'get'>, limit = 100): Promise<TaskActionRecoveryStats> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('task action recovery limit must be positive');
    const leases = await this.deps.leaseStore.listActiveTaskLeases(limit);
    const stats: TaskActionRecoveryStats = {
      scanned: leases.length,
      attempted: 0,
      committed: 0,
      skipped: 0,
      errored: 0,
    };
    for (const lease of leases) {
      try {
        const taskId = lease.subjectRef.slice('subject:task:'.length);
        const task = await taskStore.get(taskId);
        if (!task || task.status !== 'done') {
          stats.skipped += 1;
          continue;
        }
        stats.attempted += 1;
        const ownerCatId = this.assertLeaseMatchesTask(lease, task);
        if (await this.completeLease(lease, task, ownerCatId)) stats.committed += 1;
      } catch (err) {
        stats.errored += 1;
        log.warn(
          {
            err,
            leaseId: lease.leaseId,
            generation: lease.generation,
            subjectRef: lease.subjectRef,
          },
          'F167 task ActionSuccessor completion recovery skipped an invalid lease',
        );
      }
    }
    return stats;
  }

  private async getActiveLease(task: TaskItem): Promise<ActionSuccessorLease | null> {
    if (!task.userId) return null;
    const lease = await this.deps.leaseStore.getByIdentity({
      tenantScope: task.userId,
      subjectRef: taskSubjectRef(task.id),
      actionFamily: 'implement',
      successorSlot: 'implementer',
    });
    return lease?.status === 'active' ? lease : null;
  }

  private async completeLease(lease: ActionSuccessorLease, task: TaskItem, ownerCatId: string): Promise<boolean> {
    const result = await this.deps.completionService.complete({
      leaseId: lease.leaseId,
      generation: lease.generation,
      catId: ownerCatId,
      evidenceRefs: [taskDoneEvidenceRef(task)],
      now: task.updatedAt,
    });
    if (result.outcome !== 'committed') {
      throw new Error(`task action completion rejected: ${result.outcome}: ${result.reason}`);
    }
    return true;
  }

  private assertLeaseMatchesTask(lease: ActionSuccessorLease, task: TaskItem): string {
    if (
      !task.ownerCatId ||
      lease.holderCatIds.length !== 1 ||
      lease.holderCatIds[0] !== task.ownerCatId ||
      lease.holderThreadId !== task.threadId ||
      lease.terminalPredicate?.kind !== 'task_done'
    ) {
      throw new Error('active task action lease no longer matches persisted task standing');
    }
    return task.ownerCatId;
  }
}
