import { createHash } from 'node:crypto';
import type { ContentTextProposal, RespondCollectiveContentText, RespondContentText } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { ModificationTextError } from './errors.js';
import { applyContentTextEdits } from './patch.js';

/** Both source kinds use the same proposal CAS and idempotency namespace. Caller owns the transaction. */
export function writeContentTextProposal(
  db: Database.Database,
  command: RespondContentText | RespondCollectiveContentText,
  authorCatId: string,
  sourceText: string,
  maxBytes: number,
  allowNew = true,
): { proposal: ContentTextProposal; replayed: boolean } {
  if (!db.inTransaction) throw new Error('Proposal insert must share its request transaction');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([command, authorCatId]))
    .digest('hex');
  const old = db
    .prepare('SELECT fingerprint,body FROM content_modification_text_proposals WHERE request_id=? AND operation_id=?')
    .get(command.requestId, command.operationId) as { fingerprint: string; body: string } | undefined;
  if (old) {
    if (old.fingerprint !== fingerprint) throw new ModificationTextError('operation_reused');
    return { proposal: JSON.parse(old.body) as ContentTextProposal, replayed: true };
  }
  if (!allowNew) throw new ModificationTextError('proposal_changed');
  const current = db
    .prepare('SELECT MAX(revision) AS revision FROM content_modification_text_proposals WHERE request_id=?')
    .get(command.requestId) as { revision: number | null };
  if ((current.revision ?? 0) !== command.expectedProposalRevision) throw new ModificationTextError('proposal_changed');
  const text = applyContentTextEdits(sourceText, command.edits);
  if (Buffer.byteLength(text) > maxBytes) throw new ModificationTextError('invalid_patch');
  const revision = (current.revision ?? 0) + 1;
  const proposalRef = `content-patch:${command.requestId}:${revision}`;
  const proposal: ContentTextProposal = {
    proposalRef,
    requestId: command.requestId,
    revision,
    operationId: command.operationId,
    baseRevision: command.baseRevision,
    resultRevision: `sha256:${createHash('sha256').update(text).digest('hex')}`,
    edits: command.edits,
    response: command.response,
    authorCatId,
    createdAt: Date.now(),
    receiptRef: `${proposalRef}#prepared`,
  };
  db.prepare('INSERT INTO content_modification_text_proposals VALUES (?,?,?,?,?)').run(
    command.requestId,
    revision,
    command.operationId,
    fingerprint,
    JSON.stringify(proposal),
  );
  return { proposal, replayed: false };
}
