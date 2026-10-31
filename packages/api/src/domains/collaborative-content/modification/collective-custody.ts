import { isDeepStrictEqual } from 'node:util';
import { COLLECTIVE_CUSTODY_MAX_BYTES } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import {
  type CollectiveModificationSnapshot,
  rebindCollectiveModificationSnapshot,
  validateCollectiveModificationSnapshot,
} from './collective-custody-snapshot.js';

/** Only Collective rows in the existing F309 journal. No private text snapshots, leases or Task state. */
export class CollectiveModificationCustody {
  constructor(private readonly db: Database.Database) {}
  validateSnapshot(unsafe: unknown, scopeRef: string, contentRef: string) {
    return validateCollectiveModificationSnapshot(unsafe, scopeRef, contentRef);
  }

  exportSnapshot(scopeRef: string, contentRef: string): CollectiveModificationSnapshot {
    return this.db
      .transaction(() => {
        const snapshot: CollectiveModificationSnapshot = { v: 1, requests: [], proposals: [], dispositions: [] };
        let budget = 0;
        const account = (value: unknown) => {
          budget += Buffer.byteLength(JSON.stringify(value));
          if (
            budget > COLLECTIVE_CUSTODY_MAX_BYTES ||
            Math.max(snapshot.requests.length, snapshot.proposals.length, snapshot.dispositions.length) >= 10000
          )
            throw new Error('Collective modifications exceed their admitted bound');
        };
        const rows = this.db.prepare(`SELECT request_id,body,lease_token,lease_until FROM content_modification_requests
        WHERE json_extract(body,'$.kind')='collective-artifact' AND json_extract(body,'$.source.scopeRef')=? ORDER BY request_id`);
        for (const value of rows.iterate(scopeRef)) {
          const row = value as {
            request_id: string;
            body: string;
            lease_token: string | null;
            lease_until: number | null;
          };
          account(row);
          if (
            row.lease_token !== null ||
            row.lease_until !== null ||
            this.db.prepare('SELECT 1 FROM content_modification_text_sources WHERE request_id=?').get(row.request_id) ||
            this.db.prepare('SELECT 1 FROM content_modification_text_decisions WHERE request_id=?').get(row.request_id)
          )
            throw new Error('Collective journal contains private or active execution state');
          snapshot.requests.push(JSON.parse(row.body));
          for (const value of this.db
            .prepare(
              'SELECT revision,operation_id,fingerprint,body FROM content_modification_text_proposals WHERE request_id=? ORDER BY revision',
            )
            .iterate(row.request_id)) {
            const proposal = value as { revision: number; operation_id: string; fingerprint: string; body: string };
            account(proposal);
            snapshot.proposals.push({
              requestId: row.request_id,
              revision: proposal.revision,
              operationId: proposal.operation_id,
              fingerprint: proposal.fingerprint,
              proposal: JSON.parse(proposal.body),
            });
          }
          for (const value of this.db
            .prepare('SELECT body FROM content_modification_acceptances WHERE request_id=? ORDER BY operation_id')
            .iterate(row.request_id)) {
            const disposition = value as { body: string };
            account(disposition);
            snapshot.dispositions.push(JSON.parse(disposition.body));
          }
        }
        return this.validateSnapshot(snapshot, scopeRef, contentRef);
      })
      .deferred();
  }

  assertTargetAvailable(unsafe: unknown, scopeRef: string, contentRef: string, ownerUserId: string) {
    const snapshot = rebindCollectiveModificationSnapshot(
      this.validateSnapshot(unsafe, scopeRef, contentRef),
      ownerUserId,
    );
    for (const request of snapshot.requests) {
      for (const table of [
        'content_modification_requests',
        'content_modification_text_proposals',
        'content_modification_text_sources',
        'content_modification_text_decisions',
        'content_modification_acceptances',
        'content_modification_rejections',
      ])
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE request_id=? LIMIT 1`).get(request.requestId))
          throw new Error('Collective target modification collision');
    }
    for (const item of snapshot.dispositions)
      if (
        this.db
          .prepare('SELECT 1 FROM content_modification_acceptances WHERE owner_user_id=? AND operation_id=?')
          .get(ownerUserId, item.intent.dispositionId)
      )
        throw new Error('Collective target disposition collision');
    return snapshot;
  }

  installSnapshot(unsafe: unknown, scopeRef: string, contentRef: string, ownerUserId: string): void {
    const snapshot = rebindCollectiveModificationSnapshot(
      this.validateSnapshot(unsafe, scopeRef, contentRef),
      ownerUserId,
    );
    this.db
      .transaction(() => {
        const current = this.exportSnapshot(scopeRef, contentRef);
        if (current.requests.length) {
          if (!isDeepStrictEqual(current, snapshot)) throw new Error('Collective target modification collision');
          return;
        }
        this.assertTargetAvailable(unsafe, scopeRef, contentRef, ownerUserId);
        for (const request of snapshot.requests)
          this.db
            .prepare(
              'INSERT INTO content_modification_requests(request_id,owner_user_id,revision,body) VALUES(?,?,?,?)',
            )
            .run(request.requestId, ownerUserId, request.revision, JSON.stringify(request));
        for (const item of snapshot.proposals)
          this.db
            .prepare('INSERT INTO content_modification_text_proposals VALUES(?,?,?,?,?)')
            .run(item.requestId, item.revision, item.operationId, item.fingerprint, JSON.stringify(item.proposal));
        for (const item of snapshot.dispositions)
          this.db
            .prepare('INSERT INTO content_modification_acceptances VALUES(?,?,?,?)')
            .run(ownerUserId, item.intent.dispositionId, item.intent.requestId, JSON.stringify(item));
      })
      .immediate();
  }
}
