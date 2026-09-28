import { type EvolutionExplorationNodeV1, refIdentity } from '@cat-cafe/shared';

export const LINEAGE_NODE_SIZE = { width: 176, height: 112 };

/** Topological, stable source order. Neither outcomes nor selection move a version into a better place. */
export function layoutExplorationLineage(nodes: EvolutionExplorationNodeV1[], collapsed: string[]) {
  const byKey = new Map(nodes.map((node) => [refIdentity(node.nodeRef), node]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const hidden = new Set<string>();
  const folded = new Set(collapsed);
  const level = (key: string): number => {
    if (levels.has(key)) return levels.get(key) ?? 0;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const parents = byKey.get(key)?.parentEdges.map((edge) => refIdentity(edge.parentNodeRef)) ?? [];
    const depth = parents.length ? Math.max(...parents.map(level)) + 1 : 0;
    if (parents.some((parent) => folded.has(parent) || hidden.has(parent))) hidden.add(key);
    visiting.delete(key);
    levels.set(key, depth);
    return depth;
  };
  for (const key of byKey.keys()) level(key);
  const rows = new Map<number, number>();
  const placed = nodes
    .filter((node) => !hidden.has(refIdentity(node.nodeRef)))
    .map((node) => {
      const key = refIdentity(node.nodeRef);
      const depth = levels.get(key) ?? 0;
      const row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      return {
        node,
        key,
        x: 24 + depth * (LINEAGE_NODE_SIZE.width + 32),
        y: 24 + row * (LINEAGE_NODE_SIZE.height + 32),
      };
    });
  return {
    nodes: placed,
    width: Math.max(240, ...placed.map((node) => node.x + LINEAGE_NODE_SIZE.width + 24)),
    height: Math.max(160, ...placed.map((node) => node.y + LINEAGE_NODE_SIZE.height + 24)),
    hiddenCount: hidden.size,
  };
}
