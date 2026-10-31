import type { EvolutionExplorationNodeV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import { ARCHIVE_SOURCE_REPOSITORY_URL } from '../archive-source-repository.js';
import type {
  RequestReviewHarnessLineageIndex,
  RequestReviewHarnessLineageIndexLegacy,
} from './request-review-harness-lineage-schema.js';

type Story = NonNullable<RequestReviewHarnessLineageIndexLegacy['story']>;
type Case = RequestReviewHarnessLineageIndexLegacy['cases'][number];
export const harnessStorySourceRef = (index: RequestReviewHarnessLineageIndex, id: string): OwnerTruthRefV1 => ({
  ownerFeatureId: 'F314',
  ownerStateRef: `harness-history:story-source:${id}`,
  version: index.snapshotCommit,
});

export const harnessStoryNodeRef = (
  index: RequestReviewHarnessLineageIndex,
  id: string,
  version?: string,
): OwnerTruthRefV1 => ({
  ownerFeatureId: 'F314',
  ownerStateRef: `harness-history:story:${id}`,
  version: version ?? index.snapshotCommit,
});

export function harnessStorySource(index: RequestReviewHarnessLineageIndex, id: string) {
  const entry = index.story?.sources.find((value) => value.id === id);
  if (!entry) throw new Error('validated story source disappeared');
  return {
    label: entry.label,
    ref: harnessStorySourceRef(index, id),
    href: `${ARCHIVE_SOURCE_REPOSITORY_URL}/blob/${index.snapshotCommit}/${entry.path}`,
  };
}

export function storyCaseNarrative(index: RequestReviewHarnessLineageIndexLegacy, entry: Case) {
  return index.story?.cases.find((value) => value.caseId === entry.caseId);
}

export function storyCaseSources(index: RequestReviewHarnessLineageIndexLegacy, entry: Case) {
  return storyCaseNarrative(index, entry)?.sourceIds.map((id) => harnessStorySource(index, id)) ?? [];
}

export function projectHarnessStoryNodes(
  index: RequestReviewHarnessLineageIndexLegacy,
  story: Story,
  publicationRef?: OwnerTruthRefV1,
): EvolutionExplorationNodeV1[] {
  return story.nodes.map((node) => ({
    kind: 'public_archive',
    nodeRef: harnessStoryNodeRef(index, node.id, publicationRef?.version),
    title: node.title,
    summary: node.summary,
    history: { period: node.when, updatedThrough: story.updated },
    sourceRef: publicationRef ?? harnessStorySourceRef(index, 'evolution-story'),
    changes: node.changes.map((change) => ({
      label: change.label,
      detail: change.detail,
      sourceRef: harnessStorySourceRef(index, change.sourceId),
      ownerHref: harnessStorySource(index, change.sourceId).href,
    })),
    parentEdges: node.parents.map((parent) => ({
      parentNodeRef: harnessStoryNodeRef(index, parent.nodeId, publicationRef?.version),
      description: parent.reason,
      sourceRef: harnessStorySourceRef(index, parent.sourceId),
    })),
  }));
}
