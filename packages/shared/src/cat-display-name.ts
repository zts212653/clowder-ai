export interface CatDisplayNameData {
  readonly displayName: string;
  readonly variantLabel?: string;
}

/** Format one runtime member consistently across API and Web human-facing surfaces. */
export function formatCatDisplayName(cat: CatDisplayNameData): string {
  const displayName = cat.displayName.trim();
  const variantLabel = cat.variantLabel?.trim();
  if (!variantLabel || displayName.toLowerCase().includes(variantLabel.toLowerCase())) return displayName;
  return `${displayName}（${variantLabel}）`;
}
