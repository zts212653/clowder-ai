import { type CatDisplayNameData, formatCatDisplayName } from '@cat-cafe/shared';

export { formatCatDisplayName };
export type { CatDisplayNameData };

export type GetCatDisplayNameData = (catId: string) => CatDisplayNameData | undefined;

/** Resolve a stable catId to a friendly label, retaining the id as the unknown-member fallback. */
export function resolveCatDisplayName(catId: string, getCatById: GetCatDisplayNameData): string {
  const cat = getCatById(catId);
  return cat ? formatCatDisplayName(cat) : catId;
}

/** Chat names use the configured nickname; full display names remain available separately. */
export function formatCatNameplateName(cat: CatDisplayNameData): string {
  return cat.nickname?.trim() || formatCatDisplayName(cat);
}

/** Resolve the same chat name for reply receipts and execution status. */
export function resolveCatNameplateName(catId: string, getCatById: GetCatDisplayNameData): string {
  const cat = getCatById(catId);
  return cat ? formatCatNameplateName(cat) : catId;
}

/** Keep the stable id visible as secondary provenance on diagnostic/observability surfaces. */
export function resolveCatTechnicalLabel(catId: string, getCatById: GetCatDisplayNameData): string {
  const displayName = resolveCatDisplayName(catId, getCatById);
  return displayName === catId ? catId : `${displayName} · ${catId}`;
}
