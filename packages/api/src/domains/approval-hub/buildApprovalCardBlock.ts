import type { ApprovalProducerId, RichBlock } from '@cat-cafe/shared';

export interface ApprovalCardIdentity {
  producerId: ApprovalProducerId;
  canonicalProposalId: string;
}

export function approvalCardIdempotencyKey(identity: ApprovalCardIdentity): string {
  return `approval:${identity.producerId}:${identity.canonicalProposalId}`;
}

/**
 * Preserve the feature-owned card while stamping a machine-readable approval
 * identity. The feature card id remains its stable recovery key so existing
 * specialized renderers and persisted confirmations keep working.
 */
export function buildApprovalCardBlock(identity: ApprovalCardIdentity, cardBlock: RichBlock): RichBlock {
  if (cardBlock.id.trim().length === 0) throw new Error('approval card block id must be non-empty');
  if (!cardBlock.id.includes(identity.canonicalProposalId)) {
    throw new Error('approval card block id must include canonicalProposalId');
  }
  if (cardBlock.kind !== 'card') return cardBlock;
  return {
    ...cardBlock,
    meta: {
      ...cardBlock.meta,
      approval: {
        producerId: identity.producerId,
        canonicalProposalId: identity.canonicalProposalId,
      },
    },
  };
}
