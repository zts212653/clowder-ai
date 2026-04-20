/**
 * F166: Sort cats — catOrder ids first (in that order), then remaining cats in original order.
 * Pure; silently drops catOrder ids that don't exist in `cats`.
 */
export function sortCatsByOrder<T extends { id: string }>(cats: T[], catOrder: string[]): T[] {
  if (catOrder.length === 0) return cats;
  const byId = new Map(cats.map((c) => [c.id, c]));
  const pinned: T[] = [];
  const pinnedIds = new Set<string>();
  for (const id of catOrder) {
    if (pinnedIds.has(id)) continue;
    const cat = byId.get(id);
    if (cat) {
      pinned.push(cat);
      pinnedIds.add(id);
    }
  }
  const rest = cats.filter((c) => !pinnedIds.has(c.id));
  return [...pinned, ...rest];
}
