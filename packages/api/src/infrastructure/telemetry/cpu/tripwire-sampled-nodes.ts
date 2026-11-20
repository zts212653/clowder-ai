import type { Profiler } from 'node:inspector';
import { MAX_PROFILE_NODES, MAX_PROFILE_SAMPLES } from './main-thread-cpu-profile.js';

function profileGraph(nodes: Profiler.ProfileNode[]) {
  const byId = new Map<number, Profiler.ProfileNode>();
  const parents = new Map<number, number | null>();
  const duplicateIds = new Set<number>();
  for (const node of nodes) {
    if (byId.has(node.id)) duplicateIds.add(node.id);
    byId.set(node.id, node);
    for (const child of node.children ?? []) {
      const previous = parents.get(child);
      parents.set(child, previous === undefined || previous === node.id ? node.id : null);
    }
  }
  return { byId, parents, duplicateIds };
}

function sampledAncestry(id: number, graph: ReturnType<typeof profileGraph>, selected: Set<number>) {
  const path = new Set<number>();
  let at: number | undefined = id;
  while (at !== undefined && !selected.has(at)) {
    if (graph.duplicateIds.has(at) || !graph.byId.has(at) || path.has(at)) return;
    path.add(at);
    if (path.size + selected.size > MAX_PROFILE_NODES) return;
    const parent = graph.parents.get(at);
    if (parent === null) return;
    at = parent;
  }
  return path;
}

/** The interval already chose its samples. Retain their complete valid ancestor
 * chains, rather than spending the node budget on unrelated earlier V8 entries. */
export function selectTripwireNodes(nodes: Profiler.ProfileNode[], samples: number[]) {
  if (nodes.length <= MAX_PROFILE_NODES) return { nodes, omittedNodes: 0 };
  const graph = profileGraph(nodes);
  const selected = new Set<number>();
  for (const id of new Set(samples.slice(0, MAX_PROFILE_SAMPLES))) {
    const path = sampledAncestry(id, graph, selected);
    if (path) for (const ancestor of path) selected.add(ancestor);
  }
  const retained = nodes
    .filter((node) => selected.has(node.id))
    .map((node) => ({ ...node, children: node.children?.filter((id) => selected.has(id)) }));
  return { nodes: retained, omittedNodes: nodes.length - retained.length };
}
