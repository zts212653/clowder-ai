import type Database from 'better-sqlite3';
import { MANAGED_COMMAND_CANDIDATE_FILTER } from '../managed-command-candidate-schema.js';

export const MANAGED_COMMAND_RECOVERY_DUE = "json_extract(managed_command_recovery_json,'$.nextAttemptAt')";
export const MANAGED_COMMAND_CONSUMPTION_FILTER = `json_extract(managed_command_recovery_json,'$.consumption.sourceMessageId') IS NOT NULL
  AND (${MANAGED_COMMAND_RECOVERY_DUE} IS NOT NULL OR json_extract(managed_command_recovery_json,'$.disposition') IS NOT NULL)`;
export const MANAGED_COMMAND_RECOVERY_INDEX = `CREATE INDEX IF NOT EXISTS idx_dynamic_managed_recovery_due
  ON dynamic_task_defs(${MANAGED_COMMAND_RECOVERY_DUE},id) WHERE ${MANAGED_COMMAND_RECOVERY_DUE} IS NOT NULL`;

function consumptionSql(prefix: string, base: string): string {
  const params = `${prefix}params_json`;
  const withGeneration = `json_set(${base},'$.waitGeneration',COALESCE(json_extract(${params},'$.holdLifecycle.await.generation'),0))`;
  return `CASE WHEN json_extract(${params},'$.holdLifecycle.managedCommand.messageId') IS NULL
    THEN json_remove(${withGeneration},'$.consumption') ELSE json_set(${withGeneration},'$.consumption',json_object(
      'ownerTaskId',${prefix}id,'userId',json_extract(${params},'$.triggerUserId'),
      'threadId',${prefix}delivery_thread_id,'catId',substr(${prefix}created_by,11),
      'sourceMessageId',json_extract(${params},'$.holdLifecycle.managedCommand.messageId'),
      'generation',COALESCE(json_extract(${params},'$.holdLifecycle.await.generation'),0))) END`;
}

const initial = "json_object('v',1,'attempts',0,'nextAttemptAt',0)";
const significantPaths = [
  '$.holdLifecycle.status',
  '$.holdLifecycle.await.generation',
  '$.holdLifecycle.managedCommand.state',
  '$.holdLifecycle.managedCommand.result',
  '$.holdLifecycle.managedCommand.messageId',
];

/** Private facts live on the existing wait row; source association is committed in the same business CAS. */
export function installManagedCommandRecoverySchema(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dynamic_task_defs)').all() as { name: string }[]).map(({ name }) => name),
  );
  if (!columns.has('managed_command_recovery_json'))
    db.exec('ALTER TABLE dynamic_task_defs ADD COLUMN managed_command_recovery_json TEXT');
  if (!columns.has('managed_command_recovery_revision'))
    db.exec('ALTER TABLE dynamic_task_defs ADD COLUMN managed_command_recovery_revision INTEGER NOT NULL DEFAULT 0');
  db.exec(`UPDATE dynamic_task_defs SET managed_command_recovery_json=${consumptionSql('', initial)}
    WHERE managed_command_recovery_json IS NULL AND ${MANAGED_COMMAND_CANDIDATE_FILTER}`);
  db.exec(MANAGED_COMMAND_RECOVERY_INDEX);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dynamic_managed_consumption_source ON dynamic_task_defs
    (json_extract(managed_command_recovery_json,'$.consumption.sourceMessageId'))
    WHERE ${MANAGED_COMMAND_CONSUMPTION_FILTER}`);
  const candidate = MANAGED_COMMAND_CANDIDATE_FILTER.replace(/\b(template_id|params_json|enabled)\b/g, 'NEW.$1');
  const changed = significantPaths
    .map((path) => `json_extract(OLD.params_json,'${path}') IS NOT json_extract(NEW.params_json,'${path}')`)
    .join(' OR ');
  const reset = `json_set(json_remove(COALESCE(NEW.managed_command_recovery_json,${initial}),
    '$.disposition','$.reasonCode','$.claim'),'$.attempts',0,'$.nextAttemptAt',0)`;
  const base = `CASE WHEN json_extract(OLD.params_json,'$.holdLifecycle.await.generation') IS NOT
    json_extract(NEW.params_json,'$.holdLifecycle.await.generation') THEN json_remove(${reset},'$.notification')
    ELSE ${reset} END`;
  const associated = `CASE WHEN json_extract(OLD.params_json,'$.holdLifecycle.await.generation') IS NOT
    json_extract(NEW.params_json,'$.holdLifecycle.await.generation') AND
    json_extract(OLD.params_json,'$.holdLifecycle.managedCommand.messageId') IS
    json_extract(NEW.params_json,'$.holdLifecycle.managedCommand.messageId')
    THEN json_set(json_remove(${base},'$.consumption'),'$.waitGeneration',
      COALESCE(json_extract(NEW.params_json,'$.holdLifecycle.await.generation'),0))
    ELSE ${consumptionSql('NEW.', base)} END`;
  const next = `CASE WHEN json_extract(NEW.params_json,'$.holdLifecycle.managedCommand.state') IN ('consumed','cancelled')
    AND (json_extract(NEW.managed_command_recovery_json,'$.notification.key') IS NULL OR
      json_extract(NEW.managed_command_recovery_json,'$.notification.deliveredAt') IS NOT NULL OR
      json_extract(NEW.managed_command_recovery_json,'$.notification.attempts')>=5)
    THEN json_set(${associated},'$.nextAttemptAt',NULL) ELSE ${associated} END`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS dynamic_managed_recovery_insert AFTER INSERT ON dynamic_task_defs
    WHEN ${candidate} BEGIN UPDATE dynamic_task_defs SET managed_command_recovery_json=${consumptionSql('NEW.', initial)}
      WHERE id=NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS dynamic_managed_recovery_update AFTER UPDATE OF params_json,enabled ON dynamic_task_defs
    WHEN (OLD.managed_command_recovery_json IS NOT NULL OR (${candidate})) AND
      (OLD.enabled IS NOT NEW.enabled OR ${changed})
    BEGIN UPDATE dynamic_task_defs SET managed_command_recovery_json=${next},
      managed_command_recovery_revision=managed_command_recovery_revision+1 WHERE id=NEW.id; END;`);
}
