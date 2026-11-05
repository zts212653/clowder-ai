import {
  type SetWorkContext,
  type VideoProjectAssetVersion,
  type WorkContextRecord,
  type WorkReference,
  workContextRecordSchema,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { WorkPrincipal } from './service.js';

export class WorkContextConflictError extends Error {}

export const workContextCacheKey = (owner: string, ref: WorkReference, revision: number) =>
  JSON.stringify([owner, ref.contentRef, ref.ownerRevision, revision]);

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

  usagePage(owner: string, after: number, limit: number): WorkContextRecord[] {
    return (
      this.db
        .prepare(`SELECT c.body FROM work_version_contexts c WHERE c.owner_user_id=? AND NOT EXISTS (
      SELECT 1 FROM work_version_contexts n WHERE n.owner_user_id=c.owner_user_id AND n.content_ref=c.content_ref
      AND n.owner_revision=c.owner_revision AND n.metadata_revision>c.metadata_revision)
      ORDER BY c.content_ref,c.owner_revision LIMIT ? OFFSET ?`)
        .all(owner, limit, after) as { body: string }[]
    ).map((row) => workContextRecordSchema.parse(JSON.parse(row.body)));
  }

  workTitle(owner: string, ref: WorkReference): string {
    const row = this.db
      .prepare('SELECT body FROM work_version_annotations WHERE owner_user_id=? AND content_ref=? AND owner_revision=?')
      .get(owner, ref.contentRef, ref.ownerRevision) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as { title: string }).title : ref.contentRef;
  }

  assetOrigin(
    owner: string,
    version: VideoProjectAssetVersion,
    records?: Map<string, WorkContextRecord>,
  ): { metadata: WorkContextRecord; index: number } | null {
    const row = this.db
      .prepare(`SELECT c.content_ref AS contentRef,c.owner_revision AS ownerRevision,
      c.metadata_revision AS metadataRevision,CAST(a.key AS INTEGER) AS assetIndex FROM work_version_contexts c,
      json_each(c.body,'$.context.assets') a, json_each(a.value,'$.asset.versions') v
      WHERE c.owner_user_id=? AND json_extract(v.value,'$.id')=json_extract(a.value,'$.versionId')
      AND json_extract(v.value,'$.locator.rootId')=? AND json_extract(v.value,'$.locator.path')=?
      AND json_extract(v.value,'$.sha256')=? ORDER BY c.rowid LIMIT 1`)
      .get(owner, version.locator.rootId, version.locator.path, version.sha256) as
      | (WorkReference & { metadataRevision: number; assetIndex: number })
      | undefined;
    if (!row) return null;
    const key = workContextCacheKey(owner, row, row.metadataRevision);
    const metadata = records?.get(key) ?? this.get(owner, row, row.metadataRevision);
    if (!metadata) return null;
    records?.set(key, metadata);
    return { metadata, index: row.assetIndex };
  }

  save(
    command: SetWorkContext,
    principal: WorkPrincipal,
    requestDigest: string,
    assertSelections?: () => void,
  ): WorkContextRecord {
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
        assertSelections?.();
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
