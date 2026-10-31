import { isDeepStrictEqual } from 'node:util';
import type { ContentTextProposal } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ContentSettlementReceiptV1 } from '../../video-studio/content-owner/types.js';
import { CollectiveModificationJournal } from './journal/collective-journal.js';
import { ContentModificationJournalError } from './journal-errors.js';

const id = z.string().trim().min(1).max(256);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const collectiveAcceptanceIntentSchema = z
  .object({
    scopeRef: id,
    ownerUserId: id,
    requestId: id,
    dispositionId: id,
    actorHumanId: id,
    candidateRef: id,
    contentRef: id,
    expectedOwnerRevision: z.number().int().positive().safe(),
    custodyRevision: z.number().int().positive().safe(),
    baseDigest: digest,
    resultDigest: digest,
    ownerOperationId: id,
    requestDigest: digest,
  })
  .strict();
export type CollectiveAcceptanceIntent = z.infer<typeof collectiveAcceptanceIntentSchema>;
export type CollectiveDisposition = {
  kind: 'collective-artifact';
  intent: CollectiveAcceptanceIntent;
  createdAt: number;
} & (
  | { state: 'pending' }
  | { state: 'failed'; failedAt: number; reason: 'owner_effect_absent' }
  | { state: 'accepted'; receipt: ContentSettlementReceiptV1; acceptedAt: number }
);
type Disposition = CollectiveDisposition;

/** Scoped dispositions share F309's existing table. A reservation is never an acceptance receipt. */
export class CollectiveContentAcceptanceStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`DROP INDEX IF EXISTS content_modification_collective_winner;
      CREATE UNIQUE INDEX content_modification_collective_winner
      ON content_modification_acceptances(json_extract(body,'$.intent.scopeRef'),request_id)
      WHERE json_extract(body,'$.kind')='collective-artifact' AND json_extract(body,'$.state')<>'failed';`);
  }

  reserve(unsafe: unknown): Disposition {
    const input = collectiveAcceptanceIntentSchema.parse(unsafe);
    return this.db
      .transaction(() => {
        const old = this.get(input.ownerUserId, input.dispositionId);
        if (old) {
          if (!isDeepStrictEqual(old.intent, input)) throw new ContentModificationJournalError('operation_reused');
          if (old.state !== 'failed') return old;
        }
        const request = new CollectiveModificationJournal(this.db).get(input.requestId, input.scopeRef);
        const candidate = this.db
          .prepare(`SELECT body FROM content_modification_text_proposals
        WHERE request_id=? AND json_extract(body,'$.proposalRef')=?`)
          .get(input.requestId, input.candidateRef) as { body: string } | undefined;
        const proposal = candidate ? (JSON.parse(candidate.body) as ContentTextProposal) : undefined;
        if (
          !request ||
          request.ownerUserId !== input.ownerUserId ||
          request.state !== 'proposal_ready' ||
          request.source.contentRef !== input.contentRef ||
          request.source.ownerRevision !== input.expectedOwnerRevision ||
          request.source.blobDigest !== input.baseDigest ||
          !proposal ||
          proposal.baseRevision !== input.baseDigest ||
          proposal.resultRevision !== input.resultDigest
        )
          throw new ContentModificationJournalError('invalid_progress');
        const winner = this.db
          .prepare(`SELECT 1 FROM content_modification_acceptances
        WHERE request_id=? AND json_extract(body,'$.kind')='collective-artifact' AND json_extract(body,'$.intent.scopeRef')=?
        AND json_extract(body,'$.state')<>'failed'`)
          .get(input.requestId, input.scopeRef);
        if (winner) throw new ContentModificationJournalError('acceptance_exists');
        const pending: Disposition = {
          kind: 'collective-artifact',
          intent: input,
          state: 'pending',
          createdAt: old?.createdAt ?? Date.now(),
        };
        if (old) {
          this.db
            .prepare('UPDATE content_modification_acceptances SET body=? WHERE owner_user_id=? AND operation_id=?')
            .run(JSON.stringify(pending), input.ownerUserId, input.dispositionId);
        } else
          this.db
            .prepare('INSERT INTO content_modification_acceptances VALUES (?,?,?,?)')
            .run(input.ownerUserId, input.dispositionId, input.requestId, JSON.stringify(pending));
        return pending;
      })
      .immediate();
  }

  complete(input: CollectiveAcceptanceIntent, receipt: ContentSettlementReceiptV1): Disposition {
    return this.db
      .transaction(() => {
        const pending = this.get(input.ownerUserId, input.dispositionId);
        const context = receipt.operationContext;
        if (
          !pending ||
          pending.state === 'failed' ||
          !isDeepStrictEqual(pending.intent, input) ||
          receipt.contentRef !== input.contentRef ||
          receipt.previousOwnerRevision !== input.expectedOwnerRevision ||
          receipt.ownerRevision !== input.expectedOwnerRevision + 1 ||
          receipt.blobDigest !== input.resultDigest ||
          receipt.operationId !== input.ownerOperationId ||
          receipt.actor.kind !== 'human' ||
          receipt.actor.actorId !== input.actorHumanId ||
          context?.kind !== 'collective-artifact:apply' ||
          context.scopeRef !== input.scopeRef ||
          context.dispositionId !== input.dispositionId ||
          context.requestDigest !== input.requestDigest ||
          context.actorHumanId !== input.actorHumanId ||
          context.custodyRevision !== input.custodyRevision
        )
          throw new ContentModificationJournalError('invalid_progress');
        if (pending.state === 'accepted') {
          if (!isDeepStrictEqual(pending.receipt, receipt))
            throw new ContentModificationJournalError('operation_reused');
          return pending;
        }
        const accepted: Disposition = { ...pending, state: 'accepted', receipt, acceptedAt: Date.now() };
        this.db
          .prepare('UPDATE content_modification_acceptances SET body=? WHERE owner_user_id=? AND operation_id=?')
          .run(JSON.stringify(accepted), input.ownerUserId, input.dispositionId);
        new CollectiveModificationJournal(this.db).noteAccepted(input.requestId, input.scopeRef);
        return accepted;
      })
      .immediate();
  }

  winner(requestId: string, scopeRef: string): Disposition | null {
    const row = this.db
      .prepare(`SELECT body FROM content_modification_acceptances
      WHERE request_id=? AND json_extract(body,'$.kind')='collective-artifact'
      AND json_extract(body,'$.intent.scopeRef')=? AND json_extract(body,'$.state')<>'failed'`)
      .get(requestId, scopeRef) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Disposition) : null;
  }

  forOwnerReceipt(ownerUserId: string, dispositionId: string, scopeRef: string): Disposition | null {
    const disposition = this.get(ownerUserId, dispositionId);
    return disposition?.intent.scopeRef === scopeRef ? disposition : null;
  }

  /** Only called inside the content owner's recovery lock after it proves no operation receipt exists. */
  releaseAbsentEffect(input: CollectiveAcceptanceIntent): void {
    this.db
      .transaction(() => {
        const current = this.get(input.ownerUserId, input.dispositionId);
        if (!current || !isDeepStrictEqual(current.intent, input))
          throw new ContentModificationJournalError('operation_reused');
        if (current.state !== 'pending') return;
        const failed: Disposition = {
          ...current,
          state: 'failed',
          reason: 'owner_effect_absent',
          failedAt: Date.now(),
        };
        this.db
          .prepare('UPDATE content_modification_acceptances SET body=? WHERE owner_user_id=? AND operation_id=?')
          .run(JSON.stringify(failed), input.ownerUserId, input.dispositionId);
      })
      .immediate();
  }

  private get(ownerUserId: string, operationId: string): Disposition | null {
    const row = this.db
      .prepare('SELECT body FROM content_modification_acceptances WHERE owner_user_id=? AND operation_id=?')
      .get(ownerUserId, operationId) as { body: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.body) as Disposition;
    if (value.kind !== 'collective-artifact') throw new ContentModificationJournalError('operation_reused');
    return value;
  }
}
