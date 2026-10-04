import type Database from 'better-sqlite3';
import type { MentionProjectionResult } from './memory-process-protocol.js';

export class EntityMentionProjectionConflictError extends Error {
  readonly code = 'MEMORY_PROJECTION_CONFLICT';
  readonly retryable = true;
}

/** Called after BEGIN IMMEDIATE. Each entity projection covers every document,
 * and each document projection covers every entity: both head dimensions matter.
 * Reject the entire stale publication before applying any canonical mutation. */
export function assertCurrentMentionGeneration(
  db: Database.Database,
  projection: MentionProjectionResult,
  generation: number,
): void {
  const entityScope = projection.entityIds !== undefined;
  const heads = entityScope ? 'entity_mention_entity_heads' : 'entity_mention_doc_heads';
  const oppositeHeads = entityScope ? 'entity_mention_doc_heads' : 'entity_mention_entity_heads';
  const key = entityScope ? 'entity_id' : 'doc_anchor';
  const scope = projection.entityIds ?? projection.docAnchors ?? [];
  if (scope.length === 0) return;
  const newerSameScope = db
    .prepare(`SELECT 1 FROM ${heads} WHERE ${key} IN (SELECT value FROM json_each(?)) AND generation > ? LIMIT 1`)
    .get(JSON.stringify(scope), generation);
  const newerIntersectingScope = db
    .prepare(`SELECT 1 FROM ${oppositeHeads} WHERE generation > ? LIMIT 1`)
    .get(generation);
  if (newerSameScope || newerIntersectingScope) {
    throw new EntityMentionProjectionConflictError(
      'Entity mention projection was superseded; retry against current truth',
    );
  }
}
