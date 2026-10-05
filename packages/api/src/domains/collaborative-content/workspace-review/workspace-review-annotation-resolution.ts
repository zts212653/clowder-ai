import type {
  WorkspaceContentAnnotationResolution,
  WorkspaceContentReview,
  WorkspaceContentSource,
  WorkspaceContentVisualMarkResolution,
} from '@cat-cafe/shared';
import { isWorkspaceTextAnchor } from './workspace-review-anchors.js';

type BatchResolution = {
  readonly annotationId: string;
  readonly status: 'attached' | 'ambiguous' | 'orphaned';
};

/** Pure F309 projection: F063 has already supplied the single source snapshot and batch evidence. */
export function resolveTextWorkspaceReviewAnnotations(
  review: WorkspaceContentReview,
  source: WorkspaceContentSource,
  batchResolutions: readonly BatchResolution[],
): WorkspaceContentAnnotationResolution[] {
  const resolutionsById = new Map(batchResolutions.map((resolution) => [resolution.annotationId, resolution]));
  return review.annotations.map((annotation) => {
    if (!isWorkspaceTextAnchor(annotation.anchor)) return { annotationId: annotation.id, status: 'orphaned' };
    if (annotation.anchor.baseRevision === source.revision) return { annotationId: annotation.id, status: 'attached' };
    const resolution = resolutionsById.get(annotation.id);
    return {
      annotationId: annotation.id,
      status: resolution?.status === 'attached' ? 'moved' : (resolution?.status ?? 'orphaned'),
    };
  });
}

export function resolveMediaWorkspaceReviewAnnotations(
  review: WorkspaceContentReview,
  source: WorkspaceContentSource,
): WorkspaceContentAnnotationResolution[] {
  return review.annotations.map((annotation) => ({
    annotationId: annotation.id,
    status: annotation.anchor.baseRevision === source.revision ? 'attached' : 'orphaned',
  }));
}

/** A mark has no transform proof across owner revisions, so it never silently moves. */
export function resolveWorkspaceReviewVisualMarks(
  review: WorkspaceContentReview,
  source: WorkspaceContentSource | undefined,
): WorkspaceContentVisualMarkResolution[] {
  return (review.visualMarks ?? []).map((mark) => ({
    markId: mark.drawing.id,
    status: source && source.kind !== 'text' && mark.baseRevision === source.revision ? 'attached' : 'orphaned',
  }));
}
