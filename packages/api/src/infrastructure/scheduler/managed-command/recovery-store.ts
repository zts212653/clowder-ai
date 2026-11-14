import type Database from 'better-sqlite3';
import type {
  ManagedCommandWaitRecoveryFact,
  ManagedCommandWaitRecoverySnapshot,
} from '../../../domains/ball-custody/managed-command-wait-recovery-state.js';
import { MANAGED_COMMAND_CONSUMPTION_FILTER } from './recovery-schema.js';

export function readManagedCommandRecoveryState(
  db: Database.Database,
  id: string,
): ManagedCommandWaitRecoverySnapshot | null {
  const row = db
    .prepare(
      'SELECT managed_command_recovery_json AS fact,managed_command_recovery_revision AS revision FROM dynamic_task_defs WHERE id=?',
    )
    .get(id) as { fact: string | null; revision: number } | undefined;
  if (!row?.fact) return null;
  return { revision: row.revision, fact: JSON.parse(row.fact) as ManagedCommandWaitRecoveryFact };
}

export function writeManagedCommandRecoveryState(
  db: Database.Database,
  id: string,
  revision: number,
  fact: ManagedCommandWaitRecoveryFact,
): boolean {
  return (
    db
      .prepare(`UPDATE dynamic_task_defs SET managed_command_recovery_json=?,
    managed_command_recovery_revision=managed_command_recovery_revision+1 WHERE id=? AND managed_command_recovery_revision=?`)
      .run(JSON.stringify(fact), id, revision).changes === 1
  );
}

export function managedCommandWaitsForSource(db: Database.Database, messageId: string): string[] {
  return (
    db
      .prepare(`SELECT id FROM dynamic_task_defs
    WHERE ${MANAGED_COMMAND_CONSUMPTION_FILTER}
      AND json_extract(managed_command_recovery_json,'$.consumption.sourceMessageId')=? LIMIT 100`)
      .all(messageId) as { id: string }[]
  ).map(({ id }) => id);
}
