import { createHash } from 'node:crypto';
import { assertApprovalEnvelopeIdentity, type TasteProposal } from '@cat-cafe/shared';
import { serializeApprovalPublication } from '../../cats/services/stores/redis/RedisApprovalPublication.js';

/** The immutable F221 content and exact published origin/card that a human must hear or see. */
export const TASTE_DECISION_FIELDS = [
  'id',
  'userId',
  'catId',
  'threadId',
  'sourceMessageId',
  'scene',
  'quote',
  'takeaway',
  'tags',
  'dimension',
  'privacy',
  'createdAt',
  'approvalOriginRef',
  'publication',
] as const;
export type TasteDecisionField = (typeof TASTE_DECISION_FIELDS)[number];
export type TasteDecisionFields = Record<TasteDecisionField, string>;
export interface TasteDecisionSnapshot {
  proposalId: string;
  ownerUserId: string;
  fields: TasteDecisionFields;
  digest: string;
}

function fieldsOf(proposal: TasteProposal, publication: string): TasteDecisionFields {
  return {
    id: proposal.id,
    userId: proposal.userId,
    catId: proposal.catId,
    threadId: proposal.threadId,
    sourceMessageId: proposal.sourceMessageId ?? '',
    scene: proposal.scene,
    quote: proposal.quote,
    takeaway: proposal.takeaway ?? '',
    tags: JSON.stringify(proposal.tags),
    dimension: proposal.dimension,
    privacy: proposal.privacy,
    createdAt: String(proposal.createdAt),
    approvalOriginRef: proposal.approvalOriginRef ? JSON.stringify(proposal.approvalOriginRef) : '',
    publication,
  };
}

function digest(fields: TasteDecisionFields): string {
  return createHash('sha256')
    .update(JSON.stringify(TASTE_DECISION_FIELDS.map((field) => [field, fields[field]])))
    .digest('hex');
}

export function tasteDecisionSnapshot(proposal: TasteProposal): TasteDecisionSnapshot | null {
  if (proposal.status !== 'pending' || proposal.publication?.state !== 'anchored') return null;
  assertApprovalEnvelopeIdentity(proposal.publication.envelope, {
    canonicalProposalId: proposal.id,
    sourceFeatureId: 'F221',
    ownerUserId: proposal.userId,
    requesterCatId: proposal.catId,
    createdAt: proposal.createdAt,
  });
  const fields = fieldsOf(proposal, serializeApprovalPublication(proposal.publication));
  return { proposalId: proposal.id, ownerUserId: proposal.userId, fields, digest: digest(fields) };
}

export function matchesTasteDecisionSnapshot(proposal: TasteProposal, expected: TasteDecisionSnapshot): boolean {
  if (
    expected.proposalId !== proposal.id ||
    expected.ownerUserId !== proposal.userId ||
    expected.digest !== digest(expected.fields)
  )
    return false;
  const current = tasteDecisionSnapshot(proposal);
  return current !== null && current.digest === expected.digest;
}
