import { isDeepStrictEqual } from 'node:util';
import { COLLECTIVE_CUSTODY_MAX_BYTES } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import {
  type CollectiveWorkspaceSnapshot,
  rebindCollectiveWorkspaceSnapshot,
  validateCollectiveWorkspaceSnapshot,
} from './collective-custody-snapshot.js';

/** Internal owner transfer unit. Activation fencing is owned by the composed transfer port. */
export class CollectiveWorkspaceCustody {
  constructor(private readonly db: Database.Database) {}
  validateSnapshot(unsafe: unknown, scopeRef: string, contentRef: string) {
    return validateCollectiveWorkspaceSnapshot(unsafe, scopeRef, contentRef);
  }
  exportSnapshot(contentRef: string, scopeRef: string): CollectiveWorkspaceSnapshot | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare('SELECT body FROM workspace_content_reviews WHERE collaboration_scope=? AND content_ref=?')
          .get(scopeRef, contentRef) as { body: string } | undefined;
        if (!row) return null;
        const review = JSON.parse(row.body) as CollectiveWorkspaceSnapshot['review'];
        let budget = Buffer.byteLength(row.body);
        const read = (sql: string) => {
          const rows: Record<string, unknown>[] = [];
          for (const value of this.db.prepare(sql).iterate(review.reviewId)) {
            budget += Buffer.byteLength(JSON.stringify(value));
            if (budget > COLLECTIVE_CUSTODY_MAX_BYTES || rows.length >= 10000)
              throw new Error('Collective ledger exceeds its admitted bound');
            rows.push(value as Record<string, unknown>);
          }
          return rows;
        };
        const operations: CollectiveWorkspaceSnapshot['operations'] = [];
        for (const row of read(
          'SELECT operation_id,fingerprint,receipt,revision FROM workspace_content_review_operations WHERE review_id=? ORDER BY operation_id',
        ))
          operations.push({
            generation: 'legacy',
            operationId: String(row.operation_id),
            fingerprint: String(row.fingerprint),
            receipt: JSON.parse(String(row.receipt)),
            revision: Number(row.revision),
          });
        for (const row of read(
          'SELECT operation_id,fingerprint,receipt,review FROM workspace_content_review_operation_results WHERE review_id=? ORDER BY operation_id',
        ))
          operations.push({
            generation: 'result',
            operationId: String(row.operation_id),
            fingerprint: String(row.fingerprint),
            receipt: JSON.parse(String(row.receipt)),
            review: JSON.parse(String(row.review)),
          });
        for (const row of read(
          'SELECT operation_id,fingerprint,receipt,result_revision FROM workspace_content_review_operation_receipts WHERE review_id=? ORDER BY operation_id',
        ))
          operations.push({
            generation: 'receipt',
            operationId: String(row.operation_id),
            fingerprint: String(row.fingerprint),
            receipt: JSON.parse(String(row.receipt)),
            resultRevision: Number(row.result_revision),
          });
        const retained = read(
          'SELECT body FROM workspace_content_review_snapshots WHERE review_id=? ORDER BY revision',
        ).map((row) => JSON.parse(String(row.body)));
        return this.validateSnapshot({ v: 1, review, operations, retained }, scopeRef, contentRef);
      })
      .deferred();
  }

  assertTargetAvailable(
    unsafe: unknown,
    scopeRef: string,
    contentRef: string,
    ownerUserId: string,
  ): CollectiveWorkspaceSnapshot {
    const snapshot = rebindCollectiveWorkspaceSnapshot(
      this.validateSnapshot(unsafe, scopeRef, contentRef),
      ownerUserId,
    );
    const conflict = this.db
      .prepare(`SELECT 1 FROM workspace_content_reviews WHERE review_id=? OR
      (owner_user_id=? AND content_ref=?) OR (collaboration_scope=? AND content_ref=?) LIMIT 1`)
      .get(snapshot.review.reviewId, ownerUserId, contentRef, scopeRef, contentRef);
    if (conflict) throw new Error('Collective target ledger collision');
    return snapshot;
  }

  installSnapshot(unsafe: unknown, scopeRef: string, contentRef: string, ownerUserId: string): void {
    const snapshot = rebindCollectiveWorkspaceSnapshot(
      this.validateSnapshot(unsafe, scopeRef, contentRef),
      ownerUserId,
    );
    this.db
      .transaction(() => {
        const existing = this.exportSnapshot(contentRef, scopeRef);
        if (existing) {
          if (!isDeepStrictEqual(existing, snapshot)) throw new Error('Collective target ledger collision');
          return;
        }
        this.assertTargetAvailable(unsafe, scopeRef, contentRef, ownerUserId);
        const review = snapshot.review;
        this.db
          .prepare(
            'INSERT INTO workspace_content_reviews(review_id,owner_user_id,content_ref,revision,body,collaboration_scope) VALUES(?,?,?,?,?,?)',
          )
          .run(review.reviewId, ownerUserId, contentRef, review.revision, JSON.stringify(review), scopeRef);
        for (const item of snapshot.operations) {
          const prefix = [review.reviewId, item.operationId, item.fingerprint, JSON.stringify(item.receipt)];
          if (item.generation === 'legacy')
            this.db
              .prepare('INSERT INTO workspace_content_review_operations VALUES(?,?,?,?,?)')
              .run(...prefix, item.revision);
          else if (item.generation === 'result')
            this.db
              .prepare('INSERT INTO workspace_content_review_operation_results VALUES(?,?,?,?,?)')
              .run(...prefix, JSON.stringify(item.review));
          else
            this.db
              .prepare('INSERT INTO workspace_content_review_operation_receipts VALUES(?,?,?,?,?)')
              .run(...prefix, item.resultRevision);
        }
        for (const retained of snapshot.retained)
          this.db
            .prepare('INSERT INTO workspace_content_review_snapshots VALUES(?,?,?)')
            .run(review.reviewId, retained.revision, JSON.stringify(retained));
      })
      .immediate();
  }
}
