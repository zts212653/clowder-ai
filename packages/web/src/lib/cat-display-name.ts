import { type CatDisplayNameData, formatCatDisplayName } from '@cat-cafe/shared';

export { formatCatDisplayName };
export type { CatDisplayNameData };

export type GetCatDisplayNameData = (catId: string) => CatDisplayNameData | undefined;

/** Resolve a stable catId to a friendly label, retaining the id as the unknown-member fallback. */
export function resolveCatDisplayName(catId: string, getCatById: GetCatDisplayNameData): string {
  const cat = getCatById(catId);
  return cat ? formatCatDisplayName(cat) : catId;
}

/** Read the configured nameplate nickname and model from the same runtime member. */
export function resolveCatNameplateName(catId: string, getCatById: GetCatDisplayNameData): string {
  const cat = getCatById(catId);
  if (!cat) return catId;
  const name = cat.nickname?.trim() || cat.displayName;
  return cat.variantLabel ? `${name} · ${cat.variantLabel}` : name;
}

/** Keep the stable id visible as secondary provenance on diagnostic/observability surfaces. */
export function resolveCatTechnicalLabel(catId: string, getCatById: GetCatDisplayNameData): string {
  const displayName = resolveCatDisplayName(catId, getCatById);
  return displayName === catId ? catId : `${displayName} · ${catId}`;
}
