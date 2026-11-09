import type { TaskItem, TaskRecoveryIncident, UpdateTaskInput } from '@cat-cafe/shared';
import { recoveryGuarded } from '../../infrastructure/recovery/recovery-deadline.js';
import { runDueBatch } from '../../infrastructure/recovery/run-due-batch.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { isOrdinaryImplementTask } from '../cats/services/stores/ports/TaskStoreContract.js';
import type {
  ActionSuccessorCompletionResult,
  ActionSuccessorCompletionService,
} from './ActionSuccessorCompletionService.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import { recordActionRecoveryBatchFailure, runActionDueRecovery } from './action-successor-due-recovery.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

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
      leaseStore: Pick<ActionSuccessorLeaseStore, 'getByIdentity' | 'listActiveTaskLeases' | 'recovery'>;
      now?: () => number;
      completionService: Pick<ActionSuccessorCompletionService, 'complete'>;
    },
  ) {
    this.deps = recoveryGuarded(deps);
  }

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
    const result = await this.completeLease(lease, task, ownerCatId);
    if (result.outcome !== 'committed')
      throw new Error(`task action completion rejected: ${result.outcome}: ${result.reason}`);
    return true;
  }

  async reconcileDoneTasks(taskStore: Pick<ITaskStore, 'get'>, limit = 100): Promise<TaskActionRecoveryStats> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('task action recovery limit must be positive');
    const stats: TaskActionRecoveryStats = {
      scanned: 0,
      attempted: 0,
      committed: 0,
      skipped: 0,
      errored: 0,
    };
    const batch = await runDueBatch({
      limit,
      budgetMs: 5000,
      selectDue: async (count) => await this.deps.leaseStore.listActiveTaskLeases(count, (this.deps.now ?? Date.now)()),
      process: async (lease) => {
        const outcome = await runActionDueRecovery({
          port: this.deps.leaseStore.recovery,
          lease,
          lane: 'task',
          now: (this.deps.now ?? Date.now)(),
          recover: async (current) => {
            const taskId = current.subjectRef.slice('subject:task:'.length);
            const task = await taskStore.get(taskId);
            if (!task || task.status !== 'done' || isOrdinaryImplementTask(task)) {
              stats.skipped += 1;
              return !task
                ? { kind: 'permanent_error', reason: 'task_missing' }
                : { kind: isOrdinaryImplementTask(task) ? 'settled' : 'waiting' };
            }
            stats.attempted += 1;
            let ownerCatId: string;
            try {
              ownerCatId = this.assertLeaseMatchesTask(current, task);
            } catch {
              return { kind: 'permanent_error', reason: 'task_standing_mismatch' };
            }
            const completion = await this.completeLease(current, task, ownerCatId);
            if (completion.outcome === 'committed') {
              stats.committed += 1;
              return { kind: 'settled' };
            }
            if (completion.outcome === 'stale') return { kind: 'stale' };
            if (completion.outcome === 'insufficient') return { kind: 'waiting' };
            return { kind: 'permanent_error', reason: 'task_completion_evidence_mismatch' };
          },
        });
        if (outcome.kind === 'permanent_error' || outcome.kind === 'retryable_error') stats.errored += 1;
      },
      onItemError: (lease, error) =>
        recordActionRecoveryBatchFailure(
          this.deps.leaseStore.recovery,
          lease,
          'task',
          (this.deps.now ?? Date.now)(),
          error,
        ),
    });
    stats.scanned = batch.selected;
    stats.errored += batch.failed;
    return stats;
  }

  async readRecoveryIncidents(task: TaskItem): Promise<TaskRecoveryIncident[]> {
    const lease = await this.getActiveLease(task);
    const recovery = this.deps.leaseStore.recovery;
    if (!lease || !recovery) return [];
    const lanes = ['return', 'dispatch', 'task'] as const;
    const snapshots = await Promise.allSettled(lanes.map((lane) => recovery.read(lease.leaseId, lane)));
    return snapshots.flatMap((result, index) => {
      const lane = lanes[index];
      if (lane === undefined) return [];
      if (result.status === 'rejected')
        return [
          {
            source: 'action_successor' as const,
            lane,
            disposition: 'needs_attention' as const,
            reasonCode: 'action_recovery_lane_read_failed',
            executionRef: `action-successor:${lease.leaseId}:g${lease.generation}:${lane}`,
          },
        ];
      const snapshot = result.value;
      if (
        snapshot &&
        (snapshot.lease.leaseId !== lease.leaseId ||
          snapshot.lease.generation !== lease.generation ||
          snapshot.fact.generation !== lease.generation)
      )
        return [];
      const fact = snapshot?.fact;
      return fact?.disposition && fact.reasonCode
        ? [
            {
              source: 'action_successor' as const,
              lane,
              disposition: fact.disposition,
              reasonCode: fact.reasonCode,
              executionRef: `action-successor:${lease.leaseId}:g${lease.generation}:${lane}`,
            },
          ]
        : [];
    });
  }

  private async getActiveLease(task: TaskItem): Promise<ActionSuccessorLease | null> {
    if (isOrdinaryImplementTask(task)) return null;
    if (!task.userId) return null;
    const lease = await this.deps.leaseStore.getByIdentity({
      tenantScope: task.userId,
      subjectRef: taskSubjectRef(task.id),
      actionFamily: 'implement',
      successorSlot: 'implementer',
    });
    return lease?.status === 'active' ? lease : null;
  }

  private async completeLease(
    lease: ActionSuccessorLease,
    task: TaskItem,
    ownerCatId: string,
  ): Promise<ActionSuccessorCompletionResult> {
    return this.deps.completionService.complete({
      leaseId: lease.leaseId,
      generation: lease.generation,
      catId: ownerCatId,
      evidenceRefs: [taskDoneEvidenceRef(task)],
      now: task.updatedAt,
    });
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
