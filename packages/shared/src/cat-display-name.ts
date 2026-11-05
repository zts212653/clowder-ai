export interface CatDisplayNameData {
  readonly displayName: string;
  readonly nickname?: string;
  readonly variantLabel?: string;
}

const compactLabel = (text: string) => text.replace(/[\s·・]/g, '').toLowerCase();

/**
 * Label for the always-on teammate roster (L0 compiler and SystemPromptBuilder).
 * You and the cats address each other by nickname, so the nickname stays next to
 * a variant label; otherwise "烁烁" cannot be resolved from the roster. It is left
 * out when the label already carries it (e.g. "俄罗斯蓝猫 鲸鲸"), or when the same
 * roster shows the family's own row with that name (`familyLabels`, e.g. "暹罗猫/烁烁").
 */
export function formatRosterLabel(cat: CatDisplayNameData, familyLabels?: ReadonlySet<string>): string {
  const variantLabel = cat.variantLabel?.trim();
  const base = variantLabel ? `${cat.displayName} ${variantLabel}` : cat.displayName;
  const nickname = cat.nickname?.trim();
  if (!nickname || compactLabel(base).includes(compactLabel(nickname))) return base;
  const familyLabel = `${cat.displayName}/${nickname}`;
  return variantLabel && familyLabels?.has(familyLabel) ? base : `${base}/${nickname}`;
}

/** Family rows ("暹罗猫/烁烁") a roster already shows, so its variants need not repeat the name. */
export function collectRosterFamilyLabels(cats: Iterable<CatDisplayNameData>): Set<string> {
  const labels = new Set<string>();
  for (const cat of cats) {
    if (!cat.variantLabel?.trim()) labels.add(formatRosterLabel(cat));
  }
  return labels;
}

/** Format one runtime member consistently across API and Web human-facing surfaces. */
export function formatCatDisplayName(cat: CatDisplayNameData): string {
  const displayName = cat.displayName.trim();
  const variantLabel = cat.variantLabel?.trim();
  if (!variantLabel || displayName.toLowerCase().includes(variantLabel.toLowerCase())) return displayName;
  return `${displayName}（${variantLabel}）`;
}
