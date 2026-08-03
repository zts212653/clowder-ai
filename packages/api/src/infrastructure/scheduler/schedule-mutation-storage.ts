import { createHash } from 'node:crypto';
import type {
  ApprovalPublication,
  ScheduleMutationAuditAction,
  ScheduleMutationAuditEntry,
  ScheduleMutationEffectCheckpoint,
  ScheduleMutationProposal,
  ScheduleMutationTaskDefinition,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { DynamicTaskDef } from './DynamicTaskStore.js';

export interface ProposalRow {
  proposal_id: string;
  owner_user_id: string;
  requester_cat_id: string;
  mutation_json: string;
  status: ScheduleMutationProposal['status'];
  publication_json: string;
  effect_checkpoint_json: string | null;
  created_at: number;
  claimed_at: number | null;
  approved_at: number | null;
  approved_by: string | null;
  rejected_at: number | null;
  rejected_by: string | null;
  rejection_reason: string | null;
}

interface DynamicTaskRow {
  id: string;
  template_id: string;
  trigger_json: string;
  params_json: string;
  display_json: string;
  delivery_thread_id: string | null;
  enabled: number;
  created_by: string;
  created_at: string;
}

export interface AuditRow {
  audit_id: string;
  owner_user_id: string;
  actor_kind: ScheduleMutationAuditEntry['actorKind'];
  actor_id: string;
  action: ScheduleMutationAuditEntry['action'];
  task_id: string;
  detail_json: string;
  created_at: number;
}

export function fingerprintDynamicTaskDef(def: ScheduleMutationTaskDefinition | DynamicTaskDef): string {
  return createHash('sha256').update(stableJson(def)).digest('hex');
}

export function toProposal(row: ProposalRow): ScheduleMutationProposal {
  return {
    proposalId: row.proposal_id,
    ownerUserId: row.owner_user_id,
    requesterCatId: row.requester_cat_id,
    mutation: JSON.parse(row.mutation_json) as ScheduleMutationProposal['mutation'],
    status: row.status,
    publication: JSON.parse(row.publication_json) as ApprovalPublication,
    ...(row.effect_checkpoint_json
      ? { effectCheckpoint: JSON.parse(row.effect_checkpoint_json) as ScheduleMutationEffectCheckpoint }
      : {}),
    createdAt: row.created_at,
    ...(row.claimed_at == null ? {} : { claimedAt: row.claimed_at }),
    ...(row.approved_at == null ? {} : { approvedAt: row.approved_at }),
    ...(row.approved_by == null ? {} : { approvedBy: row.approved_by }),
    ...(row.rejected_at == null ? {} : { rejectedAt: row.rejected_at }),
    ...(row.rejected_by == null ? {} : { rejectedBy: row.rejected_by }),
    ...(row.rejection_reason == null ? {} : { rejectionReason: row.rejection_reason }),
  };
}

export function toAudit(row: AuditRow): ScheduleMutationAuditEntry {
  return {
    auditId: row.audit_id,
    ownerUserId: row.owner_user_id,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    action: row.action,
    taskId: row.task_id,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export function getDynamicTask(db: Database.Database, id: string): ScheduleMutationTaskDefinition | null {
  const row = db.prepare('SELECT * FROM dynamic_task_defs WHERE id = ?').get(id) as DynamicTaskRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    templateId: row.template_id,
    trigger: JSON.parse(row.trigger_json) as ScheduleMutationTaskDefinition['trigger'],
    params: JSON.parse(row.params_json) as Record<string, unknown>,
    display: JSON.parse(row.display_json) as ScheduleMutationTaskDefinition['display'],
    deliveryThreadId: row.delivery_thread_id,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function insertDynamicTask(db: Database.Database, task: ScheduleMutationTaskDefinition): void {
  db.prepare(
    `INSERT INTO dynamic_task_defs
      (id, template_id, trigger_json, params_json, display_json, delivery_thread_id, enabled, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.templateId,
    JSON.stringify(task.trigger),
    JSON.stringify(task.params),
    JSON.stringify(task.display),
    task.deliveryThreadId,
    task.enabled ? 1 : 0,
    task.createdBy,
    task.createdAt,
  );
}

export function insertDynamicTaskWithAudit(
  db: Database.Database,
  task: ScheduleMutationTaskDefinition,
  audit: ScheduleMutationAuditEntry,
): void {
  assertDirectMutationAudit(audit, 'create', task.id);
  db.transaction(() => {
    insertDynamicTask(db, task);
    insertScheduleMutationAudit(db, audit);
  })();
}

export function deleteDynamicTaskWithAudit(
  db: Database.Database,
  taskId: string,
  audit: ScheduleMutationAuditEntry,
): boolean {
  assertDirectMutationAudit(audit, 'delete', taskId);
  return db.transaction(() => {
    const result = db.prepare('DELETE FROM dynamic_task_defs WHERE id = ?').run(taskId);
    if (result.changes !== 1) return false;
    insertScheduleMutationAudit(db, audit);
    return true;
  })();
}

export function setDynamicTaskEnabledWithAudit(
  db: Database.Database,
  taskId: string,
  enabled: boolean,
  audit: ScheduleMutationAuditEntry,
): boolean {
  const action: ScheduleMutationAuditAction = enabled ? 'resume' : 'pause';
  assertDirectMutationAudit(audit, action, taskId);
  return db.transaction(() => {
    const result = db.prepare('UPDATE dynamic_task_defs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, taskId);
    if (result.changes !== 1) return false;
    insertScheduleMutationAudit(db, audit);
    return true;
  })();
}

export function insertScheduleMutationAudit(db: Database.Database, entry: ScheduleMutationAuditEntry): void {
  db.prepare(
    `INSERT INTO schedule_mutation_audit
      (audit_id, owner_user_id, actor_kind, actor_id, action, task_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.auditId,
    entry.ownerUserId,
    entry.actorKind,
    entry.actorId,
    entry.action,
    entry.taskId,
    JSON.stringify(entry.detail),
    entry.createdAt,
  );
}

function assertDirectMutationAudit(
  audit: ScheduleMutationAuditEntry,
  action: ScheduleMutationAuditAction,
  taskId: string,
): void {
  if (audit.action !== action || audit.taskId !== taskId) {
    throw new Error(`Schedule mutation audit must match ${action} for task ${taskId}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
