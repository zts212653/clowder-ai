import type { A2ARoutingProjection, CatConfig, CatId } from '@cat-cafe/shared';

type HandoffCatConfig = Pick<CatConfig, 'displayName' | 'variantLabel'>;

export function formatA2AHandoffCatLabel(catId: CatId | string, config?: HandoffCatConfig): string {
  const displayName = config?.displayName?.trim() || catId;
  const qualifier = config?.variantLabel?.trim() || (displayName !== catId ? catId : '');
  return qualifier ? `${displayName}(${qualifier})` : displayName;
}

function handoffArrow(projection: A2ARoutingProjection | undefined): string {
  if (!projection || projection.total <= 1) return '→';
  return '⇉';
}

function handoffSuffix(projection: A2ARoutingProjection | undefined): string {
  if (!projection || projection.total <= 1) return '';
  return `（并行 ${projection.index}/${projection.total}）`;
}

export function formatA2AHandoffContent(
  fromCatId: CatId | string,
  toCatId: CatId | string,
  fromConfig?: HandoffCatConfig,
  toConfig?: HandoffCatConfig,
  projection?: A2ARoutingProjection,
): string {
  const from = formatA2AHandoffCatLabel(fromCatId, fromConfig);
  const to = formatA2AHandoffCatLabel(toCatId, toConfig);
  return `${from} ${handoffArrow(projection)} ${to}${handoffSuffix(projection)}`;
}
