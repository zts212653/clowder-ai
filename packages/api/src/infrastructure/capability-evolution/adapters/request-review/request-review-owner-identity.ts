import type { ExactAssetVersionRefV1 } from '@cat-cafe/shared';

export const REQUEST_REVIEW_OWNER_FEATURE_ID = 'F100';
export const REQUEST_REVIEW_EVOLUTION_PROGRAM_ID = 'evolution-program:ba0f4524e49cc879279164d5b272cf8c';
export const REQUEST_REVIEW_TARGET_STATE_REF = 'capability:development-process-harness-effectiveness';
export const REQUEST_REVIEW_ASSET_KIND = 'skill' as const;
export const REQUEST_REVIEW_ASSET_ID = 'cat-cafe-skills/request-review/SKILL.md';
export const REQUEST_REVIEW_SKILL_FILE = REQUEST_REVIEW_ASSET_ID;
export const REQUEST_REVIEW_LOCAL_REVIEW_CONSUMER_REF = {
  ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
  ownerStateRef: 'consumer:request-review-local-review-v1',
} as const;

export function requestReviewAssetVersionRef(version: string): ExactAssetVersionRefV1 {
  return {
    ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
    ownerStateRef: `skill:${REQUEST_REVIEW_ASSET_ID}`,
    version,
    assetKind: REQUEST_REVIEW_ASSET_KIND,
    assetId: REQUEST_REVIEW_ASSET_ID,
  };
}

export function isRequestReviewAssetVersionRef(ref: ExactAssetVersionRefV1): boolean {
  return (
    ref.ownerFeatureId === REQUEST_REVIEW_OWNER_FEATURE_ID &&
    ref.ownerStateRef === `skill:${REQUEST_REVIEW_ASSET_ID}` &&
    ref.assetKind === REQUEST_REVIEW_ASSET_KIND &&
    ref.assetId === REQUEST_REVIEW_ASSET_ID &&
    /^[a-f0-9]{64}$/u.test(ref.version)
  );
}
