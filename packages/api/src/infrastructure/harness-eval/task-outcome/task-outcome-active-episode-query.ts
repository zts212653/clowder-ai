import type Database from 'better-sqlite3';
import type { EpisodeAttributionLookup } from './task-outcome-attribution-store.js';

type TaskOutcomeDatabase = InstanceType<typeof Database>;

/** Resolve an active episode only from the complete coordinate for its attribution class. */
export function findActiveEpisodeRow(
  db: TaskOutcomeDatabase,
  input: EpisodeAttributionLookup,
): Record<string, unknown> | undefined {
  if (input.attribution === 'managed_attributed') {
    return db
      .prepare(
        `SELECT * FROM task_outcome_episodes
         WHERE attribution = 'managed_attributed'
           AND workId = ? AND attemptId = ? AND terminalState = 'in_progress'
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(input.workId, input.attemptId) as Record<string, unknown> | undefined;
  }
  if (input.attribution === 'managed_unattributed') {
    return db
      .prepare(
        `SELECT * FROM task_outcome_episodes
         WHERE attribution = 'managed_unattributed'
           AND terminalState = 'in_progress'
           AND EXISTS (
             SELECT 1 FROM json_each(task_outcome_episodes.artifacts)
             WHERE json_each.value = ?
           )
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(input.artifactRef) as Record<string, unknown> | undefined;
  }
  return db
    .prepare(
      `SELECT * FROM task_outcome_episodes
       WHERE threadId = ? AND attribution = 'unmanaged_not_applicable'
         AND terminalState = 'in_progress'
       ORDER BY createdAt DESC LIMIT 1`,
    )
    .get(input.threadId) as Record<string, unknown> | undefined;
}
