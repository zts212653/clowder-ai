import type { CollectionGroup } from './interfaces.js';

export function redactGroupsForPersistence(groups: CollectionGroup[]): CollectionGroup[] {
  return groups.map((g) => {
    if (g.sensitivity === 'public' || g.sensitivity === 'internal') return g;
    return {
      ...g,
      items: g.items.map((item) => ({
        anchor: item.anchor,
        kind: item.kind,
        status: item.status,
        title: `[redacted — ${g.sensitivity} collection]`,
        updatedAt: item.updatedAt,
      })),
    };
  });
}
