import { projectDisplayName } from '@/components/ThreadSidebar/thread-utils';

export interface HomeProject<T> {
  path: string;
  label: string;
  items: T[];
  oldest: number;
}

/** Preserve the caller's row order, sort groups by their oldest work, and disambiguate basename collisions. */
export function groupHomeProjects<T>(
  items: readonly T[],
  current: string | null,
  pathOf: (item: T) => string,
  startedAt: (item: T) => number,
  unavailable: readonly string[] = [],
): HomeProject<T>[] {
  const groups = new Map<string, HomeProject<T>>();
  for (const item of items) {
    const path = pathOf(item);
    const group = groups.get(path) ?? { path, label: projectDisplayName(path), items: [], oldest: Infinity };
    group.items.push(item);
    group.oldest = Math.min(group.oldest, startedAt(item));
    groups.set(path, group);
  }
  for (const path of unavailable)
    if (!groups.has(path)) groups.set(path, { path, label: projectDisplayName(path), items: [], oldest: Infinity });
  const rows = [...groups.values()];
  disambiguateProjectLabels(rows);
  return rows.sort((a, b) => {
    if (a.path === 'default' || b.path === 'default') return a.path === b.path ? 0 : a.path === 'default' ? 1 : -1;
    if (a.path === current || b.path === current) return a.path === current ? -1 : 1;
    return a.oldest - b.oldest || a.path.localeCompare(b.path);
  });
}

/** Pick the shortest unique directory suffix; an exhausted path retains its full root. */
function disambiguateProjectLabels<T>(groups: HomeProject<T>[]): void {
  const paths = groups.map((group) => ({ group, parts: group.path.split(/[\\/]/).filter(Boolean) }));
  const suffix = (parts: readonly string[], depth: number) => parts.slice(-depth).join('/');
  for (const { group, parts } of paths) {
    if (group.path === 'default') continue;
    const peers = paths.filter(
      ({ group: other }) =>
        other.path !== group.path &&
        other.path !== 'default' &&
        projectDisplayName(other.path) === projectDisplayName(group.path),
    );
    if (peers.length === 0) continue;
    let depth = 2;
    while (depth <= parts.length && peers.some((other) => suffix(other.parts, depth) === suffix(parts, depth)))
      depth += 1;
    group.label = depth <= parts.length ? suffix(parts, depth) : group.path;
  }
}
