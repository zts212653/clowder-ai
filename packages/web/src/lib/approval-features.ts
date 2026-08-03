import {
  APPROVAL_PRODUCER_CATALOG,
  APPROVAL_PRODUCER_IDS,
  type ApprovalItem,
  type ApprovalProducerCatalogEntry,
  type ApprovalProducerId,
} from '@cat-cafe/shared';

/** Web compatibility projection derived from the shared producer catalog. */
export type ApprovalFeatureMeta = ApprovalProducerCatalogEntry & { color: string };

export const APPROVAL_FEATURE_IDS = APPROVAL_PRODUCER_IDS;

export const APPROVAL_FEATURES = Object.fromEntries(
  APPROVAL_FEATURE_IDS.map((featureId) => {
    const entry = APPROVAL_PRODUCER_CATALOG[featureId];
    return [featureId, { ...entry, color: entry.colorToken }];
  }),
) as Record<ApprovalProducerId, ApprovalFeatureMeta>;

export function approvalFeatureMeta(featureId: ApprovalProducerId): ApprovalFeatureMeta {
  return APPROVAL_FEATURES[featureId];
}

export function isApprovalItemBatchDecidable(item: ApprovalItem): boolean {
  const hasEntityConflict = item.sourceFeatureId === 'F260' && Boolean(item.detail.conflict);
  return (
    item.inlineApprovable &&
    item.decisionMode !== 'resume-only' &&
    item.decisionMode !== 'claim-select' &&
    !hasEntityConflict
  );
}

export function countApprovalFeatures(
  items?: ReadonlyArray<{ sourceFeatureId: ApprovalProducerId }>,
): Partial<Record<ApprovalProducerId, number>> {
  const counts: Partial<Record<ApprovalProducerId, number>> = {};
  for (const featureId of APPROVAL_FEATURE_IDS) counts[featureId] = 0;
  for (const item of items ?? []) counts[item.sourceFeatureId] = (counts[item.sourceFeatureId] ?? 0) + 1;
  return counts;
}
