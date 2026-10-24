import {
  DEVELOPMENT_RETURN_TEMPLATE_ID,
  type DevelopmentReturnRegistrationV1,
  developmentReturnRegistrationV1Schema,
  type ProducerAttentionReevaluationLinkV1,
  producerAttentionReevaluationLinkV1Schema,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import {
  normalizeToolExecutionPolicy,
  parseToolExecutionPolicy,
} from '../../domains/cats/services/agents/invocation/tool-execution-policy.js';
import {
  normalizeOwnerAuthProvenance,
  type OwnerAuthProvenance,
  requireOwnerAuthProvenance,
} from '../../domains/cats/services/owner-auth-provenance.js';
import type { ToolExecutionPolicy } from '../../domains/cats/services/types.js';
import { assertDevelopmentReturnChain } from './development-return/DevelopmentReturnChain.js';
import { MANAGED_COMMAND_CANDIDATE_FILTER } from './managed-command-candidate-schema.js';
import { type RetainedManagedCommandState, reconcileRetainedManagedCommand } from './retained-managed-command.js';
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

export type DevelopmentReturnStorage = 'direct' | 'reviewed' | 'successor' | 'parent_bound';

/** Private registration facts; neither field may come from public schedule params. */
export interface DynamicTaskOwnerAuthorization {
  readonly ownerAuthProvenance: OwnerAuthProvenance;
  readonly toolExecutionPolicy?: ToolExecutionPolicy;
}

function developmentReturnColumns(
  registration: DevelopmentReturnRegistrationV1 | null,
  storage: DevelopmentReturnStorage,
) {
  const value = registration ? JSON.stringify(registration) : null;
  return {
    direct: storage === 'direct' ? value : null,
    reviewed: storage === 'reviewed' ? value : null,
    successor: storage === 'successor' ? value : null,
    parentBound: storage === 'parent_bound' ? value : null,
  };
}

/** CRUD store for dynamic task definitions (Phase 3A AC-G3) */
export class DynamicTaskStore {
  constructor(private db: Database.Database) {}

  reconcileRetainedManagedCommand(task: DynamicTaskDef): RetainedManagedCommandState {
    return reconcileRetainedManagedCommand(this.db, task);
  }

  insert(
    def: DynamicTaskDef,
    privateAuthorization?: OwnerAuthProvenance | DynamicTaskOwnerAuthorization,
    privateReturn?: DevelopmentReturnRegistrationV1,
    returnStorage: DevelopmentReturnStorage = 'direct',
    predecessorSupersession?: DevelopmentReturnRegistrationV1,
  ): void {
    const registration = privateReturn ? developmentReturnRegistrationV1Schema.parse(privateReturn) : null;
    if (returnStorage !== 'direct' && !registration) {
      throw new Error('Fenced return storage requires its private registration');
    }
    if (
      registration &&
      (def.templateId !== DEVELOPMENT_RETURN_TEMPLATE_ID ||
        registration.registrationId !== def.id ||
        registration.ownerThreadId !== def.deliveryThreadId ||
        registration.ownerCatId !== def.createdBy)
    ) {
      throw new Error('Execution return does not match its canonical schedule definition');
    }
    if (
      predecessorSupersession &&
      (!registration || registration.predecessorRegistrationId !== predecessorSupersession.registrationId)
    ) {
      throw new Error('Active return supersession must name the new registration predecessor');
    }
    const snapshot = typeof privateAuthorization === 'object' ? privateAuthorization : undefined;
    const ownerAuthProvenance =
      privateAuthorization === undefined
        ? null
        : requireOwnerAuthProvenance(snapshot ? snapshot.ownerAuthProvenance : privateAuthorization);
    // SQL NULL means the old writer did not record restrictions. JSON null proves this
    // authenticated registration had none; the two must not collapse on recovery.
    const toolPolicy = snapshot
      ? JSON.stringify(
          snapshot.toolExecutionPolicy === undefined
            ? null
            : normalizeToolExecutionPolicy(snapshot.toolExecutionPolicy),
        )
      : null;
    const returnColumns = developmentReturnColumns(registration, returnStorage);
    this.db
      .transaction(() => {
        this.preparePrivateReturnInsert(registration, predecessorSupersession);
        this.db
          .prepare(
            `INSERT INTO dynamic_task_defs (id, template_id, trigger_json, params_json, entrusted_work_reevaluation_json, display_json, delivery_thread_id, enabled, created_by, created_at, owner_auth_provenance, development_return_json, reviewed_development_return_json, successor_development_return_json, parent_bound_development_return_json, tool_execution_policy_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            def.id,
            def.templateId,
            JSON.stringify(def.trigger),
            JSON.stringify(def.params),
            def.entrustedWorkReevaluation ? JSON.stringify(def.entrustedWorkReevaluation) : null,
            JSON.stringify(def.display),
            def.deliveryThreadId,
            def.enabled && returnStorage === 'direct' ? 1 : 0,
            def.createdBy,
            def.createdAt,
            ownerAuthProvenance,
            returnColumns.direct,
            returnColumns.reviewed,
            returnColumns.successor,
            returnColumns.parentBound,
            toolPolicy,
          );
      })
      .immediate();
  }

  private preparePrivateReturnInsert(
    registration: DevelopmentReturnRegistrationV1 | null,
    predecessorSupersession: DevelopmentReturnRegistrationV1 | undefined,
  ): void {
    if (!registration) return;
    if (predecessorSupersession) {
      const currentPredecessor = this.getPrivateExecutionReturn(predecessorSupersession.registrationId);
      if (JSON.stringify(currentPredecessor) !== JSON.stringify(predecessorSupersession)) {
        throw new Error('Active return predecessor changed before supersession');
      }
    }
    assertDevelopmentReturnChain(
      registration,
      this.findPrivateExecutionReturns(registration.ownerThreadId),
      predecessorSupersession?.registrationId,
    );
    if (
      predecessorSupersession &&
      !this.replacePrivateExecutionReturn(predecessorSupersession.registrationId, predecessorSupersession, {
        ...predecessorSupersession,
        status: 'retired',
        ...this.supersededRetirementReason(predecessorSupersession.registrationId),
      })
    ) {
      throw new Error('Active return predecessor changed before supersession');
    }
  }

  /**
   * V46 can still decode the original direct column but predates the
   * `superseded` reason. Its successor edge is the audit proof, so keep that
   * legacy tombstone reasonless; fenced columns retain the explicit reason.
   */
  private supersededRetirementReason(id: string): { reason?: 'superseded' } {
    const row = this.db
      .prepare('SELECT development_return_json IS NOT NULL AS direct FROM dynamic_task_defs WHERE id = ?')
      .get(id) as { direct: number } | undefined;
    return row?.direct === 1 ? {} : { reason: 'superseded' };
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

  /** Select before decoding historical payloads; private return projections remain authoritative. */
  getEnabled(): DynamicTaskDef[] {
    const rows = this.db
      .prepare(`SELECT * FROM dynamic_task_defs
        WHERE enabled = 1 OR reviewed_development_return_json IS NOT NULL
          OR successor_development_return_json IS NOT NULL OR parent_bound_development_return_json IS NOT NULL
        ORDER BY created_at DESC`)
      .all() as RawRow[];
    return rows.map(todef).filter((def) => def.enabled);
  }

  getByTemplateId(templateId: string): DynamicTaskDef[] {
    const rows = this.db
      .prepare('SELECT * FROM dynamic_task_defs WHERE template_id = ? ORDER BY created_at DESC')
      .all(templateId) as RawRow[];
    return rows.map(todef);
  }

  findByDeliveryThread(threadId: string): DynamicTaskDef[] {
    const rows = this.db
      .prepare('SELECT * FROM dynamic_task_defs WHERE delivery_thread_id = ? ORDER BY created_at DESC')
      .all(threadId) as RawRow[];
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

  getPrivateOwnerAuthorization(id: string): DynamicTaskOwnerAuthorization {
    const row = this.db
      .prepare('SELECT owner_auth_provenance, tool_execution_policy_json FROM dynamic_task_defs WHERE id = ?')
      .get(id) as { owner_auth_provenance: unknown; tool_execution_policy_json: string | null } | undefined;
    const ownerAuthProvenance = normalizeOwnerAuthProvenance(row?.owner_auth_provenance);
    if (row?.tool_execution_policy_json === 'null') return { ownerAuthProvenance };
    return {
      ownerAuthProvenance,
      // Legacy registration has no proof of unrestricted tools. Preserve its grade,
      // but do not manufacture authority from a message, a cat id, or current settings.
      toolExecutionPolicy: row?.tool_execution_policy_json
        ? parseToolExecutionPolicy(row.tool_execution_policy_json)
        : { mode: 'read_only', replayDeniedToolNames: [] },
    };
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
      .prepare(`SELECT COALESCE(parent_bound_development_return_json, successor_development_return_json,
        reviewed_development_return_json, development_return_json)
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
          development_return_json = CASE
            WHEN reviewed_development_return_json IS NULL AND successor_development_return_json IS NULL
              AND parent_bound_development_return_json IS NULL
            THEN ? ELSE NULL END,
          reviewed_development_return_json = CASE WHEN reviewed_development_return_json IS NOT NULL THEN ? ELSE NULL END,
          successor_development_return_json = CASE
            WHEN successor_development_return_json IS NOT NULL THEN ? ELSE NULL END,
          parent_bound_development_return_json = CASE
            WHEN parent_bound_development_return_json IS NOT NULL THEN ? ELSE NULL END,
          enabled = CASE
            WHEN reviewed_development_return_json IS NOT NULL OR successor_development_return_json IS NOT NULL
              OR parent_bound_development_return_json IS NOT NULL
            THEN 0 ELSE ? END
      WHERE id = ? AND COALESCE(parent_bound_development_return_json, successor_development_return_json,
        reviewed_development_return_json, development_return_json) = ?`)
        .run(
          JSON.stringify(parsed),
          JSON.stringify(parsed),
          JSON.stringify(parsed),
          JSON.stringify(parsed),
          enabled,
          id,
          JSON.stringify(parsedCurrent),
        ).changes > 0
    );
  }

  findPrivateExecutionReturns(executionThreadId: string): DevelopmentReturnRegistrationV1[] {
    const rows = this.db
      .prepare(`SELECT id FROM dynamic_task_defs WHERE template_id = ?
      AND (json_extract(COALESCE(parent_bound_development_return_json, successor_development_return_json,
          reviewed_development_return_json, development_return_json), '$.executionThreadId') = ?
        OR json_extract(COALESCE(parent_bound_development_return_json, successor_development_return_json,
          reviewed_development_return_json, development_return_json), '$.ownerThreadId') = ?)`)
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
  successor_development_return_json: string | null;
  parent_bound_development_return_json: string | null;
}

function todef(row: RawRow): DynamicTaskDef {
  const params = JSON.parse(row.params_json) as Record<string, unknown>;
  const fencedReturn =
    row.parent_bound_development_return_json ??
    row.successor_development_return_json ??
    row.reviewed_development_return_json;
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
    enabled: fencedReturn
      ? !['delivered', 'retired'].includes(developmentReturnRegistrationV1Schema.parse(JSON.parse(fencedReturn)).status)
      : row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
