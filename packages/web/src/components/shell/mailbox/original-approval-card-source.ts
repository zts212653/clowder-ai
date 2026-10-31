import { isValidRichBlock, type UnifiedAttentionItemV1 } from '@cat-cafe/shared';

/** The server-issued F225/F231 live original-card capability, never the legacy inline flag. */
export function originalApprovalSource(item: UnifiedAttentionItemV1) {
  const approval = item.approval,
    proof = item.originalApprovalCard;
  if (
    !approval ||
    !proof ||
    !['F225', 'F231'].includes(approval.sourceFeatureId) ||
    approval.resolution !== 'open' ||
    approval.navigation?.state !== 'anchored'
  )
    return null;
  const ref = approval.navigation.approvalCardRef,
    card = proof.cardRef,
    block = proof.block;
  const prefix = approval.sourceFeatureId === 'F225' ? 'handoff' : 'profile-update';
  if (
    !card ||
    card.threadId !== ref.threadId ||
    card.messageId !== ref.messageId ||
    card.blockId !== `${prefix}-${approval.proposalId}` ||
    !isValidRichBlock(block) ||
    block.kind !== 'card' ||
    block.id !== card.blockId
  )
    return null;
  const stamp = block.meta?.approval;
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp) || Object.keys(stamp).length !== 2) return null;
  const binding = stamp as Record<string, unknown>;
  if (
    binding.producerId !== approval.sourceFeatureId ||
    binding.canonicalProposalId !== approval.proposalId ||
    block.actions?.length !== 2
  )
    return null;
  for (const verb of ['approve', 'reject']) {
    const actions = block.actions.filter((a) => a.action === `${prefix}:${verb}`);
    if (
      actions.length !== 1 ||
      !actions[0].payload ||
      Object.keys(actions[0].payload).length !== 1 ||
      actions[0].payload.proposalId !== approval.proposalId
    )
      return null;
  }
  return { approval, proof };
}
export function sameOriginalApprovalSource(a: UnifiedAttentionItemV1, b: UnifiedAttentionItemV1): boolean {
  const x = originalApprovalSource(a),
    y = originalApprovalSource(b);
  return Boolean(x && y && JSON.stringify(x) === JSON.stringify(y));
}
