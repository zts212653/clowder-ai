import { isDeepStrictEqual } from 'node:util';
import type { ContentModificationRecord } from '@cat-cafe/shared';
import { contentModificationOutcome, contentModificationRequestContractSchema } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ModificationCancellationStore } from '../control/cancellation-store.js';
import { ContentModificationJournalError } from '../journal-errors.js';
import {
  contentModificationJournalIdSchema,
  contentModificationMessageRevisionSchema,
  modificationMessageRequestId,
  parseContentModificationRecord,
} from './journal-record.js';

/** Same journal and transaction as legacy takeover; each selected work has its own original owner request. */
export type MessageTakeoverSource = {
  messageId: string;
  messageRevision: `sha256:${string}`;
  attachmentId?: string;
  operationId?: string;
  visibility:
    | { readonly visibility: 'public' }
    | { readonly visibility: 'whisper'; readonly whisperTo: readonly string[] };
};

export function reserveMessageModification(
  db: Database.Database,
  cancellations: ModificationCancellationStore,
  ownerUserId: string,
  raw: unknown,
  source: MessageTakeoverSource,
  now = Date.now(),
): ContentModificationRecord {
  contentModificationJournalIdSchema.parse(ownerUserId);
  contentModificationJournalIdSchema.parse(source.messageId);
  contentModificationMessageRevisionSchema.parse(source.messageRevision);
  if (source.attachmentId !== undefined) z.string().trim().min(1).max(128).parse(source.attachmentId);
  const payload = contentModificationRequestContractSchema.parse(raw);
  contentModificationOutcome(payload.intent);
  const requestId = modificationMessageRequestId(ownerUserId, source.messageId, source.attachmentId);
  const operationId = source.operationId ?? payload.operationId;
  z.string().uuid().parse(operationId);
  return db
    .transaction(() => {
      const operation = findTakeoverOperation(db, ownerUserId, operationId);
      if (operation && operation.requestId !== requestId) throw new ContentModificationJournalError('operation_reused');
      const existing = readRecord(db, requestId, ownerUserId);
      if (existing) {
        if (
          existing.progress.sourceMessageId !== source.messageId ||
          existing.progress.sourceMessageRevision !== source.messageRevision ||
          existing.progress.sourceAttachmentId !== source.attachmentId ||
          existing.progress.sourceKind !== 'human_message' ||
          !isDeepStrictEqual(existing.progress.sourceVisibility, source.visibility)
        )
          throw new ContentModificationJournalError('operation_reused');
        const operations = new Set(existing.progress.takeoverOperationIds ?? [existing.payload.operationId]);
        if (operations.has(operationId)) return existing;
        operations.add(operationId);
        const next = {
          ...existing,
          progress: { ...existing.progress, takeoverOperationIds: [...operations] },
          revision: existing.revision + 1,
          updatedAt: now,
        };
        db.prepare('UPDATE content_modification_requests SET revision=?,body=? WHERE request_id=? AND revision=?').run(
          next.revision,
          JSON.stringify(next),
          requestId,
          existing.revision,
        );
        return next;
      }
      if (payload.taskContext) cancellations.assertTaskAvailable(ownerUserId, payload.taskContext.taskId);
      const record: ContentModificationRecord = {
        requestId,
        ownerUserId,
        payload,
        progress: {
          sourceMessageId: source.messageId,
          sourceMessageRevision: source.messageRevision,
          ...(source.attachmentId ? { sourceAttachmentId: source.attachmentId } : {}),
          takeoverOperationIds: [operationId],
          sourceKind: 'human_message',
          sourceVisibility: source.visibility,
        },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        'INSERT INTO content_modification_requests(request_id,owner_user_id,revision,body) VALUES(?,?,?,?)',
      ).run(requestId, ownerUserId, 1, JSON.stringify(record));
      return record;
    })
    .immediate();
}

export function findTakeoverOperation(
  db: Database.Database,
  ownerUserId: string,
  operationId: string,
): ContentModificationRecord | null {
  const rows = db
    .prepare(`SELECT body FROM content_modification_requests
      WHERE owner_user_id=? AND COALESCE(json_extract(body,'$.kind'),'private')<>'collective-artifact' AND (json_extract(body,'$.payload.operationId')=? OR EXISTS
        (SELECT 1 FROM json_each(json_extract(body,'$.progress.takeoverOperationIds')) WHERE value=?)) LIMIT 2`)
    .all(ownerUserId, operationId, operationId) as { body: string }[];
  if (rows.length > 1) throw new ContentModificationJournalError('operation_reused');
  return rows[0] ? parseContentModificationRecord(rows[0].body) : null;
}
function readRecord(db: Database.Database, requestId: string, ownerUserId: string): ContentModificationRecord | null {
  const row = db
    .prepare(
      "SELECT body FROM content_modification_requests WHERE request_id=? AND owner_user_id=? AND COALESCE(json_extract(body,'$.kind'),'private')<>'collective-artifact'",
    )
    .get(requestId, ownerUserId) as { body: string } | undefined;
  return row ? parseContentModificationRecord(row.body) : null;
}
