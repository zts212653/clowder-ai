import type { EvolutionResolvedAssetReviewV1 } from '@cat-cafe/shared';
import { assetRef, ownerRef, PROGRAM_ID, programFixture } from './evolution-fixtures';

/** Contract fixture only: these refs do not assert a real owner outcome. */
export function assetReviewFixture(version = 'v1', current = 'v2'): EvolutionResolvedAssetReviewV1 {
  const selected = assetRef(version);
  return {
    schemaVersion: 1,
    status: 'resolved',
    programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
    objectRef: programFixture().program.objectRef,
    sourceRef: ownerRef('asset-review'),
    readAt: new Date().toISOString(),
    currentVersionRefs: [assetRef(current)],
    currentProofRef: ownerRef(`current-${current}`),
    versions: ['v1', 'v2', 'v3'].map((value) => ({
      versionRef: assetRef(value),
      title: value === 'v1' ? '最初采用' : value === 'v2' ? '补充边界示例' : '保留的另一个候选',
      parentEdges: value === 'v1' ? [] : [{ parentVersionRef: assetRef('v1'), edgeRef: ownerRef(`parent-${value}`) }],
    })),
    selected: {
      versionRef: selected,
      diff: {
        status: 'available',
        comparedToVersionRef: assetRef(current),
        summary: `${version} 的人话变化说明`,
        rawDiffRef: ownerRef(`diff-${version}`),
      },
      evidence: (
        ['comparison_baseline', 'candidate_independent_verification', 'post_adoption_observation'] as const
      ).map((role) => ({
        role,
        assetVersionRef: selected,
        evidenceRef: ownerRef(`${role}-${version}`),
        proofRef: ownerRef(`binding-${role}-${version}`),
        status: 'verified',
        label: `${version} ${role}`,
        ownerHref: `/evidence/${version}/${role}`,
      })),
      uses:
        version === 'v2'
          ? [
              {
                receiptRef: ownerRef('use-v2'),
                assetVersionRef: selected,
                invocationRef: { ownerFeatureId: 'F299', ownerStateRef: 'inv:later-task' },
                consumerRef: ownerRef('review-consumer'),
                use: 'applied',
                occurredAt: '2026-09-05T08:00:00.000Z',
              },
            ]
          : [],
    },
    blockers: [],
  };
}
