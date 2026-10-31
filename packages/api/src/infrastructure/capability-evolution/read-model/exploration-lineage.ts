import { type EvolutionExplorationNodeV1, evolutionExplorationNodeSchema, refIdentity } from '@cat-cafe/shared';

/** Keep complete independent components without inventing roots or rewriting an owner's parent edges. */
export function retainPublishedExplorationNodes(nodes: EvolutionExplorationNodeV1[]): EvolutionExplorationNodeV1[] {
  const valid = nodes.flatMap((node) => {
    const parsed = evolutionExplorationNodeSchema.safeParse(node);
    return parsed.success ? [parsed.data] : [];
  });
  const counts = new Map<string, number>();
  for (const node of valid) {
    const key = refIdentity(node.nodeRef);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const candidates = new Map(
    valid
      .filter(
        (node) =>
          counts.get(refIdentity(node.nodeRef)) === 1 &&
          (node.kind !== 'owner_version' || refIdentity(node.nodeRef) === refIdentity(node.versionRef)),
      )
      .map((node) => [refIdentity(node.nodeRef), node]),
  );
  const states = new Map<string, 'visiting' | 'retained' | 'withheld'>();
  const canPublish = (key: string): boolean => {
    const state = states.get(key);
    if (state) return state === 'retained';
    const node = candidates.get(key);
    if (!node) return false;
    states.set(key, 'visiting');
    const complete = node.parentEdges.every((edge) => canPublish(refIdentity(edge.parentNodeRef)));
    states.set(key, complete ? 'retained' : 'withheld');
    return complete;
  };
  return valid.filter((node) => canPublish(refIdentity(node.nodeRef)));
}
