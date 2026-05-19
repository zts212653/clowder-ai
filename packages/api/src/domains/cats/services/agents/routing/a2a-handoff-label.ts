import type { CatConfig, CatId } from '@cat-cafe/shared';

type HandoffCatConfig = Pick<CatConfig, 'displayName' | 'variantLabel'>;

export function formatA2AHandoffCatLabel(catId: CatId | string, config?: HandoffCatConfig): string {
  const displayName = config?.displayName?.trim() || catId;
  const qualifier = config?.variantLabel?.trim() || (displayName !== catId ? catId : '');
  return qualifier ? `${displayName}(${qualifier})` : displayName;
}

export function formatA2AHandoffContent(
  fromCatId: CatId | string,
  toCatId: CatId | string,
  fromConfig?: HandoffCatConfig,
  toConfig?: HandoffCatConfig,
): string {
  return `${formatA2AHandoffCatLabel(fromCatId, fromConfig)} → ${formatA2AHandoffCatLabel(toCatId, toConfig)}`;
}
