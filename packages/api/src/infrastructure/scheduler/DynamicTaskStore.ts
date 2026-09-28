import { type ProducerAttentionReevaluationLinkV1, producerAttentionReevaluationLinkV1Schema } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import {
  normalizeOwnerAuthProvenance,
  type OwnerAuthProvenance,
  requireOwnerAuthProvenance,
} from '../../domains/cats/services/owner-auth-provenance.js';
import type { TaskDisplayMeta, TriggerSpec } from './types.js';

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

  insert(def: DynamicTaskDef, privateOwnerAuthProvenance?: OwnerAuthProvenance): void {
    const ownerAuthProvenance =
      privateOwnerAuthProvenance === undefined ? null : requireOwnerAuthProvenance(privateOwnerAuthProvenance);
    this.db
      .prepare(
        `INSERT INTO dynamic_task_defs (id, template_id, trigger_json, params_json, entrusted_work_reevaluation_json, display_json, delivery_thread_id, enabled, created_by, created_at, owner_auth_provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ownerAuthProvenance,
      );
  }

  /**
   * Replace the executable projection for a stable dynamic definition id.
   * Creation provenance stays attached to the identity while mutable execution
   * fields are updated atomically.
   */
  upsert(def: DynamicTaskDef): void {
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
    const result = this.db.prepare('DELETE FROM dynamic_task_defs WHERE id = ?').run(id);
    return result.changes > 0;
  }

  setEnabled(id: string, enabled: boolean): boolean {
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
    const result = this.db
      .prepare('UPDATE dynamic_task_defs SET params_json = ? WHERE id = ? AND params_json = ?')
      .run(JSON.stringify(next), id, JSON.stringify(current));
    return result.changes > 0;
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
}

function todef(row: RawRow): DynamicTaskDef {
  return {
    id: row.id,
    templateId: row.template_id,
    trigger: JSON.parse(row.trigger_json),
    params: JSON.parse(row.params_json),
    ...(row.entrusted_work_reevaluation_json
      ? {
          entrustedWorkReevaluation: producerAttentionReevaluationLinkV1Schema.parse(
            JSON.parse(row.entrusted_work_reevaluation_json),
          ),
        }
      : {}),
    display: JSON.parse(row.display_json),
    deliveryThreadId: row.delivery_thread_id,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
