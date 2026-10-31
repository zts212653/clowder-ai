import {
  type ApprovalHubItem,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  type RichCardBlock,
} from '@cat-cafe/shared';

export function evalRepairModel(item: ApprovalHubItem) {
  const detail = item.detail;
  const target = exactAssetVersionRefV1Schema.safeParse(detail.targetVersionRef);
  const owner = ownerTruthRefV1Schema.safeParse(detail.ownerRef);
  const authorization = ownerTruthRefV1Schema.safeParse(detail.ownerAuthorizationRef);
  if (
    item.sourceFeatureId !== 'F266' ||
    !target.success ||
    !owner.success ||
    !authorization.success ||
    typeof detail.expectedChange !== 'string' ||
    !detail.expectedChange.trim() ||
    typeof detail.costAndRollback !== 'string' ||
    !detail.costAndRollback.trim() ||
    typeof detail.withdrawalCondition !== 'string' ||
    !detail.withdrawalCondition.trim()
  )
    return null;
  return {
    expectedChange: detail.expectedChange,
    costAndRollback: detail.costAndRollback,
    withdrawalCondition: detail.withdrawalCondition,
    target: target.data,
    owner: owner.data,
    authorization: authorization.data,
  };
}

/** A card-like address is only recognition, never the canonical proposal or permission to write. */
export function isEvalRepairPublication(block: RichCardBlock): boolean {
  const stamp = block.meta?.approval;
  return (
    block.id.startsWith('eval-repair-proposal-') ||
    Boolean(stamp && typeof stamp === 'object' && 'producerId' in stamp && stamp.producerId === 'F266')
  );
}
export function evalRepairCandidate(block: RichCardBlock): string | null {
  const raw = block.meta?.approval;
  const stamp = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (
    !stamp ||
    typeof stamp !== 'object' ||
    Array.isArray(stamp) ||
    Object.keys(stamp).length !== 2 ||
    stamp.producerId !== 'F266' ||
    typeof stamp.canonicalProposalId !== 'string' ||
    !stamp.canonicalProposalId ||
    block.id !== `eval-repair-proposal-${stamp.canonicalProposalId}` ||
    block.actions?.length !== 2
  )
    return null;
  for (const [action, label] of [
    ['eval-repair:approve', '批准'],
    ['eval-repair:reject', '拒绝'],
  ]) {
    const copies = block.actions.filter((a) => a.action === action);
    if (
      copies.length !== 1 ||
      copies[0].label !== label ||
      !copies[0].payload ||
      Object.keys(copies[0].payload).length !== 1 ||
      copies[0].payload.proposalId !== stamp.canonicalProposalId
    )
      return null;
  }
  return stamp.canonicalProposalId;
}

/** Match the real builder's full display and action payloads against the owner-auth canonical DTO. */
export function matchesEvalRepairCard(block: RichCardBlock, item: ApprovalHubItem): boolean {
  const model = evalRepairModel(item);
  if (
    !model ||
    evalRepairCandidate(block) !== item.proposalId ||
    block.kind !== 'card' ||
    block.v !== 1 ||
    block.title !== item.summary ||
    block.bodyMarkdown !== model.expectedChange ||
    block.tone !== 'warning' ||
    block.fields?.length !== 3
  )
    return false;
  const fields = [
    ['成本与回滚', model.costAndRollback],
    ['撤回条件', model.withdrawalCondition],
    ['精确目标', model.target.version],
  ];
  return fields.every(([label, value], i) => block.fields?.[i]?.label === label && block.fields[i].value === value);
}
