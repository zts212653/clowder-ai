import type { DispatchProposal } from '@cat-cafe/shared';
import {
  hydrateApprovalPublication,
  serializeApprovalPublication,
} from '../../../cats/services/stores/redis/RedisApprovalPublication.js';

export function serializeDispatchProposal(proposal: DispatchProposal): string[] {
  const fields: string[] = [
    'proposalId',
    proposal.proposalId,
    'sourceThreadId',
    proposal.sourceThreadId,
    'targetThreadId',
    proposal.targetThreadId,
    'senderCatId',
    proposal.senderCatId,
    'ownerUserId',
    proposal.ownerUserId,
    'effectClass',
    proposal.effectClass,
    'content',
    proposal.content,
    'targetCats',
    JSON.stringify(proposal.targetCats),
    'status',
    proposal.status,
    'createdAt',
    String(proposal.createdAt),
  ];
  if (proposal.replyTo) fields.push('replyTo', proposal.replyTo);
  if (proposal.clientMessageId) {
    fields.push('clientMessageId', proposal.clientMessageId);
  }
  if (proposal.proposedAction) {
    fields.push('proposedAction', JSON.stringify(proposal.proposedAction));
  }
  if (proposal.approvalOriginRef) {
    fields.push('approvalOriginRef', JSON.stringify(proposal.approvalOriginRef));
  }
  if (proposal.cardMessageId) fields.push('cardMessageId', proposal.cardMessageId);
  if (proposal.deliveredMessageId) {
    fields.push('deliveredMessageId', proposal.deliveredMessageId);
  }
  if (proposal.decidedAt != null) {
    fields.push('decidedAt', String(proposal.decidedAt));
  }
  if (proposal.decidedBy) fields.push('decidedBy', proposal.decidedBy);
  if (proposal.supersededBy) fields.push('supersededBy', proposal.supersededBy);
  if (proposal.envelopeDigest) {
    fields.push('envelopeDigest', proposal.envelopeDigest);
  }
  if (proposal.actionLeaseRef) {
    fields.push('actionLeaseRef', JSON.stringify(proposal.actionLeaseRef));
  }
  if (proposal.publication) {
    fields.push('publication', serializeApprovalPublication(proposal.publication));
  }
  return fields;
}

export function hydrateDispatchProposal(raw: Record<string, string>): DispatchProposal {
  return {
    proposalId: raw.proposalId,
    sourceThreadId: raw.sourceThreadId,
    targetThreadId: raw.targetThreadId,
    senderCatId: raw.senderCatId,
    ownerUserId: raw.ownerUserId,
    effectClass: 'assign_work',
    content: raw.content,
    targetCats: JSON.parse(raw.targetCats || '[]'),
    status: raw.status as DispatchProposal['status'],
    createdAt: Number(raw.createdAt),
    ...(raw.replyTo ? { replyTo: raw.replyTo } : {}),
    ...(raw.clientMessageId ? { clientMessageId: raw.clientMessageId } : {}),
    ...(raw.proposedAction ? { proposedAction: JSON.parse(raw.proposedAction) } : {}),
    ...(raw.approvalOriginRef ? { approvalOriginRef: JSON.parse(raw.approvalOriginRef) } : {}),
    ...(raw.cardMessageId ? { cardMessageId: raw.cardMessageId } : {}),
    ...(raw.deliveredMessageId ? { deliveredMessageId: raw.deliveredMessageId } : {}),
    ...(raw.decidedAt ? { decidedAt: Number(raw.decidedAt) } : {}),
    ...(raw.decidedBy ? { decidedBy: raw.decidedBy } : {}),
    ...(raw.supersededBy ? { supersededBy: raw.supersededBy } : {}),
    ...(raw.envelopeDigest ? { envelopeDigest: raw.envelopeDigest } : {}),
    ...(raw.actionLeaseRef ? { actionLeaseRef: JSON.parse(raw.actionLeaseRef) } : {}),
    ...(raw.publication ? { publication: hydrateApprovalPublication(raw.publication) } : {}),
  };
}
