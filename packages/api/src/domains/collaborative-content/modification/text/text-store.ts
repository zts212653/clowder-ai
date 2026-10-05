import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type ContentTextProposal, type RespondContentText, respondContentTextSchema } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { WorkspaceContentDescriptionV1 } from '../../../workspace/workspace-content-source.js';
import { WorkspaceContentSourceError } from '../../../workspace/workspace-content-source.js';

export interface ModificationTextSource {
  requestId: string;
  ownerUserId: string;
  source: WorkspaceContentDescriptionV1;
  text: string;
  reviewId: string;
  reviewRevision: number;
}
export class ModificationTextError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'task_changed'
      | 'source_changed'
      | 'operation_reused'
      | 'proposal_changed'
      | 'invalid_patch',
  ) {
    super(code);
  }
}

export function applyContentTextEdits(text: string, edits: RespondContentText['edits']): string {
  let cursor = 0,
    result = '';
  for (const [index, edit] of edits.entries()) {
    if (
      edit.start < cursor ||
      edit.end > text.length ||
      text.slice(edit.start, edit.end) !== edit.expectedText ||
      (index > 0 && edit.start === edits[index - 1]?.start)
    )
      throw new ModificationTextError('invalid_patch');
    result += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  result += text.slice(cursor);
  if (
    Buffer.byteLength(result) > 1024 * 1024 ||
    result.includes('\0') ||
    Buffer.from(result).toString('utf8') !== result
  )
    throw new ModificationTextError('invalid_patch');
  return result;
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
  respond(raw: unknown, authorCatId: string): ContentTextProposal {
    const command = respondContentTextSchema.parse(raw);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([command, authorCatId]))
      .digest('hex');
    return this.db
      .transaction(() => {
        const old = this.db
          .prepare(
            'SELECT fingerprint,body FROM content_modification_text_proposals WHERE request_id=? AND operation_id=?',
          )
          .get(command.requestId, command.operationId) as { fingerprint: string; body: string } | undefined;
        if (old) {
          if (old.fingerprint !== fingerprint) throw new ModificationTextError('operation_reused');
          return JSON.parse(old.body) as ContentTextProposal;
        }
        const source = this.source(command.requestId);
        if (!source || source.source.revision !== command.baseRevision)
          throw new ModificationTextError('source_changed');
        const current = this.proposals(command.requestId).at(-1)?.revision ?? 0;
        if (current !== command.expectedProposalRevision) throw new ModificationTextError('proposal_changed');
        const text = applyContentTextEdits(source.text, command.edits);
        const revision = current + 1;
        const proposalRef = `content-patch:${command.requestId}:${revision}`;
        const proposal: ContentTextProposal = {
          proposalRef,
          requestId: command.requestId,
          revision,
          operationId: command.operationId,
          baseRevision: command.baseRevision,
          resultRevision: sha(text),
          edits: command.edits,
          response: command.response,
          authorCatId,
          createdAt: Date.now(),
          receiptRef: `${proposalRef}#prepared`,
        };
        this.db
          .prepare('INSERT INTO content_modification_text_proposals VALUES (?,?,?,?,?)')
          .run(command.requestId, revision, command.operationId, fingerprint, JSON.stringify(proposal));
        return proposal;
      })
      .immediate();
  }
}
