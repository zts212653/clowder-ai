/**
 * F232 Phase B — Cat filter logic for global artifacts.
 *
 * Pure functions: extract unique cat chips + filter by catId.
 * Design spec: docs/designs/F232-phase-b-design-spec.md §2.4
 */
import type { GlobalArtifactDTO } from '@cat-cafe/shared';

export interface CatChip {
  catId: string;
  label: string;
  count: number;
}

/**
 * Extract unique cats from artifacts, sorted by count descending (most prolific first).
 * Each chip has a stable `catId` key, resolved `label` (nickname or fallback to catId),
 * and the artifact count for that cat.
 */
export function extractCatChips(
  artifacts: GlobalArtifactDTO[],
  resolveNickname: (catId: string) => string | undefined,
): CatChip[] {
  if (artifacts.length === 0) return [];

  const counts = new Map<string, number>();
  for (const a of artifacts) {
    const id = a.catId ?? '—';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([catId, count]) => ({
      catId,
      label: (catId !== '—' ? resolveNickname(catId) : undefined) ?? catId,
      count,
    }));
}

/**
 * Filter artifacts by catId. Returns all if catId is null (no filter).
 * Uses the same null→'—' normalization as extractCatChips so that
 * clicking the '—' chip correctly matches null-catId artifacts.
 */
export function filterByCat(artifacts: GlobalArtifactDTO[], catId: string | null): GlobalArtifactDTO[] {
  if (catId === null) return artifacts;
  return artifacts.filter((a) => (a.catId ?? '—') === catId);
}
