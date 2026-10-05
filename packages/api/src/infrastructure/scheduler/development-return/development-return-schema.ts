import type Database from 'better-sqlite3';

/** Private continuation lives on the existing execution row, outside every public params projection. */
export function addDevelopmentReturnColumn(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(dynamic_task_defs)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'development_return_json')) {
    db.exec(
      'ALTER TABLE dynamic_task_defs ADD COLUMN development_return_json TEXT CHECK (development_return_json IS NULL OR json_valid(development_return_json))',
    );
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS development_return_no_delete
    BEFORE DELETE ON dynamic_task_defs WHEN OLD.development_return_json IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'private return history must be retained'); END;
    CREATE TRIGGER IF NOT EXISTS development_return_identity
    BEFORE UPDATE ON dynamic_task_defs WHEN OLD.development_return_json IS NOT NULL AND (
      NEW.development_return_json IS NULL OR NEW.id IS NOT OLD.id OR NEW.template_id IS NOT OLD.template_id
      OR NEW.delivery_thread_id IS NOT OLD.delivery_thread_id OR NEW.created_by IS NOT OLD.created_by
      OR NEW.created_at IS NOT OLD.created_at OR NEW.owner_auth_provenance IS NOT OLD.owner_auth_provenance)
    BEGIN SELECT RAISE(ABORT, 'private return identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS development_return_active_enabled
    BEFORE UPDATE ON dynamic_task_defs WHEN NEW.development_return_json IS NOT NULL
      AND json_extract(NEW.development_return_json, '$.status') NOT IN ('delivered', 'retired')
      AND NEW.enabled != 1
    BEGIN SELECT RAISE(ABORT, 'private return must retire through its owner transition'); END;
    CREATE TRIGGER IF NOT EXISTS development_return_terminal
    BEFORE UPDATE ON dynamic_task_defs WHEN OLD.development_return_json IS NOT NULL
      AND json_extract(OLD.development_return_json, '$.status') IN ('delivered', 'retired')
      AND (NEW.enabled != 0 OR NEW.development_return_json IS NOT OLD.development_return_json)
    BEGIN SELECT RAISE(ABORT, 'private return terminal state cannot be reopened'); END;
  `);
}
