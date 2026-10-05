import {
  DEVELOPMENT_RETURN_TEMPLATE_ID,
  type DevelopmentReturnRegistrationV1,
  developmentReturnRegistrationV1Schema,
  type ProducerAttentionReevaluationLinkV1,
  producerAttentionReevaluationLinkV1Schema,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import {
  normalizeOwnerAuthProvenance,
  type OwnerAuthProvenance,
  requireOwnerAuthProvenance,
} from '../../domains/cats/services/owner-auth-provenance.js';
import { assertDevelopmentReturnChain } from './development-return/DevelopmentReturnChain.js';
import { MANAGED_COMMAND_CANDIDATE_FILTER } from './managed-command-candidate-schema.js';
import type { TaskDisplayMeta, TriggerSpec } from './types.js';

function returnIdentity(state: DevelopmentReturnRegistrationV1): string {
  const {
    status: _status,
    reason: _reason,
    report: _report,
    wakeMessageId: _wake,
    deliveryRevision: _revision,
    ...identity
  } = state;
  return JSON.stringify(identity);
}

/** Persisted dynamic task definition — user config stored in SQLite */
export interface DynamicTaskDef {
  id: string;
  templateId: string;
  trigger: TriggerSpec;
  params: Record<string, unknown>;
  entrustedWorkReevaluation?: ProducerAttentionReevaluationLinkV1;
  display: TaskDisplayMeta;
  deliveryThreadId: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

/** CRUD store for dynamic task definitions (Phase 3A AC-G3) */
export class DynamicTaskStore {
  constructor(private db: Database.Database) {}

  insert(
    def: DynamicTaskDef,
    privateOwnerAuthProvenance?: OwnerAuthProvenance,
    privateReturn?: DevelopmentReturnRegistrationV1,
    reviewedSource = false,
  ): void {
    const registration = privateReturn ? developmentReturnRegistrationV1Schema.parse(privateReturn) : null;
    if (reviewedSource && !registration) throw new Error('Reviewed return requires its private registration');
    if (
      registration &&
      (def.templateId !== DEVELOPMENT_RETURN_TEMPLATE_ID ||
        registration.registrationId !== def.id ||
        registration.ownerThreadId !== def.deliveryThreadId ||
        registration.ownerCatId !== def.createdBy)
    ) {
      throw new Error('Execution return does not match its canonical schedule definition');
    }
    const ownerAuthProvenance =
      privateOwnerAuthProvenance === undefined ? null : requireOwnerAuthProvenance(privateOwnerAuthProvenance);
    this.db
      .transaction(() => {
        if (registration)
          assertDevelopmentReturnChain(registration, this.findPrivateExecutionReturns(registration.ownerThreadId));
        this.db
          .prepare(
            `INSERT INTO dynamic_task_defs (id, template_id, trigger_json, params_json, entrusted_work_reevaluation_json, display_json, delivery_thread_id, enabled, created_by, created_at, owner_auth_provenance, development_return_json, reviewed_development_return_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            def.id,
            def.templateId,
            JSON.stringify(def.trigger),
            JSON.stringify(def.params),
            def.entrustedWorkReevaluation ? JSON.stringify(def.entrustedWorkReevaluation) : null,
            JSON.stringify(def.display),
            def.deliveryThreadId,
            def.enabled && !reviewedSource ? 1 : 0,
            def.createdBy,
            def.createdAt,
            ownerAuthProvenance,
            registration && !reviewedSource ? JSON.stringify(registration) : null,
            reviewedSource ? JSON.stringify(registration) : null,
          );
      })
      .immediate();
  }

  /**
   * Replace the executable projection for a stable dynamic definition id.
   * Creation provenance stays attached to the identity while mutable execution
   * fields are updated atomically.
   */
  upsert(def: DynamicTaskDef): void {
    if (this.getPrivateExecutionReturn(def.id)) throw new Error('Execution return requires its typed owner transition');
    this.db
      .prepare(
        `INSERT INTO dynamic_task_defs (id, template_id, trigger_json, params_json, entrusted_work_reevaluation_json, display_json, delivery_thread_id, enabled, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           template_id = excluded.template_id,
           trigger_json = excluded.trigger_json,
           params_json = excluded.params_json,
           entrusted_work_reevaluation_json = excluded.entrusted_work_reevaluation_json,
           display_json = excluded.display_json,
           delivery_thread_id = excluded.delivery_thread_id,
           enabled = excluded.enabled`,
      )
      .run(
        def.id,
        def.templateId,
        JSON.stringify(def.trigger),
        JSON.stringify(def.params),
        def.entrustedWorkReevaluation ? JSON.stringify(def.entrustedWorkReevaluation) : null,
        JSON.stringify(def.display),
        def.deliveryThreadId,
        def.enabled ? 1 : 0,
        def.createdBy,
        def.createdAt,
      );
  }

  getAll(): DynamicTaskDef[] {
    const rows = this.db.prepare('SELECT * FROM dynamic_task_defs ORDER BY created_at DESC').all() as RawRow[];
    return rows.map(todef);
  }

  /** Read recoverable execution candidates without decoding historical definitions.
   * Disabled tombstones can still own a live command or a terminal receipt.
   * Lifecycle parsers remain the authority; this selector only removes settled
   * history before hydration, and never changes a task or its private provenance.
   */
  listManagedCommandCandidates(): DynamicTaskDef[] {
    const rows = this.db
      .prepare(`SELECT * FROM dynamic_task_defs
      WHERE ${MANAGED_COMMAND_CANDIDATE_FILTER}
      ORDER BY created_at DESC`)
      .all() as RawRow[];
    return rows.map(todef);
  }

  getById(id: string): DynamicTaskDef | null {
    const row = this.db.prepare('SELECT * FROM dynamic_task_defs WHERE id = ?').get(id) as RawRow | undefined;
    return row ? todef(row) : null;
  }

  /**
   * F167 #1449 Slice 1: query by delivery thread + created_by.
   * Enables task-ID-independent hold observability — callers can find
   * the current hold for a (threadId, catId) pair without knowing the task ID.
   */
  findByDeliveryThreadAndCreatedBy(threadId: string, createdBy: string): DynamicTaskDef[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM dynamic_task_defs WHERE delivery_thread_id = ? AND created_by = ? ORDER BY created_at DESC',
      )
      .all(threadId, createdBy) as RawRow[];
    return rows.map(todef);
  }

  /**
   * F275: server-private immutable owner proof for managed-command wake recovery.
   * It is deliberately excluded from DynamicTaskDef so schedule REST, approval
   * snapshots, notifications, and sockets cannot project it by object spread.
   */
  getPrivateOwnerAuthProvenance(id: string): OwnerAuthProvenance {
    const row = this.db.prepare('SELECT owner_auth_provenance FROM dynamic_task_defs WHERE id = ?').get(id) as
      | { owner_auth_provenance: unknown }
      | undefined;
    return normalizeOwnerAuthProvenance(row?.owner_auth_provenance);
  }

  remove(id: string): boolean {
    const registration = this.getPrivateExecutionReturn(id);
    if (registration) {
      if (registration.status === 'delivered' || registration.status === 'retired') return this.setEnabled(id, false);
      return this.replacePrivateExecutionReturn(id, registration, {
        ...registration,
        status: 'retired',
        reason: 'cancelled',
      });
    }
    const result = this.db.prepare('DELETE FROM dynamic_task_defs WHERE id = ?').run(id);
    return result.changes > 0;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const registration = this.getPrivateExecutionReturn(id);
    if (enabled && registration && ['retired', 'delivered'].includes(registration.status)) return false;
    if (!enabled && registration && !['retired', 'delivered'].includes(registration.status)) {
      return this.replacePrivateExecutionReturn(id, registration, {
        ...registration,
        status: 'retired',
        reason: 'cancelled',
      });
    }
    const result = this.db.prepare('UPDATE dynamic_task_defs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return result.changes > 0;
  }

  /**
   * F167 Phase M: persist a re-armed trigger (pre-fire defer updates fireAt).
   * Without this, a deferred once-task's new fireAt lives only in memory — on
   * restart, hydrateDynamic() reads the stale (earlier) fireAt and may treat the
   * wake as a missed window. Persisting keeps the defer durable across restarts.
   */
  updateTrigger(id: string, trigger: TriggerSpec): boolean {
    const result = this.db
      .prepare('UPDATE dynamic_task_defs SET trigger_json = ? WHERE id = ?')
      .run(JSON.stringify(trigger), id);
    return result.changes > 0;
  }

  /** F167 Phase Q: preserve hold lifecycle tombstones after timer retirement. */
  updateParams(id: string, params: Record<string, unknown>): boolean {
    const result = this.db
      .prepare('UPDATE dynamic_task_defs SET params_json = ? WHERE id = ?')
      .run(JSON.stringify(params), id);
    return result.changes > 0;
  }

  /** Compare-and-swap a lifecycle projection without introducing a second ledger. */
  updateParamsIfCurrent(id: string, current: Record<string, unknown>, next: Record<string, unknown>): boolean {
    if (this.getPrivateExecutionReturn(id)) throw new Error('Execution return requires its typed owner transition');
    const result = this.db
      .prepare('UPDATE dynamic_task_defs SET params_json = ? WHERE id = ? AND params_json = ?')
      .run(JSON.stringify(next), id, JSON.stringify(current));
    return result.changes > 0;
  }

  getPrivateExecutionReturn(id: string): DevelopmentReturnRegistrationV1 | null {
    const row = this.db
      .prepare(`SELECT COALESCE(reviewed_development_return_json, development_return_json)
      AS development_return_json FROM dynamic_task_defs WHERE id = ?`)
      .get(id) as { development_return_json: string | null } | undefined;
    return row?.development_return_json
      ? developmentReturnRegistrationV1Schema.parse(JSON.parse(row.development_return_json))
      : null;
  }

  replacePrivateExecutionReturn(
    id: string,
    current: DevelopmentReturnRegistrationV1,
    next: DevelopmentReturnRegistrationV1,
  ): boolean {
    const parsed = developmentReturnRegistrationV1Schema.parse(next);
    const parsedCurrent = developmentReturnRegistrationV1Schema.parse(current);
    if (parsed.registrationId !== id || current.registrationId !== id)
      throw new Error('Execution return identity mismatch');
    if (returnIdentity(parsedCurrent) !== returnIdentity(parsed))
      throw new Error('Execution return identity is immutable');
    if (current.status === 'retired' || current.status === 'delivered')
      throw new Error('Execution return terminal state cannot be changed');
    if (current.report && JSON.stringify(parsed.report) !== JSON.stringify(current.report))
      throw new Error('Execution return report is immutable');
    if (current.wakeMessageId && parsed.wakeMessageId !== current.wakeMessageId)
      throw new Error('Execution return wake identity is immutable');
    if (current.deliveryRevision !== undefined && current.deliveryRevision !== parsed.deliveryRevision)
      throw new Error('Execution return delivery revision is immutable');
    const enabled = parsed.status === 'delivered' || parsed.status === 'retired' ? 0 : 1;
    return (
      this.db
        .prepare(`UPDATE dynamic_task_defs SET
          development_return_json = CASE WHEN reviewed_development_return_json IS NULL THEN ? ELSE NULL END,
          reviewed_development_return_json = CASE WHEN reviewed_development_return_json IS NOT NULL THEN ? ELSE NULL END,
          enabled = CASE WHEN reviewed_development_return_json IS NOT NULL THEN 0 ELSE ? END
      WHERE id = ? AND COALESCE(reviewed_development_return_json, development_return_json) = ?`)
        .run(JSON.stringify(parsed), JSON.stringify(parsed), enabled, id, JSON.stringify(parsedCurrent)).changes > 0
    );
  }

  findPrivateExecutionReturns(executionThreadId: string): DevelopmentReturnRegistrationV1[] {
    const rows = this.db
      .prepare(`SELECT id FROM dynamic_task_defs WHERE template_id = ?
      AND (json_extract(COALESCE(reviewed_development_return_json, development_return_json), '$.executionThreadId') = ?
        OR json_extract(COALESCE(reviewed_development_return_json, development_return_json), '$.ownerThreadId') = ?)`)
      .all(DEVELOPMENT_RETURN_TEMPLATE_ID, executionThreadId, executionThreadId) as { id: string }[];
    return rows.flatMap(({ id }) => {
      const value = this.getPrivateExecutionReturn(id);
      return value ? [value] : [];
    });
  }
}

interface RawRow {
  id: string;
  template_id: string;
  trigger_json: string;
  params_json: string;
  entrusted_work_reevaluation_json: string | null;
  display_json: string;
  delivery_thread_id: string | null;
  enabled: number;
  created_by: string;
  created_at: string;
  reviewed_development_return_json: string | null;
}

function todef(row: RawRow): DynamicTaskDef {
  const params = JSON.parse(row.params_json) as Record<string, unknown>;
  return {
    id: row.id,
    templateId: row.template_id,
    trigger: JSON.parse(row.trigger_json),
    params,
    ...(row.entrusted_work_reevaluation_json
      ? {
          entrustedWorkReevaluation: producerAttentionReevaluationLinkV1Schema.parse(
            JSON.parse(row.entrusted_work_reevaluation_json),
          ),
        }
      : {}),
    display: JSON.parse(row.display_json),
    deliveryThreadId: row.delivery_thread_id,
    enabled: row.reviewed_development_return_json
      ? !['delivered', 'retired'].includes(
          developmentReturnRegistrationV1Schema.parse(JSON.parse(row.reviewed_development_return_json)).status,
        )
      : row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
