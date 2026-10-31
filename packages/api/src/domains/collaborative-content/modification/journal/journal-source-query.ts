import type { ContentModificationRecord } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { parseContentModificationRecord } from './journal-record.js';

/** Storage-only row shape for source lookups behind the journal facade. */
interface BodyRow {
  readonly body: string;
}

export function findContentModificationRecordsForSource(
  db: Database.Database,
  ownerUserId: string,
  source: ContentModificationRecord['payload']['source'],
): ContentModificationRecord[] {
  const rows =
    source.kind === 'video-project'
      ? db
          .prepare(`SELECT body FROM content_modification_requests WHERE owner_user_id=? AND
        json_extract(body,'$.payload.source.kind')='video-project' AND json_extract(body,'$.payload.source.contentRef')=?
        ORDER BY json_extract(body,'$.createdAt') DESC,request_id`)
          .all(ownerUserId, source.contentRef)
      : source.kind === 'publication'
        ? db
            .prepare(`SELECT body FROM content_modification_requests WHERE owner_user_id=? AND
        (json_extract(body,'$.payload.source.contentRef')=? OR json_extract(body,'$.progress.prepared.contentRef')=?)
        ORDER BY json_extract(body,'$.createdAt') DESC,request_id`)
            .all(ownerUserId, source.contentRef, source.contentRef)
        : source.kind === 'artifact-review'
          ? db
              .prepare(`SELECT body FROM content_modification_requests WHERE owner_user_id=? AND
          (json_extract(body,'$.payload.source.reviewId')=? OR json_extract(body,'$.progress.review.reviewId')=?)
          ORDER BY json_extract(body,'$.createdAt') DESC,request_id`)
              .all(ownerUserId, source.reviewId, source.reviewId)
          : source.kind === 'evolution'
            ? db
                .prepare(`SELECT body FROM content_modification_requests WHERE owner_user_id=? AND
          json_extract(body,'$.payload.source.kind')='evolution' AND json_extract(body,'$.payload.source.reviewId')=?
          ORDER BY json_extract(body,'$.createdAt') DESC,request_id`)
                .all(ownerUserId, source.reviewId)
            : db
                .prepare(`SELECT body FROM content_modification_requests WHERE owner_user_id=? AND
        json_extract(body,'$.payload.source.kind')='workspace' AND
        json_extract(body,'$.payload.source.locator.worktreeId')=? AND json_extract(body,'$.payload.source.locator.path')=?
        ORDER BY json_extract(body,'$.createdAt') DESC,request_id`)
                .all(ownerUserId, source.locator.worktreeId, source.locator.path);
  return (rows as BodyRow[]).map((row) => parseContentModificationRecord(row.body));
}
