import type { EvolutionExplorationNodeV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { RequestReviewHarnessLineageIndexV3 } from './request-review-harness-lineage-schema.js';
import { harnessStoryNodeRef, harnessStorySource, harnessStorySourceRef } from './request-review-harness-story.js';

type Case = RequestReviewHarnessLineageIndexV3['cases'][number];

export function v3CaseNarrative(index: RequestReviewHarnessLineageIndexV3, entry: Case) {
  return index.story.cases.find((value) => value.caseId === entry.caseId);
}

export function v3CaseSources(index: RequestReviewHarnessLineageIndexV3, entry: Case) {
  return v3CaseNarrative(index, entry)?.sourceIds.map((id) => harnessStorySource(index, id)) ?? [];
}

export function projectHarnessStoryV3Nodes(
  index: RequestReviewHarnessLineageIndexV3,
  publicationRef?: OwnerTruthRefV1,
): EvolutionExplorationNodeV1[] {
  return index.story.steps.map((step) => ({
    kind: 'public_archive',
    nodeRef: harnessStoryNodeRef(index, step.stepId, publicationRef?.version),
    title: step.title,
    // Generic exploration consumers still require a short label; the history reader never
    // derives or displays an excerpt from the authored body.
    summary: step.title,
    bodyMarkdown: step.bodyMarkdown,
    history: { period: step.date, updatedThrough: index.story.updated },
    sourceRef: publicationRef ?? harnessStorySourceRef(index, 'evolution-story'),
    sources: step.sourceIds.map((id) => harnessStorySource(index, id)),
    changes: [],
    parentEdges: step.parentEdges.map((edge) => ({
      parentNodeRef: harnessStoryNodeRef(index, edge.parentStepId, publicationRef?.version),
      description: edge.reason,
      sourceRef: harnessStorySourceRef(index, edge.sourceId),
    })),
  }));
}
