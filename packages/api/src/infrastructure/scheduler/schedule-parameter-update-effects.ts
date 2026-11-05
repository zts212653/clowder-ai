import type { ScheduleMutationAuditEntry, ScheduleMutationTaskDefinition } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { ScheduleMutationProposalStoreError } from './schedule-mutation-errors.js';
import {
  fingerprintDynamicTaskDef,
  getDynamicTask,
  insertScheduleMutationAudit,
  type ProposalRow,
  type ScheduleMutationEffectResult,
  toProposal,
} from './schedule-mutation-storage.js';

function drift(taskId: string): ScheduleMutationProposalStoreError {
  return new ScheduleMutationProposalStoreError(
    'SCHEDULE_TASK_DRIFT',
    409,
    `Dynamic task ${taskId} no longer matches the parameter update`,
  );
}

function writeParams(db: Database.Database, task: ScheduleMutationTaskDefinition): void {
  db.prepare('UPDATE dynamic_task_defs SET params_json = ? WHERE id = ?').run(JSON.stringify(task.params), task.id);
}

export function updateScheduleParametersWithAudit(
  db: Database.Database,
  taskId: string,
  expectedFingerprint: string,
  params: Record<string, unknown>,
  audit: ScheduleMutationAuditEntry,
): ScheduleMutationTaskDefinition {
  if (audit.actorKind !== 'cvo' || audit.action !== 'update' || audit.taskId !== taskId) {
    throw new Error('Direct schedule parameter update requires matching owner audit');
  }
  return db.transaction(() => {
    const current = getDynamicTask(db, taskId);
    if (!current || fingerprintDynamicTaskDef(current) !== expectedFingerprint) throw drift(taskId);
    const task = { ...current, params };
    writeParams(db, task);
    insertScheduleMutationAudit(db, audit);
    return task;
  })();
}

export function applyScheduleParameterUpdate(
  db: Database.Database,
  proposalId: string,
  appliedAt: number,
): ScheduleMutationEffectResult {
  const result = db.transaction(() => {
    const row = db.prepare('SELECT * FROM schedule_mutation_proposals WHERE proposal_id = ?').get(proposalId) as
      | ProposalRow
      | undefined;
    if (!row)
      throw new ScheduleMutationProposalStoreError('SCHEDULE_PROPOSAL_NOT_FOUND', 404, 'Schedule proposal not found');
    const proposal = toProposal(row);
    if (proposal.status !== 'applying' || proposal.mutation.kind !== 'update') {
      throw new ScheduleMutationProposalStoreError(
        'SCHEDULE_PROPOSAL_STATE',
        409,
        'Schedule proposal is not applying update',
      );
    }
    const mutation = proposal.mutation;
    const checkpoint = proposal.effectCheckpoint;
    if (checkpoint && checkpoint.kind !== 'update') {
      throw new ScheduleMutationProposalStoreError(
        'SCHEDULE_PROPOSAL_STATE',
        409,
        'Parameter update checkpoint kind mismatch',
      );
    }
    const current = getDynamicTask(db, mutation.taskId);
    if (checkpoint) {
      if (!current || fingerprintDynamicTaskDef(current) !== checkpoint.resultingFingerprint) {
        return { kind: 'superseded' as const };
      }
      return { kind: 'applied' as const, applied: false, task: current };
    }
    if (!current || fingerprintDynamicTaskDef(current) !== mutation.expectedFingerprint) {
      db.prepare(
        "UPDATE schedule_mutation_proposals SET status = 'pending', claimed_at = NULL WHERE proposal_id = ?",
      ).run(proposalId);
      return { kind: 'drift' as const, taskId: mutation.taskId };
    }
    const task = { ...current, params: mutation.params };
    const resultingFingerprint = fingerprintDynamicTaskDef(task);
    writeParams(db, task);
    db.prepare('UPDATE schedule_mutation_proposals SET effect_checkpoint_json = ? WHERE proposal_id = ?').run(
      JSON.stringify({
        kind: 'update',
        taskId: task.id,
        expectedFingerprint: mutation.expectedFingerprint,
        resultingFingerprint,
        appliedAt,
      }),
      proposalId,
    );
    insertScheduleMutationAudit(db, {
      auditId: `schedule-update:${proposalId}`,
      ownerUserId: proposal.ownerUserId,
      actorKind: 'cvo',
      actorId: proposal.ownerUserId,
      action: 'update',
      taskId: task.id,
      detail: {
        proposalId,
        requesterCatId: proposal.requesterCatId,
        expectedFingerprint: mutation.expectedFingerprint,
        resultingFingerprint,
      },
      createdAt: appliedAt,
    });
    return { kind: 'applied' as const, applied: true, task };
  })();
  if (result.kind === 'drift') throw drift(result.taskId);
  if (result.kind === 'superseded') return { applied: false, superseded: true };
  return { applied: result.applied, task: result.task };
}
