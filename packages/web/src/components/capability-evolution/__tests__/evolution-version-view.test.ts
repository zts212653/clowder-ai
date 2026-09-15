import { type EvolutionResolvedAssetReviewV1, refIdentity } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import type { EvolutionChangeLineage } from '../evolution-lineage';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import {
  currentVersionDiff,
  hasAssetBranch,
  projectAssetVersions,
  selectedAssetVersion,
} from '../evolution-version-view';
import { assetReviewFixture } from './evolution-asset-fixtures';
import { assetRef, ownerRef, programFixture } from './evolution-fixtures';

const change = (from: string, to: string): EvolutionChangeLineage => ({
  caseRef: ownerRef(`case-${to}`),
  proposalRef: ownerRef(`proposal-${to}`),
  ownerAuthorizationRef: ownerRef('authorization'),
  targetVersionRef: assetRef(from),
  assetVersionRef: assetRef(to),
  status: 'changed',
  interventionKind: 'changed',
  interventionReceiptRef: ownerRef(`receipt-${to}`),
  loadedRuntimeRef: ownerRef(`loaded-${to}`),
});
const withChanges = (changes: EvolutionChangeLineage[]): EvolutionProgramProjection => ({
  ...programFixture(),
  lineage: { cycles: changes.map((value, index) => ({ cycle: index + 1, changes: [value] })) },
});
const review = (edges: Array<[string, string]>, current = 'v1'): EvolutionResolvedAssetReviewV1 => ({
  schemaVersion: 1,
  status: 'resolved',
  programRef: ownerRef('program'),
  objectRef: ownerRef('object'),
  sourceRef: ownerRef('review'),
  readAt: '2026-09-05T00:00:00.000Z',
  currentVersionRefs: [assetRef(current)],
  currentProofRef: ownerRef('current'),
  blockers: [],
  versions: [...new Set(['v1', ...edges.flat()])].map((version) => ({
    versionRef: assetRef(version),
    parentEdges: edges
      .filter(([, child]) => child === version)
      .map(([parent]) => ({ parentVersionRef: assetRef(parent), edgeRef: ownerRef(`edge-${parent}-${version}`) })),
  })),
});

describe('asset history is independent of program cycle order and reading state', () => {
  it('keeps a Program snapshot separate from a fresh owner current version', () => {
    expect(projectAssetVersions(programFixture())[0]?.current).toBe(false);
    expect(projectAssetVersions(programFixture(), review([]))[0]?.current).toBe(true);
  });
  it('creates edges only from owner-issued derivation proof and detects a real sibling branch', () => {
    const versions = projectAssetVersions(
      withChanges([change('v1', 'v2'), change('v1', 'v3')]),
      review([
        ['v1', 'v2'],
        ['v1', 'v3'],
      ]),
    );
    expect(versions.map((item) => [item.ref.version, item.parents.map((parent) => parent.version)])).toEqual([
      ['v1', []],
      ['v2', ['v1']],
      ['v3', ['v1']],
    ]);
    expect(hasAssetBranch(versions)).toBe(true);
    expect(
      hasAssetBranch(
        projectAssetVersions(
          withChanges([change('v1', 'v2'), change('v2', 'v3')]),
          review([
            ['v1', 'v2'],
            ['v2', 'v3'],
          ]),
        ),
      ),
    ).toBe(false);
    expect(hasAssetBranch(projectAssetVersions(withChanges([change('v1', 'v2'), change('v1', 'v3')])))).toBe(false);
  });
  it('does not turn a decision, evidence ref or pending candidate into a new asset version', () => {
    const pending: EvolutionChangeLineage = {
      ...change('v1', 'v2'),
      status: 'pending',
      assetVersionRef: undefined,
      interventionReceiptRef: undefined,
      interventionKind: undefined,
      loadedRuntimeRef: undefined,
    };
    expect(projectAssetVersions(withChanges([pending]))).toHaveLength(1);
    expect(hasAssetBranch(projectAssetVersions(withChanges([pending, pending])))).toBe(false);
  });
  it('preserves the selected historical version when the owner adopts another version', () => {
    const projection = withChanges([change('v1', 'v2')]);
    projection.program.currentAssetVersionRefs = [assetRef('v2')];
    const versions = projectAssetVersions(projection, review([['v1', 'v2']], 'v2'));
    expect(selectedAssetVersion(versions, refIdentity(assetRef('v1')))?.ref.version).toBe('v1');
    expect(versions.find((item) => item.current)?.ref.version).toBe('v2');
  });
  it('keeps an unavailable exact deep link unresolved rather than selecting a different version', () => {
    expect(
      selectedAssetVersion(projectAssetVersions(programFixture()), refIdentity(assetRef('missing'))),
    ).toBeUndefined();
  });
  it('withholds an older comparison when adoption changes before the selected read catches up', () => {
    const selected = assetReviewFixture('v1', 'v2').selected;
    expect(currentVersionDiff(selected, assetReviewFixture('v1', 'v2'))?.comparedToVersionRef.version).toBe('v2');
    expect(currentVersionDiff(selected, assetReviewFixture('v1', 'v3'))).toBeUndefined();
    expect(
      currentVersionDiff(assetReviewFixture('v1', 'v3').selected, assetReviewFixture('v1', 'v3'))?.comparedToVersionRef
        .version,
    ).toBe('v3');
  });
  it('never connects assets from different owners or asset identities', () => {
    const alien = { ...change('v1', 'v2'), assetVersionRef: assetRef('v2', 'another-method') };
    const versions = projectAssetVersions(withChanges([alien]));
    expect(versions.every((version) => version.parents.length === 0)).toBe(true);
  });
});
