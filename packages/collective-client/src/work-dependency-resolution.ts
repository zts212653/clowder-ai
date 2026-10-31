import type { CollectiveWorkProjection } from './client-types.js';

/** Resolve only from the Works already authorized in the caller's projection. */
export function resolveWorkDependencies(
  work: CollectiveWorkProjection,
  availableWorks: readonly CollectiveWorkProjection[],
): {
  readonly resolved: readonly CollectiveWorkProjection[];
  readonly unresolvedCount: number;
} {
  const byId = new Map(availableWorks.map((candidate) => [candidate.workId, candidate]));
  const resolved: CollectiveWorkProjection[] = [];
  let unresolvedCount = 0;
  for (const dependencyWorkId of work.dependencyWorkIds) {
    const dependency = byId.get(dependencyWorkId);
    if (dependency) resolved.push(dependency);
    else unresolvedCount += 1;
  }
  return { resolved, unresolvedCount };
}

export function unreadableDependencyLabel(count: number): string {
  return `${count} 项前置任务当前不可读`;
}
