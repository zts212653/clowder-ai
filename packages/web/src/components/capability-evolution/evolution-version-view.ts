import {
  type EvolutionResolvedAssetReviewV1,
  type ExactAssetVersionRefV1,
  exactAssetVersionRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import type { EvolutionProgramProjection } from './evolution-program-projection';

export interface EvolutionVersionView {
  ref: ExactAssetVersionRefV1;
  sourceCurrent: boolean;
  adopted: boolean;
  parents: ExactAssetVersionRefV1[];
}

function exactVersionKeys(refs: EvolutionProgramProjection['program']['currentAssetVersionRefs']): Set<string> {
  const keys = new Set<string>();
  for (const ref of refs) {
    const exact = exactAssetVersionRefV1Schema.safeParse(ref);
    if (exact.success) keys.add(refIdentity(exact.data));
  }
  return keys;
}

export function projectAssetVersions(
  projection: EvolutionProgramProjection,
  review?: EvolutionResolvedAssetReviewV1,
): EvolutionVersionView[] {
  const versions = new Map<string, EvolutionVersionView>();
  const sourceCurrent = new Set(review?.currentVersionRefs.map(refIdentity) ?? []);
  const adopted = exactVersionKeys(projection.program.currentAssetVersionRefs);
  const add = (ref: ExactAssetVersionRefV1) => {
    const key = refIdentity(ref);
    let version = versions.get(key);
    if (!version) {
      version = { ref, sourceCurrent: sourceCurrent.has(key), adopted: adopted.has(key), parents: [] };
      versions.set(key, version);
    }
    return version;
  };
  // Execution records make versions discoverable, but do not establish parenthood or Program adoption.
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
  return (
    versions.find((version) => version.sourceCurrent) ?? versions.find((version) => version.adopted) ?? versions.at(-1)
  );
}

/** A fresh owner catalog can precede the selected read; never relabel an older comparison as its new source-current. */
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
