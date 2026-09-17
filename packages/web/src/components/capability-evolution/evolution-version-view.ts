import {
  type EvolutionResolvedAssetReviewV1,
  type ExactAssetVersionRefV1,
  exactAssetVersionRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import type { EvolutionProgramProjection } from './evolution-program-projection';

export interface EvolutionVersionView {
  ref: ExactAssetVersionRefV1;
  current: boolean;
  parents: ExactAssetVersionRefV1[];
}
export function projectAssetVersions(
  projection: EvolutionProgramProjection,
  review?: EvolutionResolvedAssetReviewV1,
): EvolutionVersionView[] {
  const versions = new Map<string, EvolutionVersionView>();
  const current = new Set(review?.currentVersionRefs.map(refIdentity) ?? []);
  const add = (ref: ExactAssetVersionRefV1) => {
    const key = refIdentity(ref);
    let version = versions.get(key);
    if (!version) {
      version = { ref, current: current.has(key), parents: [] };
      versions.set(key, version);
    }
    return version;
  };
  // Execution records make versions discoverable, but do not establish parenthood or live adoption.
  for (const cycle of projection.lineage?.cycles ?? []) {
    for (const change of cycle.changes) {
      add(change.targetVersionRef);
      if (!change.assetVersionRef || !change.interventionReceiptRef) continue;
      add(change.assetVersionRef);
    }
    if (cycle.decisionAssetVersionRef && cycle.executionReceiptRef) add(cycle.decisionAssetVersionRef);
  }
  for (const ref of projection.program.currentAssetVersionRefs) {
    const exact = exactAssetVersionRefV1Schema.safeParse(ref);
    if (exact.success) add(exact.data);
  }
  for (const version of review?.versions ?? []) {
    const entry = add(version.versionRef);
    entry.parents = version.parentEdges.map((edge) => edge.parentVersionRef);
    for (const parent of entry.parents) add(parent);
  }
  return [...versions.values()];
}
export function hasAssetBranch(versions: EvolutionVersionView[]): boolean {
  const children = new Map<string, Set<string>>();
  for (const version of versions)
    for (const parent of version.parents) {
      const key = refIdentity(parent);
      const refs = children.get(key) ?? new Set<string>();
      refs.add(refIdentity(version.ref));
      if (refs.size > 1) return true;
      children.set(key, refs);
    }
  return false;
}
export function selectedAssetVersion(
  versions: EvolutionVersionView[],
  selectedKey?: string,
): EvolutionVersionView | undefined {
  if (selectedKey !== undefined) return versions.find((version) => refIdentity(version.ref) === selectedKey);
  return versions.find((version) => version.current) ?? versions.at(-1);
}

/** A fresh catalog can precede the selected read; never relabel an older comparison as the new current. */
export function currentVersionDiff(
  selected: EvolutionResolvedAssetReviewV1['selected'],
  catalog?: EvolutionResolvedAssetReviewV1,
) {
  const diff = selected?.diff;
  return diff?.status === 'available' &&
    catalog?.currentVersionRefs.some((ref) => refIdentity(ref) === refIdentity(diff.comparedToVersionRef))
    ? diff
    : undefined;
}
