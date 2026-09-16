import type { EvolutionResolvedExplorationReviewV1 } from '@cat-cafe/shared';
import { assetReviewFixture } from './evolution-asset-fixtures';

/** Legacy owner sentinel: versions exist, but no behaviour experiments are published. */
export function ownerExplorationFixture(current = 'v2'): EvolutionResolvedExplorationReviewV1 {
  const catalog = assetReviewFixture(current, current);
  return {
    schemaVersion: 1,
    status: 'resolved',
    programRef: catalog.programRef,
    objectRef: catalog.objectRef,
    sourceRef: catalog.sourceRef,
    readAt: catalog.readAt,
    blockers: [],
    experiments: [],
    details: [],
    nodes: catalog.versions.map((entry) => ({
      kind: 'owner_version',
      nodeRef: entry.versionRef,
      versionRef: entry.versionRef,
      title: entry.title!,
      summary: '此版本尚无已发布的实验。',
      sourceRef: catalog.sourceRef,
      changes: [],
      parentEdges: entry.parentEdges.map((edge) => ({
        parentNodeRef: edge.parentVersionRef,
        sourceRef: edge.edgeRef,
      })),
    })),
  };
}
