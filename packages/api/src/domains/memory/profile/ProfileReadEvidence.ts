import { createHash } from 'node:crypto';
import type { CallbackPrincipal } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';

export class ProfileReadConflict extends Error {}

/** Success is committed before returning profile bytes. Retries keep the original observation. */
export function recordProfileRead(
  db: Database.Database,
  input: {
    principal: CallbackPrincipal;
    requestId: string;
    memoryId: string;
    revision: string;
  },
) {
  const { principal, requestId, memoryId, revision } = input;
  const eventId = `profile-read-${createHash('sha256')
    .update(JSON.stringify([principal.userId, principal.catId, requestId]))
    .digest('hex')}`;
  return db
    .transaction(() => {
      const prior = db
        .prepare('SELECT memory_id, source_revision FROM profile_read_events WHERE event_id = ?')
        .get(eventId) as { memory_id: string; source_revision: string } | undefined;
      if (prior) {
        if (prior.memory_id !== memoryId || prior.source_revision !== revision)
          throw new ProfileReadConflict('profile_read_request_changed');
        return eventId;
      }
      db.prepare(`INSERT INTO profile_read_events
      (event_id, owner_user_id, consumer_cat_id, memory_id, source_revision, principal_kind, thread_id, invocation_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        eventId,
        principal.userId,
        principal.catId,
        memoryId,
        revision,
        principal.kind,
        principal.kind === 'invocation' ? principal.threadId : null,
        principal.kind === 'invocation' ? (principal.parentInvocationId ?? principal.invocationId) : null,
        Date.now(),
      );
      return eventId;
    })
    .immediate();
}
