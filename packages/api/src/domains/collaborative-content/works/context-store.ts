import {
  type SetWorkContext,
  type WorkContextRecord,
  type WorkReference,
  workContextRecordSchema,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { WorkPrincipal } from './service.js';

export class WorkContextConflictError extends Error {}

/** Append-only version metadata in F309. No content bytes, work head, or expiry. */
export class WorkContextStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_version_contexts (
      owner_user_id TEXT NOT NULL, content_ref TEXT NOT NULL, owner_revision INTEGER NOT NULL,
      metadata_revision INTEGER NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(owner_user_id,content_ref,owner_revision,metadata_revision),
      UNIQUE(owner_user_id,content_ref,owner_revision,operation_id)
    )`);
  }

  get(owner: string, ref: WorkReference, revision?: number): WorkContextRecord | null {
    const row =
      revision === undefined
        ? this.db
            .prepare(`SELECT body FROM work_version_contexts WHERE owner_user_id=? AND content_ref=?
          AND owner_revision=? ORDER BY metadata_revision DESC LIMIT 1`)
            .get(owner, ref.contentRef, ref.ownerRevision)
        : this.db
            .prepare(`SELECT body FROM work_version_contexts WHERE owner_user_id=? AND content_ref=?
          AND owner_revision=? AND metadata_revision=?`)
            .get(owner, ref.contentRef, ref.ownerRevision, revision);
    return row ? workContextRecordSchema.parse(JSON.parse((row as { body: string }).body)) : null;
  }

  replay(owner: string, ref: WorkReference, operationId: string) {
    const row = this.db
      .prepare(`SELECT body FROM work_version_contexts WHERE owner_user_id=? AND content_ref=?
      AND owner_revision=? AND operation_id=?`)
      .get(owner, ref.contentRef, ref.ownerRevision, operationId) as { body: string } | undefined;
    return row ? workContextRecordSchema.parse(JSON.parse(row.body)) : null;
  }

  save(command: SetWorkContext, principal: WorkPrincipal, requestDigest: string): WorkContextRecord {
    return this.db
      .transaction(() => {
        const previous = this.replay(principal.userId, command.reference, command.operationId);
        if (previous) {
          if (
            previous.requestDigest !== requestDigest ||
            previous.actor.kind !== principal.actor.kind ||
            previous.actor.actorId !== principal.actor.actorId
          )
            throw new WorkContextConflictError('Context idempotency conflict');
          return previous;
        }
        const current = this.get(principal.userId, command.reference);
        if ((current?.metadataRevision ?? 0) !== command.expectedMetadataRevision)
          throw new WorkContextConflictError('Context revision conflict');
        const record = workContextRecordSchema.parse({
          reference: command.reference,
          metadataRevision: command.expectedMetadataRevision + 1,
          ownerUserId: principal.userId,
          operationId: command.operationId,
          requestDigest,
          actor: principal.actor,
          recordedAt: new Date().toISOString(),
          context: command.context,
        });
        this.db
          .prepare('INSERT INTO work_version_contexts VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            principal.userId,
            record.reference.contentRef,
            record.reference.ownerRevision,
            record.metadataRevision,
            record.operationId,
            JSON.stringify(record),
          );
        return record;
      })
      .immediate();
  }
}
