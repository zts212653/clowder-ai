import type { EventMemoryCorrectionProposal } from '@cat-cafe/shared';
import {
  hydrateApprovalPublication,
  serializeApprovalPublication,
} from '../../cats/services/stores/redis/RedisApprovalPublication.js';

export function serializeEventCorrectionProposal(proposal: EventMemoryCorrectionProposal): string[] {
  const fields = [
    'proposalId',
    proposal.proposalId,
    'status',
    proposal.status,
    'eventId',
    proposal.eventId,
    'expectedRevision',
    proposal.expectedRevision,
    'reason',
    proposal.reason,
    'suggestedPatch',
    JSON.stringify(proposal.suggestedPatch),
    'ownerUserId',
    proposal.ownerUserId,
    'sourceCatId',
    proposal.sourceCatId,
    'sourceThreadId',
    proposal.sourceThreadId,
    'sourceInvocationId',
    proposal.sourceInvocationId,
    'source',
    JSON.stringify(proposal.source),
    'clientRequestId',
    proposal.clientRequestId,
    'createdAt',
    String(proposal.createdAt),
    'approvalOriginRef',
    JSON.stringify(proposal.approvalOriginRef),
  ];
  if (proposal.publication) fields.push('publication', serializeApprovalPublication(proposal.publication));
  if (proposal.approvedBy) fields.push('approvedBy', proposal.approvedBy);
  if (proposal.approvedAt) fields.push('approvedAt', String(proposal.approvedAt));
  if (proposal.rejectedBy) fields.push('rejectedBy', proposal.rejectedBy);
  if (proposal.rejectedAt) fields.push('rejectedAt', String(proposal.rejectedAt));
  if (proposal.rejectionReason) fields.push('rejectionReason', proposal.rejectionReason);
  if (proposal.appliedRevision) fields.push('appliedRevision', proposal.appliedRevision);
  if (proposal.cardMessageId) fields.push('cardMessageId', proposal.cardMessageId);
  return fields;
}

export function hydrateEventCorrectionProposal(raw: Record<string, string>): EventMemoryCorrectionProposal {
  return {
    proposalId: raw.proposalId,
    status: raw.status as EventMemoryCorrectionProposal['status'],
    eventId: raw.eventId,
    expectedRevision: raw.expectedRevision,
    reason: raw.reason as EventMemoryCorrectionProposal['reason'],
    suggestedPatch: JSON.parse(raw.suggestedPatch || '{}'),
    ownerUserId: raw.ownerUserId,
    sourceCatId: raw.sourceCatId,
    sourceThreadId: raw.sourceThreadId,
    sourceInvocationId: raw.sourceInvocationId,
    source: JSON.parse(raw.source || '{}'),
    clientRequestId: raw.clientRequestId,
    createdAt: Number(raw.createdAt),
    approvalOriginRef: JSON.parse(raw.approvalOriginRef || '{}'),
    ...(raw.publication ? { publication: hydrateApprovalPublication(raw.publication) } : {}),
    ...(raw.approvedBy ? { approvedBy: raw.approvedBy } : {}),
    ...(raw.approvedAt ? { approvedAt: Number(raw.approvedAt) } : {}),
    ...(raw.rejectedBy ? { rejectedBy: raw.rejectedBy } : {}),
    ...(raw.rejectedAt ? { rejectedAt: Number(raw.rejectedAt) } : {}),
    ...(raw.rejectionReason ? { rejectionReason: raw.rejectionReason } : {}),
    ...(raw.appliedRevision ? { appliedRevision: raw.appliedRevision } : {}),
    ...(raw.cardMessageId ? { cardMessageId: raw.cardMessageId } : {}),
  };
}
