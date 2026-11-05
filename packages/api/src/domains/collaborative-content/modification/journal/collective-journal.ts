import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveModificationRecord,
  collectiveModificationIntentSchema,
  collectiveModificationRecordSchema,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { collectiveResolutionReceipt } from '../collective-resolution.js';
import { ContentModificationJournalError } from '../journal-errors.js';

type ResolutionInput = Omit<NonNullable<CollectiveModificationRecord['resolution']>, 'receiptRef' | 'resolvedAt'> & {
  scopeRef: string;
  requestId: string;
};

/** A scoped port onto the existing request table; it owns no source bytes, ACL, Task or second journal. */
export class CollectiveModificationJournal {
  constructor(private readonly db: Database.Database) {}

  reserve(unsafe: unknown): CollectiveModificationRecord {
    const input = collectiveModificationIntentSchema.parse(unsafe);
    const requestId = `f309-modification-${createHash('sha256')
      .update(JSON.stringify(['collective-artifact', input.source.scopeRef, input.source.requestEventId]))
      .digest('hex')}`;
    return this.db
      .transaction(() => {
        const existing = this.get(requestId, input.source.scopeRef);
        if (existing) {
          const prior = collectiveModificationIntentSchema.parse({
            ownerUserId: existing.ownerUserId,
            requestingHumanId: existing.requestingHumanId,
            source: existing.source,
            target: existing.target,
            instruction: existing.instruction,
            annotationIds: existing.annotationIds,
          });
          if (!isDeepStrictEqual(prior, input)) throw new ContentModificationJournalError('operation_reused');
          return existing;
        }
        const now = Date.now();
        const record = collectiveModificationRecordSchema.parse({
          ...input,
          v: 1,
          kind: 'collective-artifact',
          requestId,
          revision: 1,
          state: 'requested',
          createdAt: now,
          updatedAt: now,
        });
        this.db
          .prepare('INSERT INTO content_modification_requests(request_id,owner_user_id,revision,body) VALUES(?,?,?,?)')
          .run(record.requestId, record.ownerUserId, record.revision, JSON.stringify(record));
        return record;
      })
      .immediate();
  }

  get(requestId: string, scopeRef: string): CollectiveModificationRecord | null {
    const row = this.db
      .prepare(`SELECT body FROM content_modification_requests WHERE request_id=?
      AND json_extract(body,'$.kind')='collective-artifact' AND json_extract(body,'$.source.scopeRef')=?`)
      .get(requestId, scopeRef) as { body: string } | undefined;
    return row ? collectiveModificationRecordSchema.parse(JSON.parse(row.body)) : null;
  }

  forSource(scopeRef: string, requestEventId: string): CollectiveModificationRecord | null {
    const row = this.db
      .prepare(`SELECT body FROM content_modification_requests
      WHERE json_extract(body,'$.kind')='collective-artifact' AND json_extract(body,'$.source.scopeRef')=?
      AND json_extract(body,'$.source.requestEventId')=? LIMIT 1`)
      .get(scopeRef, requestEventId) as { body: string } | undefined;
    return row ? collectiveModificationRecordSchema.parse(JSON.parse(row.body)) : null;
  }
  list(scopeRef: string, offset: number, limit: number) {
    return this.db.transaction(() => {
      const filter = "json_extract(body,'$.kind')='collective-artifact' AND json_extract(body,'$.source.scopeRef')=?";
      const { total, revisionSum } = this.db
        .prepare(`SELECT count(*) AS total, COALESCE(sum(revision),0) AS revisionSum
        FROM content_modification_requests WHERE ${filter}`)
        .get(scopeRef) as { total: number; revisionSum: number };
      const rows = this.db
        .prepare(`SELECT body FROM content_modification_requests WHERE ${filter}
      ORDER BY json_extract(body,'$.createdAt') DESC, request_id LIMIT ? OFFSET ?`)
        .all(scopeRef, limit, offset) as { body: string }[];
      // Every durable request mutation increments its revision; receipt replay changes neither term.
      const snapshot = `sha256:${createHash('sha256')
        .update(JSON.stringify([scopeRef, total, revisionSum]))
        .digest('hex')}`;
      return {
        total,
        snapshot,
        requests: rows.map((row) => collectiveModificationRecordSchema.parse(JSON.parse(row.body))),
      };
    })();
  }

  /** Called after the durable scope fence, before constructing the transfer cut. */
  terminalizeForTransfer(scopeRef: string, transferId: string, sourceCustodyRevision: number): void {
    this.db
      .transaction(() => {
        const rows = this.db
          .prepare(`SELECT body FROM content_modification_requests WHERE json_extract(body,'$.kind')='collective-artifact'
        AND json_extract(body,'$.source.scopeRef')=? AND json_extract(body,'$.state') IN ('requested','running')`)
          .all(scopeRef) as { body: string }[];
        for (const row of rows) {
          const current = collectiveModificationRecordSchema.parse(JSON.parse(row.body));
          if (
            current.execution ||
            this.db
              .prepare('SELECT 1 FROM content_modification_text_proposals WHERE request_id=? LIMIT 1')
              .get(current.requestId)
          )
            throw new ContentModificationJournalError('invalid_progress');
          const next = collectiveModificationRecordSchema.parse({
            ...current,
            state: 'unavailable',
            revision: current.revision + 1,
            updatedAt: Date.now(),
            transferOutcome: { reason: 'custody_transferred', transferId, sourceCustodyRevision },
          });
          this.db
            .prepare('UPDATE content_modification_requests SET revision=?,body=? WHERE request_id=? AND revision=?')
            .run(next.revision, JSON.stringify(next), current.requestId, current.revision);
        }
      })
      .immediate();
  }

  /** Called only inside the canonical proposal transaction, after its CAS insert. */
  noteProposal(requestId: string, scopeRef: string): void {
    if (!this.db.inTransaction) throw new Error('Proposal and request state must commit together');
    const current = this.get(requestId, scopeRef);
    if (!current || !['requested', 'running', 'proposal_ready'].includes(current.state))
      throw new ContentModificationJournalError('operation_reused');
    const next = collectiveModificationRecordSchema.parse({
      ...current,
      state: 'proposal_ready',
      revision: current.revision + 1,
      updatedAt: Date.now(),
    });
    this.db
      .prepare('UPDATE content_modification_requests SET revision=?,body=? WHERE request_id=? AND revision=?')
      .run(next.revision, JSON.stringify(next), requestId, current.revision);
  }

  noteAccepted(requestId: string, scopeRef: string): void {
    if (!this.db.inTransaction) throw new Error('Acceptance and owner receipt must commit together');
    const current = this.get(requestId, scopeRef);
    if (!current || current.state !== 'proposal_ready') throw new ContentModificationJournalError('invalid_progress');
    const next = collectiveModificationRecordSchema.parse({
      ...current,
      state: 'accepted',
      revision: current.revision + 1,
      updatedAt: Date.now(),
    });
    this.db
      .prepare('UPDATE content_modification_requests SET revision=?,body=? WHERE request_id=? AND revision=?')
      .run(next.revision, JSON.stringify(next), requestId, current.revision);
  }

  resolve(input: ResolutionInput): CollectiveModificationRecord {
    return this.db
      .transaction(() => {
        const current = this.get(input.requestId, input.scopeRef);
        if (!current) throw new ContentModificationJournalError('not_found');
        const receiptRef = collectiveResolutionReceipt(input.scopeRef, input.requestId, input);
        if (current.resolution) {
          if (current.resolution.receiptRef !== receiptRef)
            throw new ContentModificationJournalError('operation_reused');
          return current;
        }
        this.assertCanResolve(current, input);
        const now = Date.now();
        const next = collectiveModificationRecordSchema.parse({
          ...current,
          state: 'cancelled',
          revision: current.revision + 1,
          updatedAt: now,
          resolution: {
            kind: input.kind,
            operationId: input.operationId,
            actorHumanId: input.actorHumanId,
            expectedRequestRevision: input.expectedRequestRevision,
            ...(input.proposalRef ? { proposalRef: input.proposalRef } : {}),
            receiptRef,
            resolvedAt: now,
          },
        });
        this.db
          .prepare('UPDATE content_modification_requests SET revision=?,body=? WHERE request_id=? AND revision=?')
          .run(next.revision, JSON.stringify(next), current.requestId, current.revision);
        return next;
      })
      .immediate();
  }

  private assertCanResolve(current: CollectiveModificationRecord, input: ResolutionInput): void {
    if (current.revision !== input.expectedRequestRevision) throw new ContentModificationJournalError('lease_changed');
    if (!['requested', 'running', 'proposal_ready', 'conflict'].includes(current.state))
      throw new ContentModificationJournalError('invalid_progress');
    if (input.kind === 'rejected') {
      const latest = this.db
        .prepare(`SELECT body FROM content_modification_text_proposals
        WHERE request_id=? ORDER BY revision DESC LIMIT 1`)
        .get(input.requestId) as { body: string } | undefined;
      if (current.state !== 'proposal_ready' || !latest || JSON.parse(latest.body).proposalRef !== input.proposalRef)
        throw new ContentModificationJournalError('candidate_rejected');
    }
    const winner = this.db
      .prepare(`SELECT 1 FROM content_modification_acceptances
      WHERE request_id=? AND json_extract(body,'$.kind')='collective-artifact'
      AND json_extract(body,'$.intent.scopeRef')=? AND json_extract(body,'$.state')<>'failed'`)
      .get(input.requestId, input.scopeRef);
    if (winner) throw new ContentModificationJournalError('acceptance_exists');
  }
}
