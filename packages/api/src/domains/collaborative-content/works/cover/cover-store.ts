import { isDeepStrictEqual } from 'node:util';
import {
  type WorkCoverBasis,
  type WorkCoverImage,
  type WorkCoverRecord,
  type WorkReference,
  workCoverImageSchema,
  workCoverRecordSchema,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { WorkPrincipal } from '../types.js';

export class WorkCoverConflictError extends Error {}

/** What a submit decided for its new version, frozen before the owner effect so a replay never re-reads today. */
export interface FrozenSubmitCover {
  readonly contentRef: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly image: WorkCoverImage | null;
  readonly basis: WorkCoverBasis;
  /** Persist even without a picture: an explicit video frame or an inherited clearing is a choice. */
  readonly record: boolean;
}

/**
 * The adopted cover of one fixed video version, in the original F309 database. Append-only with its
 * own revision and operation identity: video context writes cannot erase it and it owns no work head.
 */
export class WorkCoverStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_version_covers (
      owner_user_id TEXT NOT NULL, content_ref TEXT NOT NULL, owner_revision INTEGER NOT NULL,
      cover_revision INTEGER NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(owner_user_id,content_ref,owner_revision,cover_revision),
      UNIQUE(owner_user_id,content_ref,owner_revision,operation_id)
    );
    CREATE TABLE IF NOT EXISTS work_cover_submissions (
      owner_user_id TEXT NOT NULL, content_ref TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(owner_user_id,content_ref,operation_id)
    )`);
  }

  get(owner: string, ref: WorkReference, coverRevision?: number): WorkCoverRecord | null {
    const row =
      coverRevision === undefined
        ? this.db
            .prepare(`SELECT body FROM work_version_covers WHERE owner_user_id=? AND content_ref=?
          AND owner_revision=? ORDER BY cover_revision DESC LIMIT 1`)
            .get(owner, ref.contentRef, ref.ownerRevision)
        : this.db
            .prepare(`SELECT body FROM work_version_covers WHERE owner_user_id=? AND content_ref=?
          AND owner_revision=? AND cover_revision=?`)
            .get(owner, ref.contentRef, ref.ownerRevision, coverRevision);
    return row ? workCoverRecordSchema.parse(JSON.parse((row as { body: string }).body)) : null;
  }

  replay(owner: string, ref: WorkReference, operationId: string): WorkCoverRecord | null {
    const row = this.db
      .prepare(`SELECT body FROM work_version_covers WHERE owner_user_id=? AND content_ref=?
      AND owner_revision=? AND operation_id=?`)
      .get(owner, ref.contentRef, ref.ownerRevision, operationId) as { body: string } | undefined;
    return row ? workCoverRecordSchema.parse(JSON.parse(row.body)) : null;
  }

  /** Recent adopted pictures across this work's versions, newest first and bounded. */
  pictures(owner: string, contentRef: string, limit: number): WorkCoverRecord[] {
    return (
      this.db
        .prepare(`SELECT body FROM work_version_covers WHERE owner_user_id=? AND content_ref=?
      AND json_extract(body,'$.image') IS NOT NULL ORDER BY rowid DESC LIMIT ?`)
        .all(owner, contentRef, limit) as { body: string }[]
    ).map((row) => workCoverRecordSchema.parse(JSON.parse(row.body)));
  }

  /** Append the next revision under CAS; an identical retry returns its original receipt. */
  save(input: {
    principal: WorkPrincipal;
    reference: WorkReference;
    operationId: string;
    requestDigest: string;
    expectedCoverRevision: number;
    image: WorkCoverImage | null;
    basis: WorkCoverBasis;
    beforeWrite?: () => void;
  }): WorkCoverRecord {
    const { principal, reference } = input;
    return this.db
      .transaction(() => {
        const previous = this.replay(principal.userId, reference, input.operationId);
        if (previous) {
          if (
            previous.requestDigest !== input.requestDigest ||
            previous.actor.kind !== principal.actor.kind ||
            previous.actor.actorId !== principal.actor.actorId
          )
            throw new WorkCoverConflictError('Cover idempotency conflict');
          return previous;
        }
        const current = this.get(principal.userId, reference);
        if ((current?.coverRevision ?? 0) !== input.expectedCoverRevision)
          throw new WorkCoverConflictError('Cover revision conflict');
        input.beforeWrite?.();
        return this.insert({
          reference,
          coverRevision: input.expectedCoverRevision + 1,
          ownerUserId: principal.userId,
          operationId: input.operationId,
          requestDigest: input.requestDigest,
          actor: principal.actor,
          recordedAt: new Date().toISOString(),
          image: input.image,
          basis: input.basis,
        });
      })
      .immediate();
  }

  /** Freeze a submit's decision once per operation; a retry gets the first decision back unchanged. */
  freezeSubmission(owner: string, frozen: FrozenSubmitCover, decide: () => FrozenSubmitCover): FrozenSubmitCover {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare('SELECT body FROM work_cover_submissions WHERE owner_user_id=? AND content_ref=? AND operation_id=?')
          .get(owner, frozen.contentRef, frozen.operationId) as { body: string } | undefined;
        if (row) {
          const kept = parseFrozen(row.body);
          if (kept.requestDigest !== frozen.requestDigest)
            throw new WorkCoverConflictError('Cover idempotency conflict');
          return kept;
        }
        const decided = decide();
        this.db
          .prepare('INSERT INTO work_cover_submissions VALUES (?, ?, ?, ?)')
          .run(owner, decided.contentRef, decided.operationId, JSON.stringify(decided));
        return decided;
      })
      .immediate();
  }

  frozenSubmission(owner: string, contentRef: string, operationId: string): FrozenSubmitCover | null {
    const row = this.db
      .prepare('SELECT body FROM work_cover_submissions WHERE owner_user_id=? AND content_ref=? AND operation_id=?')
      .get(owner, contentRef, operationId) as { body: string } | undefined;
    return row ? parseFrozen(row.body) : null;
  }

  /** Write the new version's first cover revision from its frozen submit decision, idempotently. */
  projectSubmission(
    owner: string,
    reference: WorkReference,
    frozen: FrozenSubmitCover,
    actor: WorkPrincipal['actor'],
  ): WorkCoverRecord | null {
    if (!frozen.record) return null;
    const image = frozen.image;
    return this.db
      .transaction(() => {
        const previous = this.replay(owner, reference, frozen.operationId);
        if (previous) {
          if (
            previous.requestDigest !== frozen.requestDigest ||
            !isDeepStrictEqual(previous.image, image) ||
            !isDeepStrictEqual(previous.basis, frozen.basis)
          )
            throw new WorkCoverConflictError('Cover idempotency conflict');
          return previous;
        }
        // Someone already chose this new version's cover; the submit-time default never overwrites it.
        if (this.get(owner, reference)) return null;
        return this.insert({
          reference,
          coverRevision: 1,
          ownerUserId: owner,
          operationId: frozen.operationId,
          requestDigest: frozen.requestDigest,
          actor,
          recordedAt: new Date().toISOString(),
          image,
          basis: frozen.basis,
        });
      })
      .immediate();
  }

  private insert(input: WorkCoverRecord): WorkCoverRecord {
    const record = workCoverRecordSchema.parse(input);
    this.db
      .prepare('INSERT INTO work_version_covers VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        record.ownerUserId,
        record.reference.contentRef,
        record.reference.ownerRevision,
        record.coverRevision,
        record.operationId,
        JSON.stringify(record),
      );
    return record;
  }
}

function parseFrozen(body: string): FrozenSubmitCover {
  const value = JSON.parse(body) as FrozenSubmitCover;
  const image = value.image ? workCoverImageSchema.parse(value.image) : null;
  return { ...value, image, record: value.record ?? image !== null };
}
