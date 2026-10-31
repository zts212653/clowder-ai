import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ContentTextProposal,
  respondCollectiveContentTextSchema,
  respondContentTextSchema,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { WorkspaceContentDescriptionV1 } from '../../../workspace/workspace-content-source.js';
import { WorkspaceContentSourceError } from '../../../workspace/workspace-content-source.js';
import { CollectiveModificationJournal } from '../journal/collective-journal.js';
import { ModificationTextError } from './errors.js';
import { writeContentTextProposal } from './proposal-write.js';

export { ModificationTextError } from './errors.js';
export { applyContentTextEdits } from './patch.js';

export interface ModificationTextSource {
  requestId: string;
  ownerUserId: string;
  source: WorkspaceContentDescriptionV1;
  text: string;
  reviewId: string;
  reviewRevision: number;
}
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Immutable F063 text snapshot and typed patch proposals; neither is an editable file owner. */
export class ModificationTextStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS content_modification_text_sources (
      request_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_modification_text_proposals (
      request_id TEXT NOT NULL, revision INTEGER NOT NULL, operation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(request_id,revision), UNIQUE(request_id,operation_id));
      CREATE TABLE IF NOT EXISTS content_modification_text_decisions (
      receipt_ref TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);`);
  }
  source(requestId: string): ModificationTextSource | null {
    const row = this.db
      .prepare('SELECT body FROM content_modification_text_sources WHERE request_id=?')
      .get(requestId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ModificationTextSource) : null;
  }
  retain(source: ModificationTextSource): ModificationTextSource {
    if (Buffer.byteLength(source.text) > 1024 * 1024) throw new WorkspaceContentSourceError('too_large');
    if (sha(source.text) !== source.source.revision) throw new ModificationTextError('source_changed');
    return this.db.transaction(() => {
      const prior = this.source(source.requestId);
      if (prior && !isDeepStrictEqual(prior, source)) throw new ModificationTextError('operation_reused');
      if (!prior)
        this.db
          .prepare('INSERT INTO content_modification_text_sources VALUES (?,?)')
          .run(source.requestId, JSON.stringify(source));
      return prior ?? source;
    })();
  }
  decide(input: {
    receiptRef: string;
    requestId: string;
    actorId: string;
    sourceMessageId: string;
    taskId: string;
    createdAt: number;
  }): void {
    if (!this.db.inTransaction) throw new Error('Text human decision must share the request/outbox transaction');
    this.db
      .prepare('INSERT INTO content_modification_text_decisions VALUES (?,?,?)')
      .run(input.receiptRef, input.requestId, JSON.stringify(input));
  }
  proposals(requestId: string): ContentTextProposal[] {
    const rows = this.db
      .prepare('SELECT body FROM content_modification_text_proposals WHERE request_id=? ORDER BY revision')
      .all(requestId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as ContentTextProposal);
  }
  latestProposal(requestId: string): ContentTextProposal | null {
    const row = this.db
      .prepare('SELECT body FROM content_modification_text_proposals WHERE request_id=? ORDER BY revision DESC LIMIT 1')
      .get(requestId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ContentTextProposal) : null;
  }
  respond(raw: unknown, authorCatId: string): ContentTextProposal {
    const command = respondContentTextSchema.parse(raw);
    return this.db
      .transaction(() => {
        const source = this.source(command.requestId);
        if (!source || source.source.revision !== command.baseRevision)
          throw new ModificationTextError('source_changed');
        return writeContentTextProposal(this.db, command, authorCatId, source.text, 1024 * 1024).proposal;
      })
      .immediate();
  }

  /** Source bytes are loaded from the canonical owner for this call, never retained here. */
  respondOwner(
    raw: unknown,
    authorCatId: string,
    source: {
      scopeRef: string;
      contentRef: string;
      ownerRevision: number;
      blobDigest: string;
      text: string;
    },
    replayOnly = false,
  ): ContentTextProposal {
    const command = respondCollectiveContentTextSchema.parse(raw);
    return this.db
      .transaction(() => {
        const journal = new CollectiveModificationJournal(this.db);
        const request = journal.get(command.requestId, source.scopeRef);
        if (!request || request.target.catId !== authorCatId) throw new ModificationTextError('not_found');
        if (
          request.source.contentRef !== source.contentRef ||
          request.source.ownerRevision !== source.ownerRevision ||
          request.source.blobDigest !== source.blobDigest ||
          sha(source.text) !== source.blobDigest ||
          command.expectedOwnerRevision !== source.ownerRevision ||
          command.baseRevision !== source.blobDigest
        )
          throw new ModificationTextError('source_changed');
        const result = writeContentTextProposal(
          this.db,
          command,
          authorCatId,
          source.text,
          65536,
          !replayOnly && ['requested', 'running', 'proposal_ready'].includes(request.state),
        );
        if (!result.replayed) journal.noteProposal(request.requestId, source.scopeRef);
        return result.proposal;
      })
      .immediate();
  }
}
