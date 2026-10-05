import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ContentModificationRecord,
  contentModificationOutcome,
  contentModificationRequestSchema,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ModificationCancellationStore, modificationCancellationSchema } from './control/cancellation-store.js';
import { ModificationRuntimeControlStore } from './control/runtime-control-store.js';
import { ContentModificationJournalError } from './journal-errors.js';

export { ContentModificationJournalError } from './journal-errors.js';

const id = z.string().min(1).max(256),
  revision = z.number().int().positive().safe();
const preparedSchema = z.union([
  z
    .object({
      kind: z.literal('media'),
      contentRef: id,
      ownerRevision: revision,
      ledgerRef: id.optional(),
      legacyReview: z.object({ reviewId: id, round: revision }).strict().optional(),
    })
    .strict()
    .refine(
      (value) => Boolean(value.ledgerRef) !== Boolean(value.legacyReview),
      'One canonical discussion owner is required',
    ),
  z
    .object({ kind: z.literal('text'), reviewId: id, sourceRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
    .strict(),
]);
const progressSchema = z
  .object({
    sourceMessageId: id.optional(),
    prepared: preparedSchema.optional(),
    task: z.object({ taskId: id, revision, receiptRef: id }).strict().optional(),
    review: z
      .object({ reviewId: id, round: revision.optional(), receiptRef: z.string().min(1).max(2048) })
      .strict()
      .optional(),
  })
  .strict();
export type ContentModificationProgress = z.infer<typeof progressSchema>;
export type { ContentModificationRecord } from '@cat-cafe/shared';

interface Row {
  body: string;
  lease_token: string | null;
  lease_until: number | null;
}

export function modificationRequestId(ownerUserId: string, operationId: string): string {
  return `f309-modification-${createHash('sha256')
    .update(JSON.stringify(['f309-modification-v1', ownerUserId, operationId]))
    .digest('hex')}`;
}
export function modificationOperationKeys(requestId: string) {
  if (!/^f309-modification-[a-f0-9]{64}$/.test(requestId))
    throw new ContentModificationJournalError('invalid_progress');
  const base = `f309-modification:${requestId.slice('f309-modification-'.length)}`;
  return { source: `${base}:source`, snapshot: `${base}:snapshot`, admit: `${base}:admit`, request: `${base}:request` };
}

/** Permanent confirmed intent and owner coordinates. Leases expire; user requests never do. */
export class ContentModificationJournal {
  readonly cancellations: ModificationCancellationStore;
  readonly runtimeControls: ModificationRuntimeControlStore;
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS content_modification_requests (
      request_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, revision INTEGER NOT NULL,
      body TEXT NOT NULL, lease_token TEXT, lease_until INTEGER
    ); CREATE INDEX IF NOT EXISTS content_modification_requests_owner ON content_modification_requests(owner_user_id);
    CREATE INDEX IF NOT EXISTS content_modification_requests_binding ON content_modification_requests(
      owner_user_id, json_extract(body,'$.progress.task.taskId'), json_extract(body,'$.progress.prepared.contentRef'));`);
    this.cancellations = new ModificationCancellationStore(db);
    this.runtimeControls = new ModificationRuntimeControlStore(db);
  }

  reserve(ownerUserId: string, raw: unknown, now = Date.now()): ContentModificationRecord {
    id.parse(ownerUserId);
    const payload = contentModificationRequestSchema.parse(raw);
    contentModificationOutcome(payload.intent);
    const requestId = modificationRequestId(ownerUserId, payload.operationId);
    return this.db
      .transaction(() => {
        const existing = this.get(requestId, ownerUserId);
        if (existing) {
          if (!isDeepStrictEqual(existing.payload, payload))
            throw new ContentModificationJournalError('operation_reused');
          return existing;
        }
        if (payload.taskContext) this.cancellations.assertTaskAvailable(ownerUserId, payload.taskContext.taskId);
        const record: ContentModificationRecord = {
          requestId,
          ownerUserId,
          payload,
          progress: {},
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare('INSERT INTO content_modification_requests(request_id,owner_user_id,revision,body) VALUES(?,?,?,?)')
          .run(requestId, ownerUserId, 1, JSON.stringify(record));
        return record;
      })
      .immediate();
  }

  /** Called inside the same DB transaction as a new human candidate decision. Fences delayed UI reads. */
  noteHumanDecision(requestId: string, ownerUserId: string) {
    const result = this.db
      .prepare(`UPDATE content_modification_requests SET revision=revision+1,
      body=json_set(body,'$.revision',revision+1,'$.updatedAt',?) WHERE request_id=? AND owner_user_id=?`)
      .run(Date.now(), requestId, ownerUserId);
    if (result.changes !== 1) throw new ContentModificationJournalError('not_found');
  }

  get(requestId: string, ownerUserId: string): ContentModificationRecord | null {
    const row = this.db
      .prepare('SELECT body FROM content_modification_requests WHERE request_id=? AND owner_user_id=?')
      .get(requestId, ownerUserId) as Row | undefined;
    return row ? this.parse(row.body) : null;
  }

  forSource(ownerUserId: string, source: ContentModificationRecord['payload']['source']): ContentModificationRecord[] {
    const rows =
      source.kind === 'publication'
        ? this.db
            .prepare(`SELECT body FROM content_modification_requests WHERE owner_user_id=? AND
        (json_extract(body,'$.payload.source.contentRef')=? OR json_extract(body,'$.progress.prepared.contentRef')=?)
        ORDER BY json_extract(body,'$.createdAt') DESC,request_id`)
            .all(ownerUserId, source.contentRef, source.contentRef)
        : source.kind === 'artifact-review'
          ? this.db
              .prepare(`SELECT body FROM content_modification_requests WHERE owner_user_id=? AND
          (json_extract(body,'$.payload.source.reviewId')=? OR json_extract(body,'$.progress.review.reviewId')=?)
          ORDER BY json_extract(body,'$.createdAt') DESC,request_id`)
              .all(ownerUserId, source.reviewId, source.reviewId)
          : source.kind === 'evolution'
            ? this.db
                .prepare(`SELECT body FROM content_modification_requests WHERE owner_user_id=? AND
          json_extract(body,'$.payload.source.kind')='evolution' AND json_extract(body,'$.payload.source.reviewId')=?
          ORDER BY json_extract(body,'$.createdAt') DESC,request_id`)
                .all(ownerUserId, source.reviewId)
            : this.db
                .prepare(`SELECT body FROM content_modification_requests WHERE owner_user_id=? AND
        json_extract(body,'$.payload.source.kind')='workspace' AND
        json_extract(body,'$.payload.source.locator.worktreeId')=? AND json_extract(body,'$.payload.source.locator.path')=?
        ORDER BY json_extract(body,'$.createdAt') DESC,request_id`)
                .all(ownerUserId, source.locator.worktreeId, source.locator.path);
    return (rows as Row[]).map((row) => this.parse(row.body));
  }

  /** Immutable human-request bindings, never the cat-writable Task artifact list. */
  publicationTaskBindings(ownerUserId: string, taskId: string, contentRef: string): ContentModificationRecord[] {
    const rows = this.db
      .prepare(`SELECT body FROM content_modification_requests
      WHERE owner_user_id=? AND json_extract(body,'$.progress.task.taskId')=?
      AND json_extract(body,'$.progress.prepared.kind')='media'
      AND json_extract(body,'$.progress.prepared.contentRef')=?
      AND json_extract(body,'$.progress.review') IS NOT NULL`)
      .all(ownerUserId, taskId, contentRef) as Row[];
    return rows.map((row) => this.parse(row.body));
  }

  pending(now = Date.now(), limit = 100): ContentModificationRecord[] {
    z.number().int().min(1).max(1000).parse(limit);
    const rows = this.db
      .prepare(`SELECT body FROM content_modification_requests
      WHERE json_extract(body,'$.control') IS NULL AND json_extract(body,'$.progress.review') IS NULL AND
      COALESCE(json_extract(body,'$.issue.retryable'),1)=1 AND
      (lease_token IS NULL OR lease_until<=?) ORDER BY request_id LIMIT ?`)
      .all(now, limit) as Row[];
    return rows.map((row) => this.parse(row.body));
  }

  acquire(
    requestId: string,
    ownerUserId: string,
    now = Date.now(),
    durationMs = 30000,
  ): { token: string; record: ContentModificationRecord } | null {
    z.number().int().min(1000).max(120000).parse(durationMs);
    const token = randomUUID();
    return this.db
      .transaction(() => {
        const changed = this.db
          .prepare(`UPDATE content_modification_requests SET lease_token=?,lease_until=?
        WHERE request_id=? AND owner_user_id=? AND json_extract(body,'$.control') IS NULL AND (lease_token IS NULL OR lease_until<=?)`)
          .run(token, now + durationMs, requestId, ownerUserId, now);
        if (changed.changes !== 1) return null;
        const record = this.get(requestId, ownerUserId);
        if (!record) throw new ContentModificationJournalError('not_found');
        return { token, record };
      })
      .immediate();
  }

  advance(
    requestId: string,
    token: string,
    patch: ContentModificationProgress,
    now = Date.now(),
  ): ContentModificationRecord {
    return this.db
      .transaction(() => this.commitProgress(this.requireLease(requestId, token, now), patch, now))
      .immediate();
  }

  /** Renewal can extend only the still-live winner; an expired/replaced worker cannot resurrect its lease. */
  renew(requestId: string, token: string, now = Date.now(), durationMs = 30000): void {
    z.number().int().min(1000).max(120000).parse(durationMs);
    const changed = this.db
      .prepare(`UPDATE content_modification_requests SET lease_until=?
      WHERE request_id=? AND lease_token=? AND lease_until>?`)
      .run(now + durationMs, requestId, token, now);
    if (changed.changes !== 1) throw new ContentModificationJournalError('lease_changed');
  }

  /** The callback writes the ledger, Task round, human receipt and return intent on this same DB connection. */
  bindReview(
    requestId: string,
    token: string,
    commit: () => NonNullable<ContentModificationProgress['review']>,
    now = Date.now(),
  ): ContentModificationRecord {
    return this.db
      .transaction(() => {
        const record = this.requireLease(requestId, token, now);
        if (record.progress.review) return record;
        if (!record.progress.sourceMessageId || !record.progress.prepared || !record.progress.task)
          throw new ContentModificationJournalError('invalid_progress');
        return this.commitProgress(record, { review: commit() }, now);
      })
      .immediate();
  }

  release(requestId: string, token: string): void {
    this.db
      .prepare(
        'UPDATE content_modification_requests SET lease_token=NULL,lease_until=NULL WHERE request_id=? AND lease_token=?',
      )
      .run(requestId, token);
  }

  noteIssue(
    requestId: string,
    token: string,
    issue: { code: string; retryable: boolean; detail?: string },
    now = Date.now(),
  ): void {
    this.db
      .transaction(() => {
        const record = this.requireLease(requestId, token, now);
        const next = {
          ...record,
          revision: record.revision + 1,
          updatedAt: now,
          issue: z
            .object({
              code: z.string().min(1).max(100),
              retryable: z.boolean(),
              detail: z.string().max(4000).optional(),
            })
            .strict()
            .parse(issue),
        };
        this.db
          .prepare('UPDATE content_modification_requests SET revision=?,body=? WHERE request_id=? AND revision=?')
          .run(next.revision, JSON.stringify(next), record.requestId, record.revision);
      })
      .immediate();
  }

  private requireLease(requestId: string, token: string, now: number): ContentModificationRecord {
    const row = this.db
      .prepare('SELECT body,lease_token,lease_until FROM content_modification_requests WHERE request_id=?')
      .get(requestId) as Row | undefined;
    if (!row || row.lease_token !== token || !row.lease_until || row.lease_until <= now)
      throw new ContentModificationJournalError('lease_changed');
    return this.parse(row.body);
  }

  private commitProgress(
    record: ContentModificationRecord,
    raw: ContentModificationProgress,
    now: number,
  ): ContentModificationRecord {
    const patch = progressSchema.parse(raw);
    for (const key of ['sourceMessageId', 'prepared', 'task', 'review'] as const) {
      if (
        patch[key] !== undefined &&
        record.progress[key] !== undefined &&
        !isDeepStrictEqual(patch[key], record.progress[key])
      )
        throw new ContentModificationJournalError('operation_reused');
    }
    const progress = progressSchema.parse({ ...record.progress, ...patch });
    if (
      (progress.prepared && !progress.sourceMessageId) ||
      (progress.task && !progress.prepared) ||
      (progress.review && !progress.task)
    )
      throw new ContentModificationJournalError('invalid_progress');
    const next = { ...record, progress, revision: record.revision + 1, updatedAt: now };
    delete next.issue;
    const changed = this.db
      .prepare('UPDATE content_modification_requests SET revision=?,body=? WHERE request_id=? AND revision=?')
      .run(next.revision, JSON.stringify(next), record.requestId, record.revision);
    if (changed.changes !== 1) throw new ContentModificationJournalError('lease_changed');
    return next;
  }

  private parse(body: string): ContentModificationRecord {
    const record = JSON.parse(body) as ContentModificationRecord;
    return {
      ...record,
      payload: contentModificationRequestSchema.parse(record.payload),
      progress: progressSchema.parse(record.progress),
      ...(record.control ? { control: modificationCancellationSchema.parse(record.control) } : {}),
    };
  }
}
