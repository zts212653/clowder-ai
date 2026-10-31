import type { ContentModificationCancellation, ContentModificationRecord } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ContentModificationJournalError } from '../journal-errors.js';

export const modificationCancellationSchema = z
  .object({
    state: z.literal('cancelled'),
    actorId: z.string().min(1),
    cancelledAt: z.number().int().nonnegative(),
    receiptRef: z.string().min(1),
    taskResolution: z.enum(['unknown', 'closing', 'preserved', 'closed', 'owner_changed']),
    task: z
      .object({
        taskId: z.string().min(1),
        mode: z.enum(['close', 'preserve']),
        observedRevision: z.number().int().positive(),
        dispositionRef: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** One journal row owns cancellation. No second Task state or alternate delivery queue is created. */
export class ModificationCancellationStore {
  constructor(private readonly db: Database.Database) {}

  cancel(requestId: string, ownerUserId: string, now = Date.now()): ContentModificationRecord {
    return this.db
      .transaction(() => {
        const record = this.get(requestId, ownerUserId);
        if (record.control) return record;
        const control: ContentModificationCancellation = {
          state: 'cancelled',
          actorId: ownerUserId,
          cancelledAt: now,
          receiptRef: `${requestId}#cancelled`,
          taskResolution: 'unknown',
        };
        const next = this.write(record, control);
        this.db
          .prepare('UPDATE content_modification_requests SET lease_token=NULL,lease_until=NULL WHERE request_id=?')
          .run(requestId);
        return next;
      })
      .immediate();
  }

  observe(
    requestId: string,
    ownerUserId: string,
    patch: Pick<ContentModificationCancellation, 'task' | 'taskResolution'>,
  ) {
    return this.db
      .transaction(() => {
        const record = this.get(requestId, ownerUserId);
        if (!record.control) throw new ContentModificationJournalError('invalid_progress');
        if (['closed', 'preserved', 'owner_changed'].includes(record.control.taskResolution)) return record;
        if (
          record.control.task &&
          patch.task &&
          (record.control.task.taskId !== patch.task.taskId || record.control.task.mode !== patch.task.mode)
        )
          throw new ContentModificationJournalError('operation_reused');
        const { task, ...resolution } = patch;
        return this.write(record, { ...record.control, ...resolution, ...(task ? { task } : {}) });
      })
      .immediate();
  }

  bindTask(requestId: string, ownerUserId: string, taskId: string, observedRevision: number) {
    return this.db
      .transaction(() => {
        const record = this.get(requestId, ownerUserId);
        if (!record.control) throw new ContentModificationJournalError('invalid_progress');
        const mode =
          record.control.task?.mode ??
          (record.payload.taskContext || this.sharesTask(record, taskId) ? 'preserve' : 'close');
        return this.observe(requestId, ownerUserId, {
          task: { taskId, mode, observedRevision },
          taskResolution: mode === 'preserve' ? 'preserved' : 'closing',
        });
      })
      .immediate();
  }

  pending(limit = 100): ContentModificationRecord[] {
    z.number().int().min(1).max(1000).parse(limit);
    return this.rows(
      `SELECT body FROM content_modification_requests WHERE json_extract(body,'$.control.taskResolution') IN ('unknown','closing')
      ORDER BY json_extract(body,'$.updatedAt'), request_id LIMIT ?`,
      limit,
    );
  }

  sharesTask(record: ContentModificationRecord, taskId: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM content_modification_requests WHERE owner_user_id=? AND request_id<>? AND
      (json_extract(body,'$.progress.task.taskId')=? OR json_extract(body,'$.payload.taskContext.taskId')=?) LIMIT 1`)
        .get(record.ownerUserId, record.requestId, taskId, taskId),
    );
  }

  assertTaskAvailable(ownerUserId: string, taskId: string): void {
    const row = this.db
      .prepare(`SELECT 1 FROM content_modification_requests WHERE owner_user_id=? AND
      json_extract(body,'$.control.task.taskId')=? AND json_extract(body,'$.control.task.mode')='close' LIMIT 1`)
      .get(ownerUserId, taskId);
    if (row) throw new ContentModificationJournalError('task_cancellation_pending');
  }

  isReturnCancelled(receiptRef: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM content_modification_requests WHERE json_extract(body,'$.progress.review.receiptRef')=?
      AND json_extract(body,'$.control.state')='cancelled' LIMIT 1`)
        .get(receiptRef),
    );
  }

  unlessCancelled<T>(requestId: string, ownerUserId: string, commit: () => T): T {
    return this.db
      .transaction(() => {
        if (this.get(requestId, ownerUserId).control) throw new ContentModificationJournalError('request_cancelled');
        return commit();
      })
      .immediate();
  }

  private get(requestId: string, ownerUserId: string): ContentModificationRecord {
    const record = this.rows(
      'SELECT body FROM content_modification_requests WHERE request_id=? AND owner_user_id=?',
      requestId,
      ownerUserId,
    )[0];
    if (!record) throw new ContentModificationJournalError('not_found');
    return record;
  }
  private rows(sql: string, ...values: (string | number)[]): ContentModificationRecord[] {
    return (this.db.prepare(sql).all(...values) as { body: string }[]).map(({ body }) => {
      const record = JSON.parse(body) as ContentModificationRecord;
      if (record.control) record.control = modificationCancellationSchema.parse(record.control);
      return record;
    });
  }
  private write(
    record: ContentModificationRecord,
    control: ContentModificationCancellation,
  ): ContentModificationRecord {
    const next = {
      ...record,
      control: modificationCancellationSchema.parse(control),
      revision: record.revision + 1,
      updatedAt: Date.now(),
    };
    delete next.issue;
    const changed = this.db
      .prepare('UPDATE content_modification_requests SET body=?,revision=? WHERE request_id=? AND revision=?')
      .run(JSON.stringify(next), next.revision, record.requestId, record.revision);
    if (changed.changes !== 1) throw new ContentModificationJournalError('lease_changed');
    return next;
  }
}
