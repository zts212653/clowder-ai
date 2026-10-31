import type Database from 'better-sqlite3';

type TaskOutcomeDatabase = InstanceType<typeof Database>;

/** F275: preserve legacy PR evidence as an explicit attribution coverage defect. */
function addEpisodeAttribution(db: TaskOutcomeDatabase): void {
  const columns = db.pragma('table_info(task_outcome_episodes)') as Array<{ name: string }>;
  const addingAttribution = !columns.some((column) => column.name === 'attribution');
  db.transaction(() => {
    if (addingAttribution) {
      db.exec(
        "ALTER TABLE task_outcome_episodes ADD COLUMN attribution TEXT NOT NULL DEFAULT 'unmanaged_not_applicable'",
      );
    }
    if (!columns.some((column) => column.name === 'workId')) {
      db.exec('ALTER TABLE task_outcome_episodes ADD COLUMN workId TEXT');
    }
    if (!columns.some((column) => column.name === 'attemptId')) {
      db.exec('ALTER TABLE task_outcome_episodes ADD COLUMN attemptId TEXT');
    }
    if (addingAttribution) {
      db.exec(`
        UPDATE task_outcome_episodes
        SET attribution = 'managed_unattributed'
        WHERE attribution = 'unmanaged_not_applicable'
          AND EXISTS (
            SELECT 1 FROM task_outcome_signals
            WHERE task_outcome_signals.episodeId = task_outcome_episodes.episodeId
              AND task_outcome_signals.category = 'a1'
              AND json_valid(task_outcome_signals.record)
              AND json_extract(task_outcome_signals.record, '$.type') IN ('merge', 'revert')
          )
      `);
    }
  })();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_episodes_managed_binding
      ON task_outcome_episodes(workId, attemptId, terminalState)
      WHERE attribution = 'managed_attributed';
    CREATE INDEX IF NOT EXISTS idx_episodes_thread_attribution
      ON task_outcome_episodes(threadId, attribution, terminalState);
  `);
}

/** Add signal idempotency and backfill pre-existing magic_word_ref events. */
function addSignalIdempotency(db: TaskOutcomeDatabase): void {
  const columns = db.pragma('table_info(task_outcome_signals)') as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'idempotencyKey')) {
    db.exec('ALTER TABLE task_outcome_signals ADD COLUMN idempotencyKey TEXT');
  }
  db.exec(`
    UPDATE OR IGNORE task_outcome_signals
    SET idempotencyKey = 'mwr:' || json_extract(record, '$.eventId')
    WHERE id IN (
      SELECT MIN(id) FROM task_outcome_signals
      WHERE idempotencyKey IS NULL
        AND json_extract(record, '$.type') = 'magic_word_ref'
        AND json_extract(record, '$.eventId') IS NOT NULL
      GROUP BY episodeId, json_extract(record, '$.eventId')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_idempotency
      ON task_outcome_signals(episodeId, idempotencyKey)
      WHERE idempotencyKey IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_signals_idempotency_key_only
      ON task_outcome_signals(idempotencyKey)
      WHERE idempotencyKey IS NOT NULL;
  `);
}

export function migrateTaskOutcomeStore(db: TaskOutcomeDatabase): void {
  addEpisodeAttribution(db);
  addSignalIdempotency(db);
}
