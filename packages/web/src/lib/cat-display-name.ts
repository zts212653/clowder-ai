export interface CatDisplayNameData {
  displayName: string;
  variantLabel?: string;
}

export type GetCatDisplayNameData = (catId: string) => CatDisplayNameData | undefined;

/** Format one runtime member consistently across human-facing Console surfaces. */
export function formatCatDisplayName(cat: CatDisplayNameData): string {
  return cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName;
}

/** Resolve a stable catId to a friendly label, retaining the id as the unknown-member fallback. */
export function resolveCatDisplayName(catId: string, getCatById: GetCatDisplayNameData): string {
  const cat = getCatById(catId);
  return cat ? formatCatDisplayName(cat) : catId;
}

/** Keep the stable id visible as secondary provenance on diagnostic/observability surfaces. */
export function resolveCatTechnicalLabel(catId: string, getCatById: GetCatDisplayNameData): string {
  const displayName = resolveCatDisplayName(catId, getCatById);
  return displayName === catId ? catId : `${displayName} · ${catId}`;
}
