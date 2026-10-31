import type { ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { contentReviewCapabilities } from '@/components/workbench/content-review/content-review-capabilities';
import type {
  ContentLandingCapabilities,
  ContentReviewView,
} from '@/components/workbench/content-review/content-review-contract';

/** Ephemeral presentation only. All writes and receipts retain the original review and round IDs. */
export function artifactReviewProjection(view: ArtifactReviewView, round: ArtifactReviewRound): ContentReviewView {
  const { media, mediaType, ...publication } = round.asset;
  const source = {
    kind: 'publication' as const,
    revision: round.asset.blobDigest,
    mime: mediaType,
    media,
    publication,
  };
  const historical = round.number !== view.review.rounds.at(-1)?.number;
  return {
    review: {
      reviewId: view.review.reviewId,
      ownerUserId: view.review.task.ownerUserId,
      contentRef: view.review.contentRef,
      source,
      revision: view.review.revision,
      annotations: round.annotations.map((annotation) => ({
        ...annotation,
        anchor: { baseRevision: source.revision, anchor: annotation.anchor },
      })),
      visualMarks: round.visualMarks?.map((mark) => ({ ...mark, baseRevision: source.revision })),
    },
    currentSource: source,
    sourceState: 'current',
    canWrite: view.authority.canWrite && !historical && round.state !== 'approved',
    canReply: view.authority.canWrite,
    historyReadOnly: historical,
    annotationResolutions: round.annotations.map((annotation) => ({ annotationId: annotation.id, status: 'attached' })),
    visualMarkResolutions: round.visualMarks?.map((mark) => ({ markId: mark.drawing.id, status: 'attached' })) ?? [],
  };
}
export function artifactLandingCapabilities(
  view: ArtifactReviewView,
  round: ArtifactReviewRound,
): ContentLandingCapabilities {
  const result = contentReviewCapabilities(artifactReviewProjection(view, round));
  return {
    ...result,
    decide:
      view.authority.canWrite && !result.historyReadOnly
        ? { state: 'available' }
        : { state: 'read_only', reason: '原任务或历史版本当前不可裁决。' },
    versions: { state: 'available' },
  };
}
