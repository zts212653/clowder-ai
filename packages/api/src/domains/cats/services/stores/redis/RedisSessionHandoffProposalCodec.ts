import type { CatId, HandoffProposalStatus, SessionHandoffProposal } from '@cat-cafe/shared';
import { humanDispositionFeedbackInputSchema, humanDispositionLedgerEntrySchema } from '@cat-cafe/shared';
import { hydrateApprovalPublication, serializeApprovalPublication } from './RedisApprovalPublication.js';

/** proposal → flat hash field/value pairs（note 整体 JSON，checkpoint 字段可选）。 */
export function serializeSessionHandoffProposal(proposal: SessionHandoffProposal): string[] {
  const fields: string[] = [
    'kind',
    proposal.kind,
    'proposalId',
    proposal.proposalId,
    'status',
    proposal.status,
    'sourceThreadId',
    proposal.sourceThreadId,
    'sourceSessionId',
    proposal.sourceSessionId,
    'sourceCatId',
    proposal.sourceCatId,
    'userId',
    proposal.userId,
    'note',
    JSON.stringify(proposal.note),
    'createdAt',
    String(proposal.createdAt),
    'updatedAt',
    String(proposal.updatedAt),
  ];
  if (proposal.handoffNotePersistedAt !== undefined) {
    fields.push('handoffNotePersistedAt', String(proposal.handoffNotePersistedAt));
  }
  if (proposal.sourceMessageId !== undefined) fields.push('sourceMessageId', proposal.sourceMessageId);
  if (proposal.sealedSessionId !== undefined) fields.push('sealedSessionId', proposal.sealedSessionId);
  if (proposal.sealAcceptedAt !== undefined) fields.push('sealAcceptedAt', String(proposal.sealAcceptedAt));
  if (proposal.continuationEntryId !== undefined) fields.push('continuationEntryId', proposal.continuationEntryId);
  if (proposal.cardMessageId !== undefined) fields.push('cardMessageId', proposal.cardMessageId);
  if (proposal.publication) fields.push('publication', serializeApprovalPublication(proposal.publication));
  if (proposal.latestHumanDisposition) {
    fields.push('latestHumanDisposition', JSON.stringify(proposal.latestHumanDisposition));
  }
  if (proposal.humanDispositionLedgerEntry) {
    fields.push('humanDispositionLedgerEntry', JSON.stringify(proposal.humanDispositionLedgerEntry));
  }
  return fields;
}

/** flat hash → proposal（note JSON.parse，数字 parseInt，checkpoint 字段条件加）。 */
export function hydrateSessionHandoffProposal(data: Record<string, string>): SessionHandoffProposal {
  const proposal: SessionHandoffProposal = {
    kind: 'session_handoff',
    proposalId: requiredField(data, 'proposalId'),
    status: requiredField(data, 'status') as HandoffProposalStatus,
    sourceThreadId: requiredField(data, 'sourceThreadId'),
    sourceSessionId: requiredField(data, 'sourceSessionId'),
    sourceCatId: requiredField(data, 'sourceCatId') as CatId,
    userId: requiredField(data, 'userId'),
    note: JSON.parse(requiredField(data, 'note')),
    createdAt: parseInt(requiredField(data, 'createdAt'), 10),
    updatedAt: parseInt(requiredField(data, 'updatedAt'), 10),
  };
  if (data.handoffNotePersistedAt) proposal.handoffNotePersistedAt = parseInt(data.handoffNotePersistedAt, 10);
  if (data.sourceMessageId) proposal.sourceMessageId = data.sourceMessageId;
  if (data.sealedSessionId) proposal.sealedSessionId = data.sealedSessionId;
  if (data.sealAcceptedAt) proposal.sealAcceptedAt = parseInt(data.sealAcceptedAt, 10);
  if (data.continuationEntryId) proposal.continuationEntryId = data.continuationEntryId;
  if (data.cardMessageId) proposal.cardMessageId = data.cardMessageId;
  const publication = hydrateApprovalPublication(data.publication);
  if (publication) proposal.publication = publication;
  if (data.latestHumanDisposition) {
    proposal.latestHumanDisposition = humanDispositionFeedbackInputSchema.parse(
      JSON.parse(data.latestHumanDisposition),
    );
  }
  if (data.humanDispositionLedgerEntry) {
    proposal.humanDispositionLedgerEntry = humanDispositionLedgerEntrySchema.parse(
      JSON.parse(data.humanDispositionLedgerEntry),
    );
  }
  return proposal;
}

function requiredField(data: Record<string, string>, field: string): string {
  const value = data[field];
  if (value === undefined) {
    throw new Error(`Malformed session handoff proposal: missing ${field}`);
  }
  return value;
}
